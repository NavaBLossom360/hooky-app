# Hooky

Catch someone new. Swipe, match, chat, and go live. Not a dating app.

The name works both ways: a hook you catch someone with, and playing hooky. In
the app a like is a **hook**, a match is a **catch**, and the paid tiers are
**Hooky+** and **Hooky Max**.

Hooky is a swipe-to-make-friends app for people 13 to 25, with voice and video
calls between matches who are online at the same time. Every safety rule is
enforced twice: once in the client for fast feedback, and once in the database
where it cannot be bypassed.

**Live app:** https://navablossom360.github.io/hooky-app/

## Run it

There is no build step. Open `index.html` in a browser, or serve the folder with
any static server. With no `config.js` present the app runs in **demo mode**:
sixteen fake users, everything stored in `localStorage`, fake chat replies.

To connect a real backend, follow **[SETUP.md](SETUP.md)**. In short: create a
free Supabase project, run `supabase/schema.sql` in the SQL editor, set the
Site URL and redirect allowlist, and copy `config.example.js` to `config.js`
with your project URL and publishable key. Accounts are email and password,
with the email confirmed before the first login.

## Signing up

1. **Sign up** on the welcome screen.
2. **Face age check**, on the device. A short camera scan estimates age before
   any account exists. The screen explains that the camera is analyzed on the
   phone, nothing is sent to anyone, and no faceprint is created or stored.
3. **Email and password.** The only thing kept from the scan, the estimated
   age, rides along in the new account's metadata.
4. **Confirm the email** from the link Supabase sends.
5. **Log in.**
6. **Set up the profile**: nickname, birthday, gender, who to meet, 1 to 4
   photos, interests, region and bio, notifications. The birthday has to fit the
   face estimate, and the database checks that again when the profile is made.
7. **Browse.**

Accounts made before the age check existed are sent through it once at their
next login, and stay out of everyone's deck until they pass.

## What's in the box

| File | What it does |
| --- | --- |
| `index.html` | App shell and script loading |
| `styles.css` | The design system: dark stage, condensed display type, sticker tags |
| `safety.js` | Age windows, age check tolerance, gender rules, message filter, pricing |
| `emoji.js` | The 3D emoji set, interests, avatars and tag colors |
| `agecheck.js` | On-device face age estimation for signup |
| `store.js` | Data layer: `LocalStore` (demo) and `SupabaseStore` (real) |
| `call.js` | Voice and video calls over WebRTC |
| `app.js` | Screens: onboarding, Catch deck, Chats, Rooms, Me, plans |
| `sw.js` | Service worker: offline shell and push notifications |
| `logo.html`, `qr.html` | Regenerate the icons and the QR test card |
| `supabase/schema.sql` | Tables, row level security, and the server-side rules |
| `supabase/functions/` | `age-check`, `photo-check`, `push-send`, `billing-webhook` |
| `vendor/face-api/` | The age check's engine and its three models |
| `assets/emoji/` | 126 Fluent 3D emoji as 160px WebP, about 600 KB in all |

## Look and feel

A dark stage filled with colored 3D emoji. Headlines are huge condensed
Bricolage Grotesque, onboarding asks one question per screen with a sticker
pinned to the headline and a round lime arrow to continue, interests are
chunky colored sticker tags, and cards are full-bleed with the name up top.
Lime means "go"; the pink to orange gradient means "hook". Cards show up to
four photos: tap the right or left half to flip, and the bars along the top
show which one is up, Yubo-style. The rare profile with no photo (older
accounts, and the demo's fake people) gets a card built from its interests:
an emoji large in the middle with interest stickers floating behind it.

The emoji are Microsoft's Fluent Emoji (MIT), bundled so they look identical
on every phone and never load from a third party.

## Who can see whom

Ages 13 to 25, matched on a sliding window rather than fixed buckets. Under 18
you never see past 18; from 18 up you never see below 17. Those clamps meet in
exactly one place, so **17 and 18 can see each other and no other minor/adult
pair can**.

| Pair | Allowed |
| --- | --- |
| 17 and 18 | yes |
| 16 and 18 | no |
| 17 and 19 | no |
| 20 and 17 | no |
| Over 25 | cannot sign up |

Visibility is also mutual on gender: you each have to be in the other person's
"show me" list. Birthdate is write-once, and under 13 is refused at signup.

## Free vs paid

| | Free | Hooky+ | Hooky Max |
| --- | --- | --- | --- |
| Hooks (likes) per day | 25 | unlimited | unlimited |
| See who hooked you | blurred | yes | yes |
| Undo a pass | no | yes | yes |
| Private rooms | none | 1 | 5 |
| Voice and video calls | yes | yes | yes |
| Report, block, safety tips | yes | yes | yes |

Under-18 accounts pay less on every plan: Hooky+ is $2.99 a month under 18
against $4.99 over, with three billing periods for each tier. On mobile this has
to go through app store billing. Safety features and calls are never paywalled.

## Safety design

- Ages 13 to 25 on a sliding window, enforced in the database, not just the UI.
- Gender preference is mutual, enforced in the discovery functions and again
  inside `swipe()` so the API cannot be used to get around the deck.
- **Age check on the device, before signup.** `agecheck.js` runs face-api
  1.7.12's face detector, age model and expression model in the browser, the
  same library and weights the open source go.cam age check uses. Like go.cam
  it takes seven clean readings, drops outliers with the IQR rule and averages
  the rest. It also asks for a smile (or a straight face) so a still photo
  can't pass, resets if the face jumps between frames, and refuses known
  virtual cameras. No frame leaves the device and no face descriptor is ever
  computed. Faces estimated over 35 can't sign up. The birthday must then sit
  within 10 years below or 8 above the estimate, checked in the app and again
  by `profiles_guard` in the database.
- **The trade-off, chosen on purpose:** because nothing is uploaded, the server
  has to trust the estimate the phone reports, so a modified app could lie.
  Those profiles are marked `verification_provider = 'on-device'`, and the
  server-side `age-check` function can still overwrite them with a stronger
  verdict.
- **Real photos, 1 to 4 each.** Setup needs at least one. Every photo passes
  the `photo-check` Edge Function (a nudity classifier plus a face check)
  before it is stored, and clients cannot upload or write photos any other
  way. Files sit in a private bucket, and signed links are only issued to
  people who could see that profile anyway. It is not CSAM detection.
- Chats involving anyone under 18 block phone numbers, social handles, other app
  names, links, and meet-up or photo requests. Adults get a warning instead.
- Private rooms are pinned to their creator's age window, and room topics pass
  the same filter as messages.
- Location is region only. No last name, no school, no last-seen.
- Report and block from every card, chat, and call. Reports are private, and
  three open reports hide an account pending review.
- Safety tips screen with sextortion guidance and hotline numbers.

## Calls and presence

Everyone with the app open is tracked on a presence channel. In the Catch deck,
online people show an "Online now" badge and sort first, and there is an
online-only filter. Two people who have caught each other and are both online can
start a **voice or video** call from the chat, the match screen, or the Chats
tab. Voice never requests the camera. The other person has to accept. Calls run
peer to peer over WebRTC with signalling on a per-match realtime channel, nothing
is recorded, and either side can end or report from the call screen. In demo mode
the call shows your own camera with a placeholder for the other person.

## Private rooms

Paid accounts can open group rooms on a topic they type. A room is pinned to its
creator's age window, so it can never become a way to reach outside that range,
and any room reaching under 18 gets the strict message filter.

## Notifications

New catches and messages send a Web Push notification. Turn it on under
**Me → Notifications**, or accept the prompt after your first catch.
Notifications say that someone messaged you, never what they said, so nothing
leaks onto a lock screen. On iPhone the app must be added to the Home Screen
first, because iOS only allows web push for installed apps.

## Install it like an app

Hooky ships a web app manifest and a service worker, so on a phone you can add it
to the home screen and it opens full-screen with its own icon. It also works
offline for the shell.

- **iPhone (Safari):** Share, then "Add to Home Screen".
- **Android (Chrome):** the three-dot menu, then "Install app".

HTTPS matters: the camera, the microphone, push, and the service worker all
refuse to run over plain `http://`, so testing over a local network IP will not
let you try the selfie step, a call, or notifications. Use the live URL.

`qr.html` renders a scannable QR card for the live URL. Open it on the dev server
and call `upload()` from the console to save it to `assets/`.

## Shipping to the App Store and Google Play

A web app cannot be submitted directly, so Hooky ships as a native wrapper around
this folder using Capacitor. What is already here:

- `capacitor.config.json` with the app id, name, colors, and splash settings.
- `build.ps1`, which copies the shippable files into `www/` for Capacitor.
- Store-size icons in `assets/`, generated by `logo.html`.
- `legal.html` with Community Guidelines, Terms, and a Privacy Policy template.
  Host it at a public URL; both stores require a live Privacy Policy link.
- In-app report, block, filtering, account deletion, and a support contact,
  which Apple requires for any app with user-generated content.
- A billing webhook, so purchases can be wired without the client ever granting
  itself a paid tier.

Steps, on a Mac with Xcode for iOS (Android works from Windows):

1. Change `SUPPORT_EMAIL` in `app.js` and the app id in `capacitor.config.json`.
2. Create `config.js` with your Supabase project so the build is not in demo mode.
3. Run `build.ps1`, then `npm i @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android`,
   `npx cap add ios`, `npx cap add android`, `npx cap sync`.
4. iOS: set NSCameraUsageDescription and NSMicrophoneUsageDescription in Xcode
   ("Hooky uses your camera and microphone for calls and the selfie age check").
   Android: camera, microphone, and internet permissions in the manifest.
5. Add in-app purchases with StoreKit and Google Play Billing, and point them at
   the billing webhook. Stores reject subscriptions that bypass their billing.
6. App Store Connect: age rating, category Social Networking, Privacy Policy URL,
   and a demo account for the reviewer. Google Play: Data safety form and the
   Child Safety Standards declaration, which is mandatory for social apps.

## Before real users

- **A stronger age check.** Face models are several years out for teenagers,
  so a young-looking adult claiming to be 16 will pass, and the on-device
  result can be forged by a modified app. An ID check or the server-side
  `age-check` function (`AGE_PROVIDER=aws` for AWS Rekognition) can back it up.
- **CSAM detection and a human review queue.** Photo checks today are nudity
  classification only; hash matching against known material is missing.
- **Real legal text.** `legal.html` is a template full of bracketed placeholders,
  and the repository is public.
- Privacy review against COPPA and state teen-privacy laws.
