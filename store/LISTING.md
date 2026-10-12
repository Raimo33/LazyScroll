# Chrome Web Store submission kit

Everything to paste into the Developer Dashboard. Upload `lazyscroll-<version>.zip` from the
[latest GitHub release](https://github.com/Raimo33/LazyScroll/releases), or build it locally with `npm run package`.

## Store listing tab

**Name:** LazyScroll

**Summary** (from manifest, ≤132 chars):
Scroll any page by looking at its top or bottom edge, and like posts on X by smiling. Face tracking runs on your device.

**Category:** Accessibility

**Language:** English

**Description:**

> Browse hands-free. 100% LOCAL: everything runs on your computer, nothing is ever sent to a server.
>
> • Look at the bottom of any page and it scrolls down. Look at the top and it scrolls up. The closer to the
>   edge, the faster. Works on regular pages and on apps that scroll an inner panel.
> • On X, smile at a post and it gets liked. Make a sad face and it's unliked.
>
> Reading the middle of the page does nothing, and neither does glancing away, at your keyboard, or to the side,
> so it only moves when you mean it to. A quick 20-second calibration teaches LazyScroll your face and screen.
>
> RUNS LOCALLY, private by design: face tracking runs entirely on your computer with a model bundled in the
> extension, with no cloud and no internet connection needed for tracking. No video, images or data ever leave your device. No account, no servers, no tracking.
>
> Features
> • Calibrated eye tracking with a dead zone, scroll bands and off-screen detection
> • Turn it off everywhere or per site from the toolbar
> • Only tracks the focused window, pauses while you type or watch fullscreen video
> • On X, the post that would be liked is outlined so you always know what a smile will do
> • Status pill showing tracking, smile and gaze levels
> • Debug mode that shows where LazyScroll thinks you're looking
> • Adjustable sensitivity, scroll speed and delays
> • One click on the toolbar icon turns it on or off
>
> Works best with even lighting on your face and the webcam roughly at eye level.
>
> Not affiliated with or endorsed by X Corp.

**Graphics:**
- Icon: `icons/icon128.png`
- Small promo tile (440×280): `store/promo-small-440x280.png`
- Marquee (1400×560, optional): `store/promo-marquee-1400x560.png`
- Screenshots (1280×800, 24-bit PNG, upload in this order):
  1. `store/screenshot-1-look-down-it-scrolls.png`
  2. `store/screenshot-2-no-accidental-scrolls.png`
  3. `store/screenshot-3-smile-to-like.png`
  4. `store/screenshot-4-calibration.png`
  5. `store/screenshot-5-private-by-design.png`

  They're rendered from `store/src/screenshots.html` (edit it, then screenshot each `<section>` at 1280×800).

## Privacy practices tab

**Single purpose:**
Hands-free browsing: scrolls web pages based on where the user looks, using on-device webcam tracking (with
smile-to-like on X as part of the same hands-free control).

**Permission justifications:**
- `storage`: saves the user's settings and gaze calibration locally.
- `offscreen`: runs the webcam and the on-device face-tracking model in an offscreen document, so the camera keeps
  working while the user is on x.com without asking x.com for camera permission.
- Host permission / content script on all sites (`<all_urls>`): the core feature is scrolling whatever page the
  user is reading, which requires running on every site. The script only finds the scrollable element and scrolls
  it; it does not read, store or send page content. On x.com it additionally clicks the like button of the post
  in the middle of the screen when the user smiles. Users can turn it off per site from the toolbar.
  (Broad host access means a longer, more detailed review; expect that.)

**Remote code:** No, I am not using remote code. (MediaPipe's JavaScript and WebAssembly are bundled in
`vendor/`.)

**Data usage:** tick nothing. LazyScroll does not collect or transmit any user data. Webcam frames are processed in
memory on the device and discarded.

Then tick all three certifications (no selling data, no unrelated use, no creditworthiness use).

**Privacy policy URL:** https://raimo33.github.io/LazyScroll/privacy/ (published from `site/` by the Pages
workflow; keep it in sync with `PRIVACY.md`).

## Distribution tab

Public (or Unlisted if you only want people with the link), all regions, free.
