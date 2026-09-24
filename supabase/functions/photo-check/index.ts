// Hooky photo moderation. This is the ONLY code permitted to write
// profiles.photo_url, which is why it runs with the service role and why the
// profiles trigger blocks clients from setting that column themselves.
// Without that, a modified client could simply write a photo URL and skip
// moderation entirely.
//
// A photo is accepted only if BOTH hold:
//   1. A nudity classifier (ViT, quantized, ~83MB) scores it below the
//      threshold. Anything above is rejected and never stored.
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
  "https://huggingface.co/onnx-community/nsfw_image_detection-ONNX/resolve/main/onnx/model_quantized.onnx";
const FACE_MODEL_URL = Deno.env.get("FACE_MODEL_URL") ??
  "https://huggingface.co/onnxmodelzoo/version-RFB-320/resolve/main/version-RFB-320.onnx";
// Deliberately below 0.5. This is a teen app, so an over-eager reject costs a
// retry while a miss costs a lot more.
const NSFW_LIMIT = Number(Deno.env.get("NSFW_LIMIT") ?? "0.35");

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
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

// ViT: 224x224, scaled to 0..1 then normalised with mean and std of 0.5.
// Labels are index 0 "normal", index 1 "nsfw".
async function nsfwScore(img: Rgba): Promise<number> {
  const S = 224;
  const rgb = sample(img, 0, 0, img.width, img.height, S, S);
  const input = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) {
    input[i] = (rgb[i * 3] / 255 - 0.5) / 0.5;
    input[S * S + i] = (rgb[i * 3 + 1] / 255 - 0.5) / 0.5;
    input[2 * S * S + i] = (rgb[i * 3 + 2] / 255 - 0.5) / 0.5;
  }
  const session = await getNsfw();
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, S, S]) });
  const logits = Array.from(out[session.outputNames[0]].data as Float32Array);
  const m = Math.max(...logits);
  const exp = logits.map((v) => Math.exp(v - m));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp[1] / sum;
}

async function hasFace(img: Rgba): Promise<boolean> {
  const W = 320, H = 240;
  const rgb = sample(img, 0, 0, img.width, img.height, W, H);
  const input = new Float32Array(3 * W * H);
  for (let i = 0; i < W * H; i++) {
    input[i] = (rgb[i * 3] - 127) / 128;
    input[W * H + i] = (rgb[i * 3 + 1] - 127) / 128;
    input[2 * W * H + i] = (rgb[i * 3 + 2] - 127) / 128;
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

  // Removing a photo needs no moderation.
  if (body.remove) {
    await admin.from("profiles").update({ photo_url: null, photo_status: "none" }).eq("id", uid);
    return json({ ok: true, removed: true });
  }

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

  if (score > NSFW_LIMIT) {
    await admin.from("profiles").update({ photo_status: "rejected" }).eq("id", uid);
    return json({ ok: false, reason: "That photo doesn't meet the rules. Pick one you'd be happy showing anyone." });
  }
  if (!face) {
    await admin.from("profiles").update({ photo_status: "rejected" }).eq("id", uid);
    return json({ ok: false, reason: "We couldn't see a face. Your profile photo should be of you." });
  }

  const { error } = await admin.from("profiles")
    .update({ photo_url: body.image, photo_status: "approved" }).eq("id", uid);
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true, photo_status: "approved" });
});
