// Hooky billing webhook. This is the ONLY thing that can grant or revoke a
// subscription: the profiles trigger blocks clients from writing premium_until
// or premium_tier, so a modified client cannot give itself a paid tier.
//
// Point your payment provider at:
//   POST https://<project>.supabase.co/functions/v1/billing-webhook
//   x-hooky-signature: <BILLING_WEBHOOK_SECRET>
//   { "event": "activate" | "cancel",
//     "user_id": "<auth user uuid>",
//     "tier": "plus" | "max",
//     "period_months": 1 | 3 | 12,          // when expires_at is absent
//     "expires_at": "2027-01-01T00:00:00Z", // preferred: absolute period end
//     "event_id": "<unique per delivery>",  // required without expires_at
//     "provider": "stripe" | "appstore" | "play" | ...,
//     "provider_ref": "<subscription id, used for idempotency>" }
//
// SET BILLING_WEBHOOK_SECRET under Edge Functions -> Secrets before using this.
// Without it the function refuses every request, so an unconfigured deployment
// cannot be used to hand out free subscriptions.
//
// WIRING IT UP:
//   * Stripe: create a webhook endpoint, subscribe to
//     customer.subscription.created/updated/deleted, and translate its payload
//     into the body above in a small adapter (or replace verifySecret below
//     with Stripe's signature check using their SDK).
//   * App Store / Google Play: use App Store Server Notifications v2 and Play
//     Real-time Developer Notifications. Both sign their payloads, so verify
//     that signature rather than the shared secret, then map the product id to
//     a tier. RevenueCat can do this mapping for you and post a plain webhook.
//   * The client never calls this. It is server to server only.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SECRET = Deno.env.get("BILLING_WEBHOOK_SECRET") ?? "";
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

// Constant-time compare so a wrong secret cannot be guessed a byte at a time.
function secretMatches(given: string): boolean {
  if (!SECRET || given.length !== SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < SECRET.length; i++) diff |= SECRET.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

const TIERS = new Set(["plus", "max"]);
const PERIODS = new Set([1, 3, 12]);

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!SECRET) return json({ error: "billing webhook is not configured" }, 503);
  if (!secretMatches(req.headers.get("x-hooky-signature") ?? "")) {
    return json({ error: "bad signature" }, 401);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad request body" }, 400); }

  const { event, user_id, tier, period_months, provider, provider_ref } = body ?? {};
  if (!user_id || typeof user_id !== "string") return json({ error: "user_id required" }, 400);
  if (event !== "activate" && event !== "cancel") return json({ error: "event must be activate or cancel" }, 400);
  if (!provider || !provider_ref) return json({ error: "provider and provider_ref required" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: profile } = await admin.from("profiles").select("id, premium_until").eq("id", user_id).maybeSingle();
  if (!profile) return json({ error: "no such user" }, 404);

  if (event === "cancel") {
    // Let the paid period run out rather than cutting access off mid-month.
    await admin.from("subscriptions").update({ active: false }).eq("provider", provider).eq("provider_ref", provider_ref);
    return json({ ok: true, event: "cancel", premium_until: profile.premium_until });
  }

  if (!TIERS.has(tier)) return json({ error: "tier must be plus or max" }, 400);

  // Providers retry webhooks, so the same event can arrive more than once and
  // must never be credited twice. Two defences, in order of preference:
  //
  //   1. expires_at: the provider tells us the absolute end of the paid period
  //      (Stripe's current_period_end, Apple's expiresDate). Setting it is
  //      naturally idempotent, and renewals still move it forward.
  //   2. event_id: a unique id per delivery, recorded in billing_events so a
  //      replay is rejected. Required when expires_at is absent, because
  //      "add N months" is not safe to repeat.
  let until: Date;
  if (body.expires_at) {
    const t = new Date(body.expires_at);
    if (isNaN(t.getTime())) return json({ error: "expires_at is not a valid date" }, 400);
    until = t;
  } else {
    const months = Number(period_months);
    if (!PERIODS.has(months)) return json({ error: "period_months must be 1, 3 or 12" }, 400);
    const eventId = body.event_id;
    if (!eventId) {
      return json({ error: "send expires_at, or event_id so a retry is not credited twice" }, 400);
    }
    const { error: dupErr } = await admin.from("billing_events")
      .insert({ provider, event_id: String(eventId), user_id });
    if (dupErr) {
      // Primary key conflict means we already processed this delivery.
      if ((dupErr as any).code === "23505") {
        return json({ ok: true, event: "activate", duplicate: true, premium_until: profile.premium_until });
      }
      return json({ error: dupErr.message }, 500);
    }
    const now = Date.now();
    const base = profile.premium_until && new Date(profile.premium_until).getTime() > now
      ? new Date(profile.premium_until).getTime() : now;
    until = new Date(base);
    until.setMonth(until.getMonth() + months);
  }

  // provider_ref is the primary key, so a provider retrying a webhook is safe.
  const planLabel = body.expires_at ? `${tier}_until_${until.toISOString().slice(0, 10)}` : `${tier}_${period_months}m`;
  const { error: subErr } = await admin.from("subscriptions").upsert({
    user_id, provider, provider_ref, plan: planLabel, active: true,
    expires_at: until.toISOString(),
  }, { onConflict: "provider,provider_ref" });
  if (subErr) return json({ error: subErr.message }, 500);

  const { error } = await admin.from("profiles")
    .update({ premium_until: until.toISOString(), premium_tier: tier }).eq("id", user_id);
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true, event: "activate", tier, premium_until: until.toISOString() });
});
