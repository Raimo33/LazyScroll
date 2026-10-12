# LazyScroll

Hands-free browsing in Chrome:

- **Look at the bottom of any page → it scrolls down. Look at the top → it scrolls up.**
- **On X, smile at a post → it gets liked.**

Everything runs on your computer. The webcam feed goes into Google's MediaPipe face tracker inside the extension.
No frames are stored or sent anywhere, there's no API key, and there are no network requests at all.

## Install

From the Chrome Web Store once it's published. Until then, or for development:

1. Clone this repo.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the repo folder.
3. The setup page opens: allow the camera, then run the 20-second **calibration**. Gaze scrolling stays off until
   you've calibrated.
4. Browse. The toolbar button opens a small menu to switch LazyScroll off everywhere or just for the current site,
   and to reach settings and calibration.

## How it behaves

| Where you look | What happens |
|---|---|
| Middle of the page (the "dead zone") | Nothing. Read in peace. |
| Bottom band of the page | Scrolls down, faster the closer to the edge |
| Top band of the page | Scrolls up |
| Off the screen: above it, below it (keyboard, phone) or to the side | Nothing |

- Scrolling starts after you've looked into a band for ~220 ms (blinks and glances don't count), and stops as soon
  as your gaze comes back towards the middle.
- It scrolls whatever is under your gaze: the page itself, or an inner panel in apps like Gmail or Slack.
- It only tracks the focused browser window (no scrolling while you work in another app) and pauses while you type
  or watch something fullscreen. The camera turns off shortly after the window loses focus.

On X:

- The post that would get liked has a coloured outline: **blue** while LazyScroll reads your resting face,
  **yellow** while it watches for a smile, **green** once liked. It's the tweet crossing the middle of the screen.
  Nothing gets liked while the page is scrolling.
- A smile only counts if it **rises** above your face's resting level on that tweet and holds for ~120 ms, so
  being already amused when a tweet arrives doesn't like it, and one noisy frame doesn't either.
- Liking pauses while a dialog (photo viewer, composer) is open.

The status pill (bottom-left of each page) shows what's going on: tracking state, a smile meter and a gaze meter.
Turn on **Debug: show where I'm looking** in the settings to draw the estimated gaze point on the page with the
scroll bands shaded. Use it to check calibration and tune the sliders. The setup page also has a full-screen
**Test tracking** view.

## Accuracy, honestly

This is webcam eye tracking, not a Tobii. After a good calibration expect roughly **±5–10% of the screen height**
vertically. That's plenty to tell "reading the middle" from "looking at the bottom band" from "looking at my
keyboard", but not fine enough to tell which line of a tweet you're on. What helps most:

- Even light on your face (no strong backlight / window behind you).
- Camera roughly at eye level, centred.
- Recalibrate if you move the laptop, camera or chair. The model compensates for normal head movement, not for a
  new setup.
- Calibration runs full screen; afterwards the scroll bands follow the browser window rather than the whole
  screen, so a non-maximised window works too.

## How it works

```
offscreen page (src/offscreen.js)          content script on every page (src/content.js)
  webcam 1280×720 → MediaPipe Face Landmarker   ← frame summaries over a port, ~30/s
  478 landmarks + 52 blendshapes + head pose    → smile detector → site adapter (X) → click ♥
  → iris-in-eye position, eyelid opening,       → gaze model → One-Euro filter → zones → scroll
    eye blendshapes, head pitch/yaw/position
```

- **Gaze model** (`src/shared.js`): calibration shows a 3×3 grid of dots plus a keyboard glance; a ridge regression
  maps the 9 features to screen x/y. The keyboard glance sets where "below the screen" starts.
- **Latency:** the camera stays warm while x.com is in front, every camera frame is processed
  (`MediaStreamTrackProcessor` with a 1-frame buffer, so there's never a backlog), and inference takes a few
  milliseconds on the GPU. Smile-to-like is about 150–250 ms end to end, mostly the 120 ms hold.
- The camera turns off 15 s after no focused page needs it.

Liking is done by small per-site adapters at the top of `src/content.js` (find posts, tell if liked, click like).
X is the only one so far; adding another site is a few lines.

## Development

```
npm install         # Playwright, only for the e2e test
npm test            # detector / gaze-model unit tests
npm run test:e2e    # loads the extension in Chromium with a fake camera and a mock x.com page
npm run package     # dist/lazyscroll-<version>.zip for the Chrome Web Store
```

Releases: bump `version` in `manifest.json` and push to the default branch. The Release workflow runs the tests,
builds the zip and publishes it as a GitHub release tagged `v<version>`.

Publishing: see [`store/LISTING.md`](store/LISTING.md) for the listing text, permission justifications, privacy
answers and graphics. Bump `version` in `manifest.json` for every upload.

`vendor/mediapipe/` is `@mediapipe/tasks-vision@1.1.0` (SIMD wasm only) and the float16 `face_landmarker.task`
model, both Apache-2.0, bundled because Manifest V3 doesn't allow remotely loaded code.

X adapter selectors: `article[data-testid="tweet"]`, `[data-testid="like"]` / `[data-testid="unlike"]`. If X changes
them, that's where to look.

Automated liking is technically against X's automation rules. At the pace of one human smiling it's very
unlikely to be noticed, but it's your account.
