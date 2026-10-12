# LazyScroll privacy policy

Also published at https://raimo33.github.io/LazyScroll/privacy/

_Last updated: 12 October 2026_

LazyScroll uses your webcam to estimate where you are looking and whether you are smiling, so it can scroll web
pages for you and like posts on x.com.

**What it processes.** Video frames from your webcam, only while LazyScroll is switched on and a browser window
showing a page where it is enabled has focus, or while the LazyScroll setup page is open. Each frame is analysed on your device by a face-tracking model bundled inside the extension and then
discarded immediately.

**What it stores.** Only on your device, in the browser's extension storage: your settings and your calibration
(a few dozen numbers describing how your eye position maps to your screen, plus your smile sensitivity), and the
list of sites you switched it off for. No images
or video are ever stored.

**What it sends.** Nothing. LazyScroll makes no network requests. It has no servers, no analytics, no ads and no
accounts. Your camera feed, calibration and settings never leave your computer.

**What it does on web pages.** It runs on every page so it can scroll it: it looks up which element can scroll
and scrolls it. On x.com it also finds the post in the middle of your screen and clicks its like button when you
smile. It does not read, collect or transmit page content, browsing history, messages or account data.

**Removing your data.** Uninstalling the extension deletes everything it stored. You can also revoke camera access
at any time in Chrome's site settings for the extension.

Questions: open an issue at https://github.com/Raimo33/LazyScroll.
