// Hooky safety rules. Shared by the demo store and the UI.
// The same rules are enforced server-side in supabase/schema.sql for real deployments.
(function () {
  const BRACKETS = [
    { id: "13-15", label: "13 to 15", min: 13, max: 15, minor: true },
    { id: "16-17", label: "16 to 17", min: 16, max: 17, minor: true },
    { id: "18-20", label: "18 to 20", min: 18, max: 20, minor: false },
    { id: "21+",   label: "21 and up", min: 21, max: 200, minor: false },
  ];
  const MIN_AGE = 13;

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
  function bracketForAge(age) {
    return BRACKETS.find((b) => age >= b.min && age <= b.max) || null;
  }
  // Teens only ever see their own bracket. Adults never see minors.
  function canSee(viewerBracket, targetBracket) {
    return !!viewerBracket && viewerBracket === targetBracket;
  }

  // Message filter. For minors we block attempts to move the conversation
  // off-platform (phone numbers, handles, links) since that is where grooming
  // and sextortion usually go. Adults get a softer warning only.
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
    return {
      ok: !strict,
      blocked: strict,
      reasons: hits.map((h) => h.why),
      warn: !strict,
    };
  }

  const GENDERS = [
    { id: "woman", label: "Woman" },
    { id: "man", label: "Man" },
    { id: "nonbinary", label: "Non-binary" },
    { id: "other", label: "Other" },
  ];

  const REPORT_REASONS = [
    "Pretending to be someone else / wrong age",
    "Inappropriate photos or messages",
    "Asked me to move to another app",
    "Bullying or hate",
    "Scam or spam",
    "I just feel unsafe",
  ];

  window.HookySafety = { BRACKETS, MIN_AGE, GENDERS, ageFromBirthdate, bracketForAge, canSee, checkMessage, REPORT_REASONS };
})();
