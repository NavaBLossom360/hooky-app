// Hooky's emoji world. Every emoji the app draws is a 3D sticker from
// Microsoft's Fluent Emoji set (MIT licensed, see assets/emoji/LICENSE.txt),
// bundled in assets/emoji/ so it looks the same on every phone and never
// fetches from a third party. Anything not in the set falls back to the
// phone's own emoji font.
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Emoji character -> asset name, for anything a person can pick or that
  // arrives from the database as a character.
  const BY_CHAR = {
    "🙂": "smile", "😊": "smile", "😎": "sunglasses", "🤩": "star-struck", "😜": "wink-tongue", "🥳": "partying",
    "🤠": "cowboy", "👻": "ghost", "👽": "alien", "🤖": "robot", "🦊": "fox", "🐼": "panda", "🐸": "frog",
    "🐙": "octopus", "🦄": "unicorn", "🐱": "cat", "🐶": "dog", "🐯": "tiger", "🐧": "penguin", "🌸": "blossom",
    "⚡": "zap", "🔥": "fire", "🍓": "strawberry", "🌈": "rainbow", "🐠": "tropical-fish", "🦈": "shark",
    "🐬": "dolphin", "🧸": "teddy", "🎨": "palette", "🎮": "video-game", "🎧": "headphone", "🛹": "skateboard",
    "📚": "books", "⚽": "soccer", "🎸": "guitar", "🏀": "basketball", "🧪": "test-tube", "🎬": "clapper",
    "🏃": "runner", "🐍": "snake", "☕": "coffee", "🌿": "herb", "🎶": "notes", "🏋️": "lifter", "🎣": "fishing-pole",
    "🐟": "fish", "🍕": "pizza", "🍿": "popcorn", "🚀": "rocket", "🌙": "moon", "🧋": "bubble-tea", "💎": "gem",
    "👑": "crown", "🦋": "rainbow",
  };

  // Avatars people can choose instead of a photo.
  const AVATARS = ["😎", "🤩", "😜", "🥳", "🤠", "👻", "👽", "🤖", "🦊", "🐼", "🐸", "🐙", "🦄", "🐱", "🐶", "🐯", "🐧", "🐠", "🐬", "🌸", "🍓", "🌈", "⚡", "🔥"];

  // Interests, each with its own sticker.
  const INTERESTS = [
    ["Gaming", "video-game"], ["Building", "brick"], ["Anime", "fish-cake"], ["K-pop", "mic"], ["Music", "headphone"],
    ["Art", "palette"], ["Movies", "popcorn"], ["Memes", "joy"], ["Soccer", "soccer"], ["Basketball", "basketball"],
    ["Running", "shoe"], ["Skating", "skateboard"], ["Books", "books"], ["Baking", "cupcake"], ["Coding", "laptop"],
    ["Photography", "camera-flash"], ["Dance", "mirror-ball"], ["Science", "microscope"], ["Theater", "theater"],
    ["Hiking", "boot"], ["Thrifting", "bags"], ["Fitness", "muscle"], ["Board games", "die"], ["Cars", "race-car"],
    ["Travel", "airplane"], ["Pets", "dog"], ["Cats", "cat"], ["Food", "pizza"], ["Space", "rocket"], ["Boba", "bubble-tea"],
    ["Guitar", "guitar"], ["Coffee", "coffee"], ["Plants", "herb"], ["Chess", "die"], ["Debate", "megaphone"],
  ];
  const TAG_SLUG = Object.fromEntries(INTERESTS.map(([t, s]) => [t.toLowerCase(), s]));

  // Chunky tag colors, like stickers on a laptop lid.
  const TAG_COLORS = ["#c8ff4f", "#ff4f8b", "#38bdf8", "#a78bfa", "#ff7a59", "#2dd4bf", "#ffd93d", "#f472b6"];
  function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }

  // <img> for an asset name. `size` is the rendered pixel size.
  function emo(slug, size = 24, cls = "") {
    return `<img class="emo ${cls}" src="assets/emoji/${slug}.webp" width="${size}" height="${size}" alt="" draggable="false" decoding="async">`;
  }
  // An emoji character drawn as a 3D sticker when we have one.
  function char(c, size = 24, cls = "") {
    const slug = BY_CHAR[c];
    return slug ? emo(slug, size, cls) : `<span class="emo-txt ${cls}" style="font-size:${Math.round(size * 0.86)}px">${esc(c || "🙂")}</span>`;
  }
  function tagSlug(tag) { return TAG_SLUG[String(tag).toLowerCase()] || "sparkles"; }
  function tagColor(tag) { return TAG_COLORS[hash(String(tag).toLowerCase()) % TAG_COLORS.length]; }
  function tag(t, opts = {}) {
    const on = opts.on ? " on" : "";
    const data = opts.data ? ` data-t="${esc(t)}"` : "";
    const el = opts.button ? "button" : "span";
    return `<${el} class="tag${on}" style="--tc:${tagColor(t)}"${data}>${emo(tagSlug(t), opts.size || 18)}${esc(t)}</${el}>`;
  }

  // Profile styles: a soft multi-color background (three glows over a base,
  // instead of a flat two-color fade) and three stickers that float on your
  // profile. People pick one on the Me tab; everyone else sees it on cards
  // without photos, avatars, and call screens. Ids are stored in
  // profiles.theme, so keep them stable (the database allows ^[a-z]{2,16}$).
  // `tier` marks paid styles; the same lists live in theme_tier() in
  // schema.sql, which is what actually enforces them.
  const mesh = (base, a, b, c) =>
    `radial-gradient(110% 80% at 0% 0%, ${a} 0%, transparent 60%), radial-gradient(90% 90% at 100% 100%, ${b} 0%, transparent 62%), radial-gradient(70% 70% at 100% 0%, ${c} 0%, transparent 60%), ${base}`;
  const THEMES = [
    { id: "sunset", name: "Sunset", bg: mesh("#ff5e62", "#ffb347", "#ff2e97", "#7b2ff7"), stickers: ["sun", "sparkles", "heart"] },
    { id: "ocean", name: "Ocean", bg: mesh("#0369a1", "#22d3ee", "#1e3a8a", "#38bdf8"), stickers: ["dolphin", "tropical-fish", "wave"] },
    { id: "candy", name: "Candy", bg: mesh("#f9a8d4", "#c4b5fd", "#fb7185", "#fde68a"), stickers: ["lollipop", "cupcake", "strawberry"] },
    { id: "matcha", name: "Matcha", bg: mesh("#15803d", "#a3e635", "#065f46", "#4ade80"), stickers: ["herb", "frog", "blossom"] },
    { id: "lime", name: "Hooky lime", bg: mesh("#14532d", "#c8ff4f", "#0f172a", "#22c55e"), stickers: ["fishing-pole", "sparkles", "thumbs-up"] },
    { id: "midnight", name: "Midnight", bg: mesh("#020617", "#1d4ed8", "#0f172a", "#6366f1"), stickers: ["moon", "sleeping", "star"] },
    { id: "galaxy", tier: "plus", name: "Galaxy", bg: mesh("#1e1b4b", "#7c3aed", "#ec4899", "#312e81"), stickers: ["rocket", "star", "moon"] },
    { id: "arcade", tier: "plus", name: "Arcade", bg: mesh("#150b2e", "#ff00d4", "#00e5ff", "#6d28d9"), stickers: ["video-game", "headphone", "zap"] },
    { id: "peach", tier: "plus", name: "Peach", bg: mesh("#fb923c", "#fed7aa", "#f472b6", "#fdba74"), stickers: ["teddy", "cake", "sparkling-heart"] },
    { id: "mint", tier: "plus", name: "Mint", bg: mesh("#0d9488", "#99f6e4", "#0f766e", "#5eead4"), stickers: ["bubble-tea", "panda", "cat"] },
    { id: "lava", tier: "max", name: "Lava", bg: mesh("#7f1d1d", "#f97316", "#dc2626", "#facc15"), stickers: ["fire", "hundred", "dizzy"] },
    { id: "rainbow", tier: "max", name: "Rainbow", bg: `radial-gradient(90% 70% at 50% 0%, rgba(255,255,255,0.35), transparent 60%), linear-gradient(135deg, #ff5f6d, #ffc371 25%, #c8ff4f 45%, #38bdf8 70%, #a855f7)`, stickers: ["rainbow", "unicorn", "balloon"] },
    { id: "aurora", tier: "max", name: "Aurora", bg: mesh("#064e3b", "#34d399", "#7c3aed", "#22d3ee"), stickers: ["sparkles", "gem", "star"] },
    { id: "gold", tier: "max", name: "Gold", bg: mesh("#78350f", "#fcd34d", "#b45309", "#fde68a"), stickers: ["crown", "gem", "trophy"] },
  ];
  const FREE_THEMES = THEMES.filter((t) => !t.tier);
  const THEME_BY_ID = Object.fromEntries(THEMES.map((t) => [t.id, t]));
  // Whether a plan can use a style: free styles for everyone, "plus" styles
  // for Hooky+ and Max, "max" styles for Max only.
  function themeAllowed(t, premium, tier) {
    if (!t || !t.tier) return true;
    return !!premium && (t.tier === "plus" || tier === "max");
  }
  // The chosen style, or a stable free pick for people who haven't chosen
  // one, so nobody is left on a plain fade. Your own profile passes
  // `premium`/`tier`, so a paid style falls back once the plan ends; other
  // people's styles already come back from the server that way.
  function themeFor(u) {
    const t = u && THEME_BY_ID[u.theme];
    if (t && ("premium" in u ? themeAllowed(t, u.premium, u.tier) : true)) return t;
    return FREE_THEMES[hash((u && (u.id || u.name)) || "me") % FREE_THEMES.length];
  }

  window.HookyEmoji = { emo, char, tag, tagSlug, tagColor, AVATARS, INTERESTS, BY_CHAR, hash, THEMES, themeFor, themeAllowed };
})();
