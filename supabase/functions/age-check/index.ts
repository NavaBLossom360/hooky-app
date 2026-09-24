// Hooky age check. This is the ONLY code permitted to write
// profiles.verification, which is why it runs with the service role and why the
// client-callable complete_age_check() RPC was dropped.
//
// Flow: the app posts frames captured from the live camera. This function
// verifies the caller's session, runs an age-estimation provider, compares the
// estimate against the birthdate on the profile, and writes the verdict along
// with WHICH provider decided it.
//
// Set AGE_PROVIDER to pick a provider:
//   "aws"  - AWS Rekognition DetectFaces, needs AWS_ACCESS_KEY_ID,
//            AWS_SECRET_ACCESS_KEY, AWS_REGION. Returns a real age range.
//   "demo" - DEFAULT. No identity check. Accepts any live-looking capture and
//            marks the profile 'estimated' with provider 'demo'. Fine for
//            testing, NOT acceptable for real users: it cannot tell an adult
//            from a teenager. Ship a real provider before launch.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PROVIDER = Deno.env.get("AGE_PROVIDER") ?? "demo";
const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

type Estimate = { low: number; high: number; provider: string } | null;

function decodeDataUrl(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  try {
    const raw = atob(dataUrl.slice(comma + 1));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// --- AWS Rekognition (real provider) ---------------------------------------
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmac(key: Uint8Array, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}
async function estimateWithAws(image: Uint8Array): Promise<Estimate> {
  const id = Deno.env.get("AWS_ACCESS_KEY_ID");
  const secret = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  const region = Deno.env.get("AWS_REGION") ?? "us-east-1";
  if (!id || !secret) throw new Error("AGE_PROVIDER=aws but AWS credentials are not set");

  const host = `rekognition.${region}.amazonaws.com`;
  const body = JSON.stringify({
    Image: { Bytes: btoa(String.fromCharCode(...image)) },
    Attributes: ["ALL"],
  });
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(new TextEncoder().encode(body));
  const canonical = [
    "POST", "/", "",
    `content-type:application/x-amz-json-1.1\nhost:${host}\nx-amz-date:${amzDate}\nx-amz-target:RekognitionService.DetectFaces\n`,
    "content-type;host;x-amz-date;x-amz-target",
    payloadHash,
  ].join("\n");
  const scope = `${date}/${region}/rekognition/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(new TextEncoder().encode(canonical))].join("\n");
  let key = await hmac(new TextEncoder().encode("AWS4" + secret), date);
  key = await hmac(key, region);
  key = await hmac(key, "rekognition");
  key = await hmac(key, "aws4_request");
  const sig = [...(await hmac(key, toSign))].map((b) => b.toString(16).padStart(2, "0")).join("");

  const res = await fetch(`https://${host}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Date": amzDate,
      "X-Amz-Target": "RekognitionService.DetectFaces",
      Authorization: `AWS4-HMAC-SHA256 Credential=${id}/${scope}, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=${sig}`,
    },
    body,
  });
  if (!res.ok) throw new Error(`Rekognition failed: ${res.status}`);
  const data = await res.json();
  const face = data.FaceDetails?.[0];
  if (!face?.AgeRange) return null;
  return { low: face.AgeRange.Low, high: face.AgeRange.High, provider: "aws-rekognition" };
}

// --- Demo provider ----------------------------------------------------------
// Confirms the frames look like a live capture rather than one still image held
// up to the lens: several frames, each a plausible size, and enough difference
// between them. This is a sanity check, NOT age estimation.
function looksLive(frames: Uint8Array[]): boolean {
  if (frames.length < 2) return false;
  if (frames.some((f) => f.length < 2000)) return false;
  const sizes = frames.map((f) => f.length);
  const spread = Math.max(...sizes) - Math.min(...sizes);
  return spread > 200; // identical frames compress to near-identical sizes
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Identify the caller from their own token; never trust an id in the body.
  const asUser = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
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
  } catch {
    return json({ error: "bad request body" }, 400);
  }

  const admin = createClient(url, serviceRole);
  const { data: profile } = await admin
    .from("profiles").select("birthdate, verification").eq("id", uid).maybeSingle();
  if (!profile) return json({ error: "finish your profile first" }, 400);

  const statedAge = Math.floor(
    (Date.now() - new Date(profile.birthdate).getTime()) / (365.2425 * 86400000),
  );

  let verdict: "estimated" | "verified" | "failed" = "failed";
  let provider = PROVIDER;
  let low: number | null = null;
  let high: number | null = null;
  let reason = "";

  try {
    if (PROVIDER === "aws") {
      const est = await estimateWithAws(frames[frames.length - 1]);
      if (!est) {
        reason = "no face detected";
      } else {
        low = est.low; high = est.high; provider = est.provider;
        // Allow slack in both directions: estimators are only roughly accurate,
        // but a teen bracket claimed by a clearly adult face is rejected.
        const slack = 4;
        if (statedAge >= low - slack && statedAge <= high + slack) verdict = "verified";
        else { verdict = "failed"; reason = "stated age does not match the estimate"; }
      }
    } else {
      provider = "demo";
      if (looksLive(frames)) verdict = "estimated";
      else reason = "hold still and make sure the camera can see you";
    }
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 502);
  }

  const { error: upErr } = await admin.from("profiles").update({
    verification: verdict,
    verification_provider: provider,
    verified_at: verdict === "failed" ? null : new Date().toISOString(),
    age_estimate_low: low,
    age_estimate_high: high,
  }).eq("id", uid);
  if (upErr) return json({ error: upErr.message }, 500);

  return json({
    ok: verdict !== "failed",
    verification: verdict,
    provider,
    // Never echo the estimate back to the client on failure; it would tell
    // someone gaming the check exactly which birthdate to claim next time.
    reason: verdict === "failed" ? (reason || "age check failed") : undefined,
  });
});
