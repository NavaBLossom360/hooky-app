// Hooky safety rules. Shared by the demo store and the UI.
// The same rules are enforced server-side in supabase/schema.sql for real
// deployments, because anyone can edit the code that runs in their own browser.
(function () {
  const MIN_AGE = 13;
  const MAX_AGE = 25;
  const WINDOW = 2; // years either side

  // Who a person of this age is allowed to see.
  //
  // Under 18 you can never see past 18, and from 18 up you can never see below
  // 17. Those two clamps meet in exactly one place, so 17 and 18 can see each
  // other and no other minor/adult pair can. A 16-year-old cannot reach an
  // 18-year-old, and nobody over 20 can reach a minor at all.
  function visibleRange(age) {
    if (age == null || age < MIN_AGE || age > MAX_AGE) return null;
    return age < 18
      ? { lo: Math.max(MIN_AGE, age - WINDOW), hi: Math.min(18, age + WINDOW) }
      : { lo: Math.max(17, age - WINDOW), hi: Math.min(MAX_AGE, age + WINDOW) };
  }

  // Visibility is mutual: each has to fall inside the other's range.
  function canSee(myAge, theirAge) {
    const mine = visibleRange(myAge), theirs = visibleRange(theirAge);
    if (!mine || !theirs) return false;
    return theirAge >= mine.lo && theirAge <= mine.hi && myAge >= theirs.lo && myAge <= theirs.hi;
  }

  function isMinor(age) { return age != null && age < 18; }

  function ageBand(age) {
    const r = visibleRange(age);
    if (!r) return null;
    return { lo: r.lo, hi: r.hi, label: `${r.lo}–${r.hi}`, minor: isMinor(age) };
  }

  function ageFromBirthdate(iso) {
    if (!iso) return null;
    const b = new Date(iso + "T00:00:00");
    if (isNaN(b)) return null;
    const now = new Date();
    let age = now.getFullYear() - b.getFullYear();
    const m = now.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
    return age;
  }

  const GENDERS = [
    { id: "woman", label: "Woman" },
    { id: "man", label: "Man" },
    { id: "nonbinary", label: "Non-binary" },
    { id: "other", label: "Other" },
  ];

  // Message filter. For anyone under 18, and for any conversation that includes
  // someone under 18, block attempts to move the conversation off Hooky, since
  // that is where grooming and sextortion usually go. Adults talking only to
  // adults get a warning instead.
  const PATTERNS = [
    { id: "phone",  re: /(\+?\d[\d\s().-]{7,}\d)/, why: "phone numbers" },
    { id: "handle", re: /(^|\s)@[a-z0-9_.]{3,}/i, why: "social handles" },
    { id: "social", re: /\b(snap(chat)?|insta(gram)?|ig|tiktok|kik|discord|telegram|whatsapp|wickr|omegle)\b/i, why: "other apps" },
    { id: "link",   re: /(https?:\/\/|www\.|\.com\b|\.gg\b|\.me\b)/i, why: "links" },
    { id: "meet",   re: /\b(my address|come over|meet (me )?(up|irl|in person)|where do you live|home alone|send (me )?(a )?(pic|pics|nudes?))\b/i, why: "unsafe requests" },
  ];
  function checkMessage(text, senderIsMinor, receiverIsMinor) {
    const hits = PATTERNS.filter((p) => p.re.test(text));
    if (!hits.length) return { ok: true };
    const strict = senderIsMinor || receiverIsMinor;
    return { ok: !strict, blocked: strict, reasons: hits.map((h) => h.why), warn: !strict };
  }

  const REPORT_REASONS = [
    "Pretending to be someone else / wrong age",
    "Inappropriate photos or messages",
    "Asked me to move to another app",
    "Bullying or hate",
    "Scam or spam",
    "I just feel unsafe",
  ];

  // Subscription tiers. Under-18 accounts pay less on every plan.
  const TIERS = [
    {
      id: "plus", name: "Hooky+", blurb: "Unlimited hooks and your own room.",
      rooms: 1,
      perks: [
        ["♾️", "Unlimited hooks", "Free accounts get 25 a day."],
        ["👀", "See who hooked you", "Catch them instantly instead of waiting."],
        ["↶", "Undo a pass", "Swiped too fast? Bring them back."],
        ["🏠", "One private room", "Start a room on any topic you like."],
      ],
      price: { month: { teen: 2.99, adult: 4.99 }, quarter: { teen: 7.99, adult: 12.99 }, year: { teen: 19.99, adult: 29.99 } },
    },
    {
      id: "max", name: "Hooky Max", blurb: "Everything, plus more rooms and reach.",
      rooms: 5,
      perks: [
        ["⭐", "Everything in Hooky+", "All of the above, included."],
        ["🏠", "Five private rooms", "Run a room per topic, not just one."],
        ["🚀", "Priority in the deck", "Your profile gets shown first."],
        ["🎨", "Profile flair", "Animated borders and more emoji."],
      ],
      price: { month: { teen: 5.99, adult: 9.99 }, quarter: { teen: 14.99, adult: 24.99 }, year: { teen: 39.99, adult: 59.99 } },
    },
  ];
  const PERIODS = [
    { id: "month", label: "Monthly", months: 1 },
    { id: "quarter", label: "3 months", months: 3 },
    { id: "year", label: "Yearly", months: 12 },
  ];
  function priceFor(tierId, periodId, age) {
    const tier = TIERS.find((t) => t.id === tierId);
    if (!tier) return null;
    return tier.price[periodId][isMinor(age) ? "teen" : "adult"];
  }
  function roomsAllowed(tierId) {
    const tier = TIERS.find((t) => t.id === tierId);
    return tier ? tier.rooms : 0;
  }

  window.HookySafety = {
    MIN_AGE, MAX_AGE, GENDERS, TIERS, PERIODS, REPORT_REASONS,
    ageFromBirthdate, visibleRange, ageBand, canSee, isMinor, checkMessage,
    priceFor, roomsAllowed,
  };
})();
