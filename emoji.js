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

  window.HookyEmoji = { emo, char, tag, tagSlug, tagColor, AVATARS, INTERESTS, BY_CHAR, hash };
})();
