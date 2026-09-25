// Hooky service worker: makes the app installable, lets the shell load offline,
// and receives push notifications for new catches and messages.
// Network first, cache fallback, so updates show up right away when online.
const CACHE = "hooky-v10";
// The age check (vendor/face-api, about 2 MB) and the Live safety check
// (vendor/onnxruntime + vendor/nsfw, about 20 MB) are not precached; they are
// cached the first time someone uses them.
const SHELL = ["./", "index.html", "config.js", "styles.css", "safety.js", "emoji.js", "store.js", "agecheck.js", "call.js", "roulette.js", "app.js", "icon.svg", "manifest.json", "legal.html", "assets/wordmark.png", "assets/icon-192.png",
  ...["fishing-pole", "speech", "couch", "sunglasses", "shield", "phone", "prohibited", "locked", "wastebasket", "camera", "key", "mailbox", "waving-hand", "cake", "sparkles", "heart-hands", "camera-flash", "video-game", "globe", "megaphone", "crown", "eyes", "flag", "pin", "woman", "man", "person", "people-hugging", "video-camera", "handshake"].map((s) => `assets/emoji/${s}.webp`)];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
  );
});

// ---------------------------------------------------------------- push
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data && e.data.text() }; }
  const title = data.title || "Hooky";
  const options = {
    body: data.body || "You have something new.",
    icon: "assets/icon-192.png",
    badge: "assets/icon-192.png",
    // Same tag per conversation, so ten messages replace each other instead of
    // stacking up ten separate notifications.
    tag: data.tag || "hooky",
    renotify: true,
    data: { url: data.url || "./" },
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Focus an open tab rather than opening a second copy of the app.
    for (const c of all) {
      if (c.url.includes(self.registration.scope)) {
        await c.focus();
        c.postMessage({ type: "notification-click", url: target });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
