// Hooky push sender. Delivers a Web Push notification to the OTHER person in a
// match, for a new catch or a new message.
//
// The caller proves who they are with their own session, and this function
// checks they are actually in the match before it will notify anyone. A client
// therefore cannot use this to push arbitrary notifications at strangers: the
// worst it can do is notify someone it is already allowed to message.
//
// Two pieces of cryptography are required by Web Push, both done here with
// Web Crypto and no dependencies:
//
//   VAPID (RFC 8292): an ES256 JWT proving who the sender is, signed with the
//   private key that matches the public key the browser subscribed with.
//
//   Payload encryption (RFC 8291, aes128gcm): the push service must not be able
//   to read the message. We do ECDH against the subscription's public key,
//   derive a content key and nonce through HKDF, and AES-GCM the payload.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VAPID_PRIVATE_JWK = Deno.env.get("VAPID_PRIVATE_JWK") ?? "";
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:support@example.com";
const APP_URL = Deno.env.get("APP_URL") ?? "https://navablossom360.github.io/hooky-app/";

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// ---------------------------------------------------------------- base64url
const b64urlToBytes = (s: string): Uint8Array => {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const raw = atob(pad);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};
const bytesToB64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const concat = (...arrs: Uint8Array[]) => {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

// ---------------------------------------------------------------- VAPID JWT
async function vapidHeader(endpoint: string): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToB64url(new TextEncoder().encode(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: VAPID_SUBJECT,
  })));
  const signingInput = `${header}.${claims}`;

  const jwk = JSON.parse(VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // Web Crypto already returns the raw r||s form that JWS wants.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput)));
  return `vapid t=${signingInput}.${bytesToB64url(sig)}, k=${VAPID_PUBLIC_KEY}`;
}

// ------------------------------------------------------- aes128gcm payload
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

async function encryptPayload(plaintext: string, p256dhB64: string, authB64: string): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(p256dhB64);   // 65 bytes, the browser's key
  const authSecret = b64urlToBytes(authB64);   // 16 bytes

  // Ephemeral key pair for this one message.
  const asKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));

  // RFC 8291: mix in both public keys so the keys are bound to this pair.
  const prkInfo = concat(new TextEncoder().encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, prkInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 is the final-record delimiter; there is only ever one record here.
  const padded = concat(new TextEncoder().encode(plaintext), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded));

  // Header: salt(16) | record size(4) | key id length(1) | key id(65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

async function sendOne(sub: { endpoint: string; p256dh: string; auth: string }, payload: string) {
  const body = await encryptPayload(payload, sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      TTL: "86400",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      Authorization: await vapidHeader(sub.endpoint),
      Urgency: "normal",
    },
    body,
  });
  return res.status;
}

// ------------------------------------------------------------------ handler
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!VAPID_PRIVATE_JWK || !VAPID_PUBLIC_KEY) {
    return json({ error: "push is not configured" }, 503);
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const asUser = createClient(url, anon, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: auth, error: authErr } = await asUser.auth.getUser();
  if (authErr || !auth?.user) return json({ error: "not signed in" }, 401);
  const me = auth.user.id;

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad request body" }, 400); }
  const { match_id, kind } = body ?? {};
  if (!match_id) return json({ error: "match_id required" }, 400);
  if (kind !== "message" && kind !== "match") return json({ error: "kind must be message or match" }, 400);

  const admin = createClient(url, serviceRole);

  // The caller must be in this match. This is what stops the endpoint being
  // used to notify people you have no connection to.
  const { data: match } = await admin.from("matches").select("a, b").eq("id", match_id).maybeSingle();
  if (!match || (match.a !== me && match.b !== me)) return json({ error: "not your match" }, 403);
  const other = match.a === me ? match.b : match.a;

  // Don't notify someone who blocked you, or who you blocked.
  const { data: blocks } = await admin.from("blocks").select("blocker_id")
    .or(`and(blocker_id.eq.${me},blocked_id.eq.${other}),and(blocker_id.eq.${other},blocked_id.eq.${me})`);
  if (blocks && blocks.length) return json({ ok: true, skipped: "blocked" });

  const { data: sender } = await admin.from("profiles").select("display_name").eq("id", me).maybeSingle();
  const name = sender?.display_name ?? "Someone";

  // The notification never carries message text. It says that something
  // happened, not what was said, so a lock screen cannot leak a conversation.
  const payload = JSON.stringify(kind === "match"
    ? { title: "It's a catch!", body: `You and ${name} hooked each other.`, tag: `match-${match_id}`, url: APP_URL }
    : { title: name, body: "sent you a message", tag: `msg-${match_id}`, url: APP_URL });

  const { data: subs } = await admin.from("push_subscriptions")
    .select("endpoint, p256dh, auth").eq("user_id", other);
  if (!subs || !subs.length) return json({ ok: true, sent: 0, reason: "no subscriptions" });

  let sent = 0;
  const dead: string[] = [];
  for (const s of subs) {
    try {
      const status = await sendOne(s, payload);
      if (status >= 200 && status < 300) sent++;
      // 404/410 mean the browser threw the subscription away.
      else if (status === 404 || status === 410) dead.push(s.endpoint);
    } catch { /* one bad endpoint must not stop the others */ }
  }
  if (dead.length) await admin.from("push_subscriptions").delete().in("endpoint", dead);

  return json({ ok: true, sent, pruned: dead.length });
});
