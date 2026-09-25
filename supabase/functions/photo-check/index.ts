// Hooky photo moderation. This is the ONLY code permitted to write
// profiles.photos / profiles.photo_url or to put files in the private
// `photos` storage bucket, which is why it runs with the service role and why
// the profiles trigger blocks clients from setting those columns themselves.
// Without that, a modified client could simply write a photo and skip
// moderation entirely.
//
// Requests (JSON, from a signed-in user):
//   { image: "data:image/jpeg;base64,..." }   add a photo (max four)
//   { remove: "<path>" }                        delete one photo
//   { remove: true }                            delete all (account deletion)
//   { main: "<path>" }                          make that photo the main one
// Every response carries the updated list: { ok, photos: [paths] }.
//
// A photo is accepted only if BOTH hold:
//   1. A nudity classifier (MobileNetV4, ~10MB, Apache 2.0) scores its porn
//      + hentai classes below the threshold. Anything above is rejected and
//      never stored. The earlier 83MB ViT blew the Edge runtime's memory
//      limit on every upload, so it was replaced; this one runs in ~50ms.
//   2. A face is detected (UltraFace, ~1.3MB). Profile photos are meant to be
//      of you, which also stops random images and screenshots.
//
// NOTE ON WHAT THIS DOES NOT DO: this is a nudity classifier, not CSAM
// detection. A production teen app also needs hash-matching against known
// material (PhotoDNA, or NCMEC's hash list) and a human review queue. Those
// require an account and a legal agreement, so they are not wired up here.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// 1.14: later builds ship only a threaded WASM binary, and the edge runtime has
// no SharedArrayBuffer. esm.sh also wraps this CJS package differently per
// target, hence the shape check.
import ortModule from "https://esm.sh/onnxruntime-web@1.14.0";
const ort: any = (ortModule as any)?.env ? (ortModule as any) : ((ortModule as any)?.default ?? ortModule);
import jpeg from "https://esm.sh/jpeg-js@0.4.4";

const NSFW_MODEL_URL = Deno.env.get("NSFW_MODEL_URL") ??
  "https://huggingface.co/taufiqdp/mobilenetv4_conv_small.e2400_r224_in1k_nsfw_classifier/resolve/main/mobilenetv4_conv_small.e2400_r224_in1k_nsfw_classifier.onnx";
const FACE_MODEL_URL = Deno.env.get("FACE_MODEL_URL") ??
  "https://huggingface.co/onnxmodelzoo/version-RFB-320/resolve/main/version-RFB-320.onnx";
// Deliberately below 0.5. This is a teen app, so an over-eager reject costs a
// retry while a miss costs a lot more.
const NSFW_LIMIT = Number(Deno.env.get("NSFW_LIMIT") ?? "0.35");
const MAX_PHOTOS = 4;
const BUCKET = "photos";

// supabase-js sends apikey and x-client-info as well as authorization. If the
// preflight doesn't allow all of them the browser silently drops the real
// request, which is exactly how photo uploads failed before this list grew.
const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

type Rgba = { data: Uint8Array; width: number; height: number };

function decodeDataUrl(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  try {
    const raw = atob(dataUrl.slice(comma + 1));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch { return null; }
}

function sample(img: Rgba, sx: number, sy: number, sw: number, sh: number, dw: number, dh: number) {
  const out = new Float32Array(dw * dh * 3);
  const { data, width: w, height: h } = img;
  for (let y = 0; y < dh; y++) {
    const fy0 = sy + (y + 0.5) * (sh / dh) - 0.5;
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(fy0)));
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, fy0 - y0));
    for (let x = 0; x < dw; x++) {
      const fx0 = sx + (x + 0.5) * (sw / dw) - 0.5;
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx0)));
      const x1 = Math.min(w - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, fx0 - x0));
      for (let c = 0; c < 3; c++) {
        const p00 = data[(y0 * w + x0) * 4 + c], p01 = data[(y0 * w + x1) * 4 + c];
        const p10 = data[(y1 * w + x0) * 4 + c], p11 = data[(y1 * w + x1) * 4 + c];
        const top = p00 + (p01 - p00) * fx, bot = p10 + (p11 - p10) * fx;
        out[(y * dw + x) * 3 + c] = top + (bot - top) * fy;
      }
    }
  }
  return out;
}

let nsfwSession: Promise<any> | null = null;
let faceSession: Promise<any> | null = null;
function configureOrt() {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = {
    "ort-wasm.wasm": "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/ort-wasm.wasm",
    "ort-wasm-simd.wasm": "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/ort-wasm-simd.wasm",
  };
}
function loadSession(url: string): Promise<any> {
  configureOrt();
  return (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`model download failed: ${res.status}`);
    return await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), { executionProviders: ["wasm"] });
  })();
}
function getNsfw() { if (!nsfwSession) nsfwSession = loadSession(NSFW_MODEL_URL).catch((e) => { nsfwSession = null; throw e; }); return nsfwSession; }
function getFace() { if (!faceSession) faceSession = loadSession(FACE_MODEL_URL).catch((e) => { faceSession = null; throw e; }); return faceSession; }

// MobileNetV4: one 224x224 image as [3, 224, 224] (no batch dimension),
// ImageNet mean/std. Labels: drawings, hentai, neutral, porn, sexy. The score
// is porn + hentai; "sexy" is ignored because it fires on ordinary party and
// beach photos (a group shot in club dresses scored 1.00).
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
async function nsfwScore(img: Rgba): Promise<number> {
  const S = 224;
  const rgb = sample(img, 0, 0, img.width, img.height, S, S);
  const input = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) {
    for (let c = 0; c < 3; c++) input[c * S * S + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  }
  const session = await getNsfw();
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", input, [3, S, S]) });
  const logits = Array.from(out[session.outputNames[0]].data as Float32Array);
  const m = Math.max(...logits);
  const exp = logits.map((v) => Math.exp(v - m));
  const sum = exp.reduce((a, b) => a + b, 0);
  return (exp[1] + exp[3]) / sum;
}

// UltraFace wants 320x240. Portrait photos are letterboxed into it rather
// than squashed, because a squashed face often stops looking like a face.
async function hasFace(img: Rgba): Promise<boolean> {
  const W = 320, H = 240;
  const scale = Math.min(W / img.width, H / img.height);
  const dw = Math.max(1, Math.round(img.width * scale)), dh = Math.max(1, Math.round(img.height * scale));
  const ox = Math.floor((W - dw) / 2), oy = Math.floor((H - dh) / 2);
  const rgb = sample(img, 0, 0, img.width, img.height, dw, dh);
  const input = new Float32Array(3 * W * H); // zeros are mid-grey padding
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const s = (y * dw + x) * 3, d = (y + oy) * W + (x + ox);
      input[d] = (rgb[s] - 127) / 128;
      input[W * H + d] = (rgb[s + 1] - 127) / 128;
      input[2 * W * H + d] = (rgb[s + 2] - 127) / 128;
    }
  }
  const session = await getFace();
  const out = await session.run({ input: new ort.Tensor("float32", input, [1, 3, H, W]) });
  const scores = out.scores.data as Float32Array;
  const n = out.scores.dims[1] as number;
  for (let i = 0; i < n; i++) if (scores[i * 2 + 1] >= 0.7) return true;
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const asUser = createClient(url, anon, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: auth, error: authErr } = await asUser.auth.getUser();
  if (authErr || !auth?.user) return json({ error: "not signed in" }, 401);
  const uid = auth.user.id;

  const admin = createClient(url, serviceRole);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad request body" }, 400); }

  const { data: prof } = await admin.from("profiles").select("photos").eq("id", uid).maybeSingle();
  if (!prof) return json({ error: "set up your profile first" }, 409);
  const current: string[] = prof.photos ?? [];
  // Keeps photo_url (the main photo, used by lists and avatars) in step.
  const save = async (photos: string[]) => {
    const { error } = await admin.from("profiles").update({
      photos, photo_url: photos[0] ?? null, photo_status: photos.length ? "approved" : "none",
    }).eq("id", uid);
    return error;
  };

  // Removing needs no moderation. `true` removes everything.
  if (body.remove) {
    const gone = body.remove === true ? current : current.filter((p) => p === body.remove);
    if (!gone.length) return json({ ok: true, photos: current });
    await admin.storage.from(BUCKET).remove(gone);
    const left = current.filter((p) => !gone.includes(p));
    const err = await save(left);
    if (err) return json({ error: err.message }, 500);
    return json({ ok: true, photos: left });
  }

  if (typeof body.main === "string") {
    if (!current.includes(body.main)) return json({ error: "that photo isn't yours" }, 400);
    const order = [body.main, ...current.filter((p) => p !== body.main)];
    const err = await save(order);
    if (err) return json({ error: err.message }, 500);
    return json({ ok: true, photos: order });
  }

  if (current.length >= MAX_PHOTOS) return json({ ok: false, reason: `You can have up to ${MAX_PHOTOS} photos. Remove one first.`, photos: current });

  const bytes = typeof body.image === "string" ? decodeDataUrl(body.image) : null;
  if (!bytes) return json({ error: "no image supplied" }, 400);
  if (bytes.length > 3_000_000) return json({ error: "that photo is too large" }, 413);

  let decoded: Rgba;
  try {
    const d = jpeg.decode(bytes, { useTArray: true });
    if (!d?.width) throw new Error("not a readable JPEG");
    decoded = { data: d.data as Uint8Array, width: d.width, height: d.height };
  } catch {
    return json({ error: "we couldn't read that image. JPEG photos work best." }, 400);
  }

  let score: number, face: boolean;
  try {
    score = await nsfwScore(decoded);
    face = score <= NSFW_LIMIT ? await hasFace(decoded) : false;
  } catch (e) {
    // A broken classifier must never wave a photo through.
    return json({ error: "photo checks are unavailable right now", detail: String((e as Error).message ?? e) }, 503);
  }

  // Rejected photos are never stored anywhere.
  if (score > NSFW_LIMIT) {
    return json({ ok: false, reason: "That photo doesn't meet the rules. Pick one you'd be happy showing anyone.", photos: current });
  }
  if (!face) {
    return json({ ok: false, reason: "We couldn't see a face. Your photos should be of you.", photos: current });
  }

  const path = `${uid}/${crypto.randomUUID()}.jpg`;
  const up = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: "image/jpeg", upsert: false });
  if (up.error) return json({ error: up.error.message }, 500);
  // Re-read so two uploads at once can't push past four (the table's CHECK
  // constraint is the final word; if it refuses, the file is removed again).
  const { data: fresh } = await admin.from("profiles").select("photos").eq("id", uid).maybeSingle();
  const photos = [...(fresh?.photos ?? current), path];
  const err = photos.length > MAX_PHOTOS ? new Error("too many photos") : await save(photos);
  if (err) {
    await admin.storage.from(BUCKET).remove([path]);
    return json({ ok: false, reason: `You can have up to ${MAX_PHOTOS} photos.`, photos: fresh?.photos ?? current });
  }
  return json({ ok: true, photos, added: path });
});
