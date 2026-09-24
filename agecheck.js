// On-device facial age estimation for signup.
//
// Engine: face-api 1.7.12 with its tiny face detector, age and expression
// models: the same library and weights the go.cam open source age check ships
// for its selfie flow (see vendor/face-api/NOTICE.txt). The method follows
// go.cam's too: collect several clean scans, drop outliers with the IQR rule,
// average the rest, then run a liveness challenge and refuse virtual cameras.
//
// Privacy: every frame is analyzed inside this browser tab and thrown away.
// Nothing is uploaded, nothing is stored, and no faceprint (face descriptor)
// is ever computed. The only thing that leaves this file is a number, the
// estimated age.
(function () {
  const BASE = "vendor/face-api/";
  const SCANS = 7;             // clean age readings to collect (go.cam uses 5)
  const TICK_MS = 180;         // pause between detections
  const TIMEOUT_MS = 45000;    // give up on the whole check after this
  const CHALLENGE_MS = 12000;  // time allowed for the smile challenge

  // Camera names that belong to software that feeds video from somewhere
  // other than a real lens: recorded clips, screen capture, filters.
  const VIRTUAL_CAMERA = /\b(obs|virtual|manycam|xsplit|snap ?camera|splitcam|e2esoft|vcam|youcam|chromacam|mmhmm|camtwist|fake|dummy|loopback|screen ?capture|avatarify|webcamoid)\b/i;

  let loading = null;
  const fa = () => window.faceapi;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.async = true; s.onload = resolve;
      s.onerror = () => reject(new Error("Couldn't load the age check. Check your connection and try again."));
      document.head.appendChild(s);
    });
  }

  // Loads the library and the three models once, then warms the GPU up so the
  // first real frame isn't slow. onProgress gets 0..1.
  function load(onProgress = () => {}) {
    if (loading) return loading;
    loading = (async () => {
      onProgress(0.05);
      if (!window.faceapi) await loadScript(BASE + "face-api.js");
      onProgress(0.35);
      const tf = fa().tf;
      // WebGL is fastest. Fall back to WASM when a phone has no usable GPU.
      try { await tf.setBackend("webgl"); await tf.ready(); } catch {}
      if (tf.getBackend() !== "webgl") {
        try { tf.setWasmPaths && tf.setWasmPaths(BASE); await tf.setBackend("wasm"); await tf.ready(); } catch {}
      }
      const uri = BASE + "models";
      await fa().nets.tinyFaceDetector.loadFromUri(uri); onProgress(0.55);
      await fa().nets.ageGenderNet.loadFromUri(uri); onProgress(0.75);
      await fa().nets.faceExpressionNet.loadFromUri(uri); onProgress(0.9);
      const warm = document.createElement("canvas"); warm.width = warm.height = 160;
      await fa().detectAllFaces(warm, options()).withFaceExpressions().withAgeAndGender();
      onProgress(1);
      return true;
    })();
    loading.catch(() => { loading = null; });
    return loading;
  }

  function options() { return new (fa().TinyFaceDetectorOptions)({ inputSize: 320, scoreThreshold: 0.4 }); }

  // Opens the front camera and checks it's a real one.
  async function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const e = new Error("This browser can't use the camera. Open Hooky in Safari or Chrome."); e.code = "no-camera"; throw e;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } });
    } catch (err) {
      const e = new Error(err && err.name === "NotAllowedError"
        ? "Camera access is off. Allow the camera for this site, then try again."
        : "We couldn't open your camera."); e.code = "camera-denied"; throw e;
    }
    const track = stream.getVideoTracks()[0];
    const label = (track && track.label) || "";
    if (VIRTUAL_CAMERA.test(label)) {
      stream.getTracks().forEach((t) => t.stop());
      const e = new Error("That looks like a virtual camera. Use your phone or laptop's real camera."); e.code = "virtual-camera"; throw e;
    }
    return stream;
  }

  // ---------- maths ----------
  function median(a) { const s = a.slice().sort((x, y) => x - y); const h = Math.floor(s.length / 2); return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; }
  // Tukey's rule, the same outlier test go.cam applies to its age readings.
  function withoutOutliers(a) {
    if (a.length < 4) return a;
    const s = a.slice().sort((x, y) => x - y);
    const q1 = median(s.slice(0, Math.floor(s.length / 2)));
    const q3 = median(s.slice(Math.ceil(s.length / 2)));
    const fence = (q3 - q1) * 1.5;
    const kept = a.filter((x) => x >= q1 - fence && x <= q3 + fence);
    return kept.length ? kept : a;
  }
  function iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return inter / (a.width * a.height + b.width * b.height - inter);
  }

  // Runs the check against a playing <video>. Callbacks:
  //   onHint(code)       what to tell the person right now
  //   onProgress(0..1)   how far along the check is
  //   onChallenge(kind)  "smile" or "neutral" when the liveness step starts
  // Returns { promise, cancel }. The promise resolves to a result, or rejects
  // with an Error whose .code says why.
  function run(video, { onHint = () => {}, onProgress = () => {}, onChallenge = () => {} } = {}) {
    let cancelled = false;
    const promise = (async () => {
      const started = Date.now();
      const ages = [], happy = [];
      let prev = null, phase = "scan", challenge = null, challengeAt = 0, streak = 0, lastHint = "";
      const hint = (h) => { if (h !== lastHint) { lastHint = h; onHint(h); } };
      const fail = (code, msg) => { const e = new Error(msg); e.code = code; e.hint = lastHint; throw e; };

      while (!cancelled) {
        if (Date.now() - started > TIMEOUT_MS) {
          fail("timeout", lastHint === "light" || lastHint === "no-face"
            ? "We couldn't see your face clearly. Try somewhere brighter."
            : "That took too long. Try again, holding the phone at eye level.");
        }
        if (video.readyState < 2 || !video.videoWidth) { await wait(TICK_MS); continue; }

        const dets = await fa().detectAllFaces(video, options()).withFaceExpressions().withAgeAndGender();
        if (cancelled) break;
        const W = video.videoWidth, H = video.videoHeight;

        if (!dets.length) { hint("no-face"); prev = null; streak = 0; await wait(TICK_MS); continue; }
        if (dets.length > 1) { hint("many"); prev = null; streak = 0; await wait(TICK_MS); continue; }

        const d = dets[0], box = d.detection.box;
        const size = box.width / W;
        const cx = (box.x + box.width / 2) / W, cy = (box.y + box.height / 2) / H;
        if (size < 0.2) { hint("closer"); await wait(TICK_MS); continue; }
        if (size > 0.8) { hint("back"); await wait(TICK_MS); continue; }
        if (Math.abs(cx - 0.5) > 0.2 || Math.abs(cy - 0.5) > 0.24) { hint("center"); await wait(TICK_MS); continue; }
        if (d.detection.score < 0.5) { hint("light"); await wait(TICK_MS); continue; }

        // The face has to stay put between readings. A jump means the camera
        // was pointed somewhere else (or a photo swapped in), so start over.
        if (prev && iou(prev, box) < 0.25) { ages.length = 0; happy.length = 0; streak = 0; }
        prev = box;

        if (phase === "scan") {
          hint("hold");
          ages.push(d.age);
          happy.push(d.expressions.happy || 0);
          onProgress((ages.length / SCANS) * 0.7);
          if (ages.length >= SCANS) {
            // Liveness: ask for the opposite of what the face is doing now.
            // A printed photo or a paused video can't change expression.
            challenge = median(happy) > 0.5 ? "neutral" : "smile";
            phase = "challenge"; challengeAt = Date.now(); streak = 0;
            hint(challenge); onChallenge(challenge);
          }
        } else {
          const e = d.expressions;
          const done = challenge === "smile" ? e.happy > 0.7 : (e.happy < 0.25 && e.neutral > 0.5);
          streak = done ? streak + 1 : 0;
          onProgress(0.7 + Math.min(1, streak / 2) * 0.3);
          if (streak >= 2) break;
          if (Date.now() - challengeAt > CHALLENGE_MS) {
            fail("liveness", challenge === "smile"
              ? "We didn't catch a smile. Try again and give us a big one."
              : "We didn't catch a straight face. Try again and relax your face.");
          }
        }
        await wait(TICK_MS);
      }
      if (cancelled) { const e = new Error("cancelled"); e.code = "cancelled"; throw e; }

      const kept = withoutOutliers(ages);
      const estimate = Math.round((kept.reduce((a, b) => a + b, 0) / kept.length) * 10) / 10;
      return {
        estimate,
        readings: kept.length,
        liveness: challenge,
        method: "on-device",
        engine: "face-api-1.7.12",
        at: new Date().toISOString(),
      };
    })();
    return { promise, cancel: () => { cancelled = true; } };
  }

  function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

  window.HookyAgeCheck = { load, openCamera, run, withoutOutliers };
})();
