# Chrome Web Store submission kit

Everything to paste into the Developer Dashboard. Upload `dist/lazyscroll-<version>.zip` (build it with
`npm run package`).

## Store listing tab

**Name:** LazyScroll

**Summary** (from manifest, ≤132 chars):
Scroll by looking at the top or bottom of the page, like posts by smiling. Face tracking runs on your device.

**Category:** Accessibility

**Language:** English

**Description:**

> Browse x.com hands-free.
>
> • Look at the bottom of the page and it scrolls down. Look at the top and it scrolls up. The closer to the
>   edge, the faster.
> • Smile at a post and it gets liked.
>
> Reading the middle of the page does nothing, and neither does glancing away, at your keyboard, or to the side,
> so it only moves when you mean it to. A quick 20-second calibration teaches LazyScroll your face and screen.
>
> Private by design: face tracking runs entirely on your computer with a model bundled in the extension. No
> video, images or data ever leave your device. No account, no servers, no tracking.
>
> Features
> • Calibrated eye tracking with a dead zone, scroll bands and off-screen detection
> • The post that would be liked is outlined so you always know what a smile will do
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
- Screenshots (1280×800, 1–5): `store/screenshot-setup-1280x800.png`. Add 2–3 real ones from x.com: the
  outlined post with the status pill, and debug mode with the gaze dot.

## Privacy practices tab

**Single purpose:**
Lets the user scroll x.com and like posts hands-free, using on-device webcam tracking of where they look and
whether they smile.

**Permission justifications:**
- `storage`: saves the user's settings and gaze calibration locally.
- `offscreen`: runs the webcam and the on-device face-tracking model in an offscreen document, so the camera keeps
  working while the user is on x.com without asking x.com for camera permission.
- Content script on `x.com` / `twitter.com`: finds the post in the middle of the screen, scrolls the page and
  clicks the like button when the user smiles.

**Remote code:** No, I am not using remote code. (MediaPipe's JavaScript and WebAssembly are bundled in
`vendor/`.)

**Data usage:** tick nothing. LazyScroll does not collect or transmit any user data. Webcam frames are processed in
memory on the device and discarded.

Then tick all three certifications (no selling data, no unrelated use, no creditworthiness use).

**Privacy policy URL:** https://github.com/Raimo33/LazyScroll/blob/main/PRIVACY.md (this file must be on `main`
before you submit).

## Distribution tab

Public (or Unlisted if you only want people with the link), all regions, free.
