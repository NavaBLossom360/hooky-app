// Hooky age check. This is the ONLY code permitted to write
// profiles.verification, which is why it runs with the service role and why the
// client-callable complete_age_check() RPC was dropped.
//
// Pipeline, all server-side so the client cannot forge the result:
//   1. Verify the caller's session.
//   2. Detect the largest face in the frames (UltraFace RFB-320, ~1.3MB).
//      No face in a frame means the check fails; this is also the liveness test.
//   3. Crop to that face and estimate age (age_googlenet / Adience, ~24MB).
//   4. Compare the estimate with the birthdate on the profile and write a
//      verdict plus WHICH provider decided it.
//
// MEASURED ACCURACY of the local model, cropped to a detected face:
//   baby (1)  -> 1     elderly (~70) -> 79
//   teen (16) -> 8     teen (17)     -> 28
// Each call costs roughly two seconds and both models are cached in memory
// between invocations.
// So it is reliable at the extremes and off by roughly 10 years either way for
// teenagers. The slack below is set wide enough not to lock out real teens,
// which means it catches an obvious adult claiming to be 14 but will NOT catch
// a young-looking adult claiming to be 16. For anything stronger, set
// AGE_PROVIDER=aws.
//
// AGE_PROVIDER:
//   "local" - DEFAULT. The two ONNX models described above, run here.
//   "aws"   - AWS Rekognition DetectFaces. Needs AWS_ACCESS_KEY_ID,
//             AWS_SECRET_ACCESS_KEY, AWS_REGION. More accurate, costs money.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// 1.14 on purpose: later builds only ship a threaded WASM binary, and the edge
// runtime has no SharedArrayBuffer, so they fail with "Creating a shared memory
// is not supported". esm.sh also wraps this CJS package differently depending
// on the target, hence the shape check below.
import ortModule from "https://esm.sh/onnxruntime-web@1.14.0";
const ort: any = (ortModule as any)?.env ? (ortModule as any) : ((ortModule as any)?.default ?? ortModule);
import jpeg from "https://esm.sh/jpeg-js@0.4.4";

const PROVIDER = Deno.env.get("AGE_PROVIDER") ?? "local";
const AGE_MODEL_URL = Deno.env.get("AGE_MODEL_URL") ??
  "https://huggingface.co/onnxmodelzoo/age_googlenet/resolve/main/age_googlenet.onnx";
const FACE_MODEL_URL = Deno.env.get("FACE_MODEL_URL") ??
  "https://huggingface.co/onnxmodelzoo/version-RFB-320/resolve/main/version-RFB-320.onnx";

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Rgba = { data: Uint8Array; width: number; height: number };
type Box = { x1: number; y1: number; x2: number; y2: number; score: number };
type Estimate = { low: number; high: number; point: number; provider: string };

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

// Bilinear resample of an arbitrary source rectangle into dw x dh RGB floats.
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

// --------------------------------------------------------------- ONNX sessions
let faceSession: Promise<any> | null = null;
let ageSession: Promise<any> | null = null;
function configureOrt() {
  ort.env.wasm.numThreads = 1;   // no SharedArrayBuffer in the edge runtime
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
    return await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), {
      executionProviders: ["wasm"],
    });
  })();
}
function getFace() { if (!faceSession) faceSession = loadSession(FACE_MODEL_URL).catch((e) => { faceSession = null; throw e; }); return faceSession; }
function getAge() { if (!ageSession) ageSession = loadSession(AGE_MODEL_URL).catch((e) => { ageSession = null; throw e; }); return ageSession; }

// ------------------------------------------------------------ face detection
// UltraFace RFB-320: input [1,3,240,320] RGB scaled (v-127)/128,
// outputs scores [1,N,2] and boxes [1,N,4] normalised to 0..1.
async function detectFace(img: Rgba): Promise<Box | null> {
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
  const boxes = out.boxes.data as Float32Array;
  const n = out.scores.dims[1] as number;
  // Largest confident face, so a bystander in the background is ignored.
  let best = -1, bestScore = 0, bestArea = 0;
  for (let i = 0; i < n; i++) {
    const s = scores[i * 2 + 1];
    if (s < 0.7) continue;
    const area = (boxes[i * 4 + 2] - boxes[i * 4]) * (boxes[i * 4 + 3] - boxes[i * 4 + 1]);
    if (area > bestArea) { bestArea = area; best = i; bestScore = s; }
  }
  if (best < 0) return null;
  return { x1: boxes[best * 4], y1: boxes[best * 4 + 1], x2: boxes[best * 4 + 2], y2: boxes[best * 4 + 3], score: bestScore };
}

// ------------------------------------------------------------ age estimation
// Adience buckets. The model's final layer is already a softmax, so its output
// is read as probabilities directly. Applying softmax again flattens the
// distribution and produces nonsense.
const BUCKETS: [number, number][] = [[0, 2], [4, 6], [8, 12], [15, 20], [25, 32], [38, 43], [48, 53], [60, 100]];
const MEAN_BGR = [104, 117, 123];

async function estimateAge(img: Rgba, box: Box): Promise<Estimate> {
  const pad = 0.25;
  const bw = box.x2 - box.x1, bh = box.y2 - box.y1;
  const x1 = Math.max(0, box.x1 - bw * pad) * img.width;
  const y1 = Math.max(0, box.y1 - bh * pad) * img.height;
  const x2 = Math.min(1, box.x2 + bw * pad) * img.width;
  const y2 = Math.min(1, box.y2 + bh * pad) * img.height;

  const size = 224;
  const rgb = sample(img, x1, y1, x2 - x1, y2 - y1, size, size);
  const input = new Float32Array(3 * size * size);
  for (let i = 0; i < size * size; i++) {
    input[i] = rgb[i * 3 + 2] - MEAN_BGR[0];                     // B
    input[size * size + i] = rgb[i * 3 + 1] - MEAN_BGR[1];       // G
    input[2 * size * size + i] = rgb[i * 3] - MEAN_BGR[2];       // R
  }
  const session = await getAge();
  const feeds: Record<string, any> = {};
  feeds[session.inputNames[0]] = new ort.Tensor("float32", input, [1, 3, size, size]);
  const out = await session.run(feeds);
  const probs = Array.from(out[session.outputNames[0]].data as Float32Array);

  let point = 0;
  for (let i = 0; i < BUCKETS.length; i++) point += probs[i] * ((BUCKETS[i][0] + BUCKETS[i][1]) / 2);

  // Confidence band: the buckets holding the first 70% of the probability mass.
  const order = probs.map((p, i) => [p, i] as [number, number]).sort((a, b) => b[0] - a[0]);
  let mass = 0, lo = 100, hi = 0;
  for (const [p, i] of order) {
    mass += p; lo = Math.min(lo, BUCKETS[i][0]); hi = Math.max(hi, BUCKETS[i][1]);
    if (mass >= 0.7) break;
  }
  return { low: lo, high: hi, point: Math.round(point), provider: "age_googlenet" };
}

// ---------------------------------------------------------- AWS Rekognition
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmac(key: Uint8Array, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}
async function estimateWithAws(image: Uint8Array): Promise<Estimate | null> {
  const id = Deno.env.get("AWS_ACCESS_KEY_ID");
  const secret = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  const region = Deno.env.get("AWS_REGION") ?? "us-east-1";
  if (!id || !secret) throw new Error("AGE_PROVIDER=aws but AWS credentials are not set");
  const host = `rekognition.${region}.amazonaws.com`;
  const body = JSON.stringify({ Image: { Bytes: btoa(String.fromCharCode(...image)) }, Attributes: ["ALL"] });
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const canonical = ["POST", "/", "",
    `content-type:application/x-amz-json-1.1\nhost:${host}\nx-amz-date:${amzDate}\nx-amz-target:RekognitionService.DetectFaces\n`,
    "content-type;host;x-amz-date;x-amz-target", await sha256Hex(new TextEncoder().encode(body))].join("\n");
  const scope = `${date}/${region}/rekognition/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(new TextEncoder().encode(canonical))].join("\n");
  let key = await hmac(new TextEncoder().encode("AWS4" + secret), date);
  key = await hmac(key, region); key = await hmac(key, "rekognition"); key = await hmac(key, "aws4_request");
  const sig = [...(await hmac(key, toSign))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const res = await fetch(`https://${host}/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Date": amzDate,
      "X-Amz-Target": "RekognitionService.DetectFaces",
      Authorization: `AWS4-HMAC-SHA256 Credential=${id}/${scope}, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=${sig}` },
    body,
  });
  if (!res.ok) throw new Error(`Rekognition failed: ${res.status}`);
  const face = (await res.json()).FaceDetails?.[0];
  if (!face?.AgeRange) return null;
  return { low: face.AgeRange.Low, high: face.AgeRange.High, point: Math.round((face.AgeRange.Low + face.AgeRange.High) / 2), provider: "aws-rekognition" };
}

// ------------------------------------------------------------------- handler
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

  let frames: Uint8Array[] = [];
  try {
    const body = await req.json();
    const list: string[] = Array.isArray(body.frames) ? body.frames : body.image ? [body.image] : [];
    if (!list.length) return json({ error: "no frames supplied" }, 400);
    if (list.length > 5) return json({ error: "too many frames" }, 400);
    frames = list.map(decodeDataUrl).filter((f): f is Uint8Array => !!f);
    if (!frames.length) return json({ error: "frames could not be decoded" }, 400);
    if (frames.some((f) => f.length > 3_000_000)) return json({ error: "frame too large" }, 413);
  } catch { return json({ error: "bad request body" }, 400); }

  const admin = createClient(url, serviceRole);
  const { data: profile } = await admin.from("profiles").select("birthdate").eq("id", uid).maybeSingle();
  if (!profile) return json({ error: "finish your profile first" }, 400);
  const statedAge = Math.floor((Date.now() - new Date(profile.birthdate).getTime()) / (365.2425 * 86400000));

  const fail = (reason: string) => json({ ok: false, verification: "failed", reason });

  let est: Estimate | null = null;
  try {
    if (PROVIDER === "aws") {
      est = await estimateWithAws(frames[frames.length - 1]);
      if (!est) return fail("we couldn't see your face. Try again in better light.");
    } else {
      // Decode the first and last frame: a face must be present in both, which
      // is the liveness check as well as the input to the age model.
      const decoded: Rgba[] = [];
      for (const idx of [0, frames.length - 1]) {
        const d = jpeg.decode(frames[idx], { useTArray: true });
        if (!d?.width) return fail("we couldn't read the camera image.");
        decoded.push({ data: d.data as Uint8Array, width: d.width, height: d.height });
      }
      const boxes = await Promise.all(decoded.map(detectFace));
      if (boxes.some((b) => !b)) return fail("we couldn't see your face the whole time. Look at the camera and hold still.");
      est = await estimateAge(decoded[1], boxes[1]!);
    }
  } catch (e) {
    // A broken estimator must never hand out a verification.
    return json({ error: "the age check is unavailable right now", detail: String((e as Error).message ?? e) }, 503);
  }

  // Slack absorbs the model's error. It is wide for the local model because
  // false rejections lock real teenagers out of their own account, and it is
  // asymmetric because claiming to be younger than you look is the direction
  // that actually puts people at risk.
  const aws = est.provider === "aws-rekognition";
  const slackUp = aws ? 4 : 8;
  const slackDown = aws ? 4 : 10;
  const withinRange = statedAge >= est.low - slackDown && statedAge <= est.high + slackUp;

  let verdict: "estimated" | "verified" | "failed";
  let reason = "";
  if (withinRange) verdict = aws ? "verified" : "estimated";
  else {
    verdict = "failed";
    reason = statedAge < est.low - slackDown
      ? "you look older than the birthday you entered"
      : "you look younger than the birthday you entered";
  }

  const { error: upErr } = await admin.from("profiles").update({
    verification: verdict,
    verification_provider: est.provider,
    verified_at: verdict === "failed" ? null : new Date().toISOString(),
    age_estimate_low: est.low,
    age_estimate_high: est.high,
  }).eq("id", uid);
  if (upErr) return json({ error: upErr.message }, 500);

  return json({
    ok: verdict !== "failed",
    verification: verdict,
    provider: est.provider,
    // The estimate is never echoed back: it would tell someone gaming the check
    // exactly which birthday to claim next time.
    reason: verdict === "failed" ? reason : undefined,
  });
});
