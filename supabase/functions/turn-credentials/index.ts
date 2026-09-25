// Hooky TURN credentials. Hands a signed-in user short-lived ICE servers for
// Live and calls.
//
// Peer-to-peer video only needs STUN on most home Wi-Fi, but phones on
// cellular networks often sit behind NATs that STUN can't get through. A TURN
// server relays the video in those cases. This uses Cloudflare Realtime TURN:
// the long-term key stays here as a secret, and every caller gets credentials
// that expire (TTL below), so nothing reusable ever ships in the public app.
//
// Secrets (Edge Functions -> Secrets):
//   CF_TURN_KEY_ID      the TURN key's id
//   CF_TURN_API_TOKEN   the TURN key's API token
// Until both are set this answers with free STUN servers only, so the app
// keeps working exactly as it did before.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const KEY_ID = Deno.env.get("CF_TURN_KEY_ID") ?? "";
const API_TOKEN = Deno.env.get("CF_TURN_API_TOKEN") ?? "";
// Longer than any realistic Live chat or call, short enough to be worthless
// soon after. The client asks again before it runs out.
const TTL_SECONDS = 4 * 3600;

const STUN_ONLY = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // Only signed-in people get relay credentials; relayed video costs money.
  const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: auth, error } = await asUser.auth.getUser();
  if (error || !auth?.user) return json({ error: "not signed in" }, 401);

  if (!KEY_ID || !API_TOKEN) return json({ iceServers: STUN_ONLY, relay: false, ttl: TTL_SECONDS });

  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
    });
    if (!res.ok) throw new Error(`TURN provider answered ${res.status}`);
    const body = await res.json();
    // Browsers block port 53, and trying it only adds a timeout, so drop it.
    const iceServers = (body.iceServers ?? []).map((s: { urls: string | string[] }) => {
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u));
      return { ...s, urls };
    }).filter((s: { urls: string[] }) => s.urls.length);
    return json({ iceServers, relay: true, ttl: TTL_SECONDS });
  } catch (e) {
    // Never block a call on the relay: fall back to STUN and say so.
    return json({ iceServers: STUN_ONLY, relay: false, ttl: 300, error: String((e as Error).message ?? e) });
  }
});
