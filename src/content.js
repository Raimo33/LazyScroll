(() => {
  // Avoid double injection (e.g. extension reloaded while the page stays open).
  if (window.__lazyscroll) return;
  window.__lazyscroll = true;

  let settings = { ...LAZYSCROLL_DEFAULTS };
  const smile = new SmileDetector(settings);
  const gaze = new GazeScroller(settings);
  const host = location.hostname;

  // ---------- site adapters (smile → like) ----------
  // Scrolling works on every page. Liking needs to know a site's markup, so it only runs where an adapter exists.

  const ADAPTERS = [
    {
      name: 'X',
      match: /(^|\.)(x|twitter)\.com$/,
      posts: () => document.querySelectorAll('article[data-testid="tweet"]'),
      isLiked: (post) => !!post.querySelector('[data-testid="unlike"]'),
      like: (post) => {
        const btn = post.querySelector('[data-testid="like"]');
        btn?.click();
        return !!btn;
      },
      // X opens photos, the composer, etc. in modal dialogs; don't act behind them.
      blocked: () => !!document.querySelector('[aria-modal="true"]'),
    },
  ];
  const adapter = ADAPTERS.find((a) => a.match.test(host)) ?? null;

  // ---------- focused post ----------

  let focused = null;

  const focusedState = () => focused?.dataset.lazyscroll;

  function setState(post, state) {
    if (post && post === focused) post.dataset.lazyscroll = state;
  }

  // The post crossing the vertical middle of the viewport, else the nearest one to it.
  function pickFocused() {
    const mid = innerHeight / 2;
    let best = null, bestDist = Infinity;
    for (const a of adapter.posts()) {
      const r = a.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) continue;
      const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
      if (d < bestDist) { bestDist = d; best = a; }
    }
    return best;
  }

  function updateFocus() {
    const next = adapter && active() && settings.likeOnSmile ? pickFocused() : null;
    if (next === focused) return;
    focused?.removeAttribute('data-lazyscroll');
    focused = next;
    smile.reset();
    if (focused) focused.dataset.lazyscroll = adapter.isLiked(focused) ? 'liked' : 'baseline';
  }

  if (adapter) {
    let focusRaf = 0;
    const scheduleFocus = () => {
      if (!focusRaf) focusRaf = requestAnimationFrame(() => { focusRaf = 0; updateFocus(); });
    };
    addEventListener('scroll', scheduleFocus, { passive: true, capture: true });
    addEventListener('resize', scheduleFocus);
    // Sites like X recycle post nodes while you scroll, so re-check whenever the DOM changes.
    new MutationObserver(scheduleFocus).observe(document.body, { childList: true, subtree: true });
  }

  // ---------- scrolling ----------

  let velocity = 0;      // px/s, + is down
  let lastFrameAt = 0;
  let scrollRaf = 0;
  let lastTick = 0;
  let scroller = null;   // element being scrolled, chosen when a scroll starts
  let carry = 0;         // sub-pixel remainder, so slow scrolls don't get rounded away

  function canScrollY(el) {
    if (el.scrollHeight <= el.clientHeight + 1) return false;
    const oy = getComputedStyle(el).overflowY;
    return oy === 'auto' || oy === 'scroll' || oy === 'overlay';
  }

  // Many apps scroll an inner panel rather than the page. Scroll whatever is under the gaze
  // (falling back to the middle of the window), walking up until something can actually scroll.
  function findScroller() {
    const page = gaze.lastPage;
    const x = page ? Math.max(1, Math.min(innerWidth - 2, ((page.x + 1) / 2) * innerWidth)) : innerWidth / 2;
    for (const px of [x, innerWidth / 2]) {
      let el = document.elementFromPoint(px, innerHeight / 2);
      while (el && el !== document.body && el !== document.documentElement) {
        if (canScrollY(el)) return el;
        el = el.parentElement;
      }
    }
    return document.scrollingElement || document.documentElement;
  }

  function scrollTick(now) {
    // Sensor went quiet (tab hidden, camera stopped): never keep scrolling blind.
    if (now - lastFrameAt > 300) velocity = 0;
    if (!velocity) {
      scrollRaf = 0;
      scroller = null;
      carry = 0;
      return;
    }
    const dt = Math.min(50, now - lastTick);
    lastTick = now;
    carry += (velocity * dt) / 1000;
    const step = Math.trunc(carry);
    if (step) {
      carry -= step;
      scroller ??= findScroller();
      // 'instant' so sites with `scroll-behavior: smooth` don't queue up an animation per frame.
      if (scroller === document.scrollingElement || scroller === document.documentElement) {
        window.scrollBy({ top: step, behavior: 'instant' });
      } else {
        scroller.scrollBy({ top: step, behavior: 'instant' });
      }
    }
    scrollRaf = requestAnimationFrame(scrollTick);
  }

  function startScrollLoop() {
    if (scrollRaf) return;
    lastTick = performance.now();
    scrollRaf = requestAnimationFrame(scrollTick);
  }

  // Calibration happens full screen, so the gaze model speaks in screen units (-1…1 across the whole display).
  // Convert to this page's viewport so the scroll bands sit at the page's top and bottom, whatever the window size.
  function screenToPage(p) {
    const sx = ((p.x + 1) / 2) * screen.width;
    const sy = ((p.y + 1) / 2) * screen.height;
    const left = screenX - (screen.availLeft ?? 0) + (outerWidth - innerWidth) / 2;
    const top = screenY - (screen.availTop ?? 0) + (outerHeight - innerHeight);
    return { x: ((sx - left) / innerWidth) * 2 - 1, y: ((sy - top) / innerHeight) * 2 - 1 };
  }

  // ---------- sensor connection ----------

  let port = null;
  let connecting = false;
  let sensor = { state: 'idle' };
  let frame = null;
  let gazeResult = null;
  let smileDelta = 0;
  let fps = 0, fpsCount = 0, fpsWindowStart = performance.now();

  const alive = () => !!chrome.runtime?.id; // false after the extension is reloaded/updated
  const siteEnabled = () => !settings.disabledSites.includes(host);
  // Focus inside an embedded frame (a video player, say) still counts as using this page.
  const windowFocused = () => document.hasFocus() || document.activeElement?.tagName === 'IFRAME';
  const wanted = () => alive() && settings.enabled && siteEnabled() &&
    (settings.scrollWithGaze || (adapter && settings.likeOnSmile));
  const active = () => wanted() && document.visibilityState === 'visible' && windowFocused();

  function pauseReason() {
    const el = document.activeElement;
    if (el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
      return 'typing';
    }
    if (document.fullscreenElement) return 'fullscreen';
    if (adapter?.blocked()) return 'dialog';
    return null;
  }

  async function connect() {
    if (port || connecting || !active()) return;
    connecting = true;
    try {
      await chrome.runtime.sendMessage({ to: 'background', type: 'ensure-sensor' });
    } catch {}
    connecting = false;
    if (port || !active()) return;
    port = chrome.runtime.connect({ name: 'lazyscroll-sensor' });
    port.onMessage.addListener(onSensor);
    port.onDisconnect.addListener(() => {
      port = null;
      velocity = 0;
      if (active()) setTimeout(connect, 1000);
    });
  }

  function disconnect() {
    port?.disconnect();
    port = null;
    velocity = 0;
    sensor = { state: 'idle' };
    frame = null;
    gazeResult = null;
    smile.reset();
    gaze.reset();
  }

  function onSensor(msg) {
    if (msg.type === 'status') {
      sensor = msg;
      return renderHud();
    }
    frame = msg;
    lastFrameAt = performance.now();
    fpsCount++;
    if (lastFrameAt - fpsWindowStart >= 1000) {
      fps = Math.round((fpsCount * 1000) / (lastFrameAt - fpsWindowStart));
      fpsCount = 0;
      fpsWindowStart = lastFrameAt;
    }

    if (pauseReason()) {
      velocity = 0;
      gazeResult = null;
      gaze.reset();
      smile.reset();
      return renderHud();
    }

    if (settings.scrollWithGaze || settings.debugGaze) {
      gazeResult = gaze.push(msg, screenToPage);
      gaze.lastPage = gazeResult.page;
      velocity = settings.scrollWithGaze ? gazeResult.velocity : 0;
      if (velocity) startScrollLoop();
    }

    const state = focusedState();
    if (adapter && settings.likeOnSmile && focused && (state === 'baseline' || state === 'watching')) {
      if (velocity) {
        // Don't judge a post while it's moving; take a fresh baseline once scrolling stops.
        smile.reset();
        setState(focused, 'baseline');
      } else {
        const r = smile.push(msg);
        smileDelta = r.delta;
        if (r.phase === 'watching' && state === 'baseline') setState(focused, 'watching');
        if (r.fired && adapter.like(focused)) setState(focused, 'liked');
      }
    }
    renderHud();
  }

  // ---------- HUD ----------

  const hudHost = document.createElement('div');
  hudHost.id = 'lazyscroll-hud';
  const shadow = hudHost.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .hud { position: fixed; left: 12px; bottom: 12px; z-index: 2147483647; display: flex; align-items: center; gap: 10px;
        padding: 8px 12px; border-radius: 999px; background: rgba(15, 20, 25, 0.88); color: #e7e9ea;
        font: 12px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif; cursor: pointer; user-select: none;
        box-shadow: 0 2px 10px rgba(0,0,0,.3); }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #536471; flex: none; }
      .dot.ok { background: #00ba7c; } .dot.warn { background: #f5b301; } .dot.err { background: #f4212e; }
      .meter { width: 56px; height: 6px; border-radius: 3px; background: #333639; position: relative; overflow: hidden; display: block; }
      .meter i { position: absolute; inset: 0 auto 0 0; background: #f5b301; }
      .meter b { position: absolute; top: 0; bottom: 0; width: 2px; background: #e7e9ea; left: 66.6%; }
      .gaze { width: 6px; height: 22px; border-radius: 3px; background: #333639; position: relative; }
      .gaze::before, .gaze::after { content: ""; position: absolute; left: 0; right: 0; background: rgba(29,155,240,.35); }
      .gaze::before { top: 0; height: var(--zone); border-radius: 3px 3px 0 0; }
      .gaze::after { bottom: 0; height: var(--zone); border-radius: 0 0 3px 3px; }
      .gaze i { position: absolute; left: -2px; width: 10px; height: 4px; border-radius: 2px; background: #e7e9ea; margin-top: -2px; }
      .gaze.on i { background: #1d9bf0; }
      .muted { color: #8b98a5; }
      .gdot { position: fixed; z-index: 2147483647; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%;
        background: rgba(139,152,165,.35); border: 2px solid #8b98a5; pointer-events: none; transition: background .1s, border-color .1s; }
      .gdot.up, .gdot.down { background: rgba(29,155,240,.35); border-color: #1d9bf0; }
      .gdot.scrolling { background: #1d9bf0; }
      .gdot.offscreen { background: rgba(244,33,46,.3); border-color: #f4212e; }
      .band { position: fixed; left: 0; right: 0; z-index: 2147483646; pointer-events: none; background: rgba(29,155,240,.06); }
      .band.top { top: 0; border-bottom: 1px dashed rgba(29,155,240,.5); }
      .band.bottom { bottom: 0; border-top: 1px dashed rgba(29,155,240,.5); }
      [hidden] { display: none !important; }
    </style>
    <div class="hud" title="LazyScroll: click for settings">
      <span class="dot"></span>
      <span class="label">LazyScroll</span>
      <span class="smile" title="Smile vs. threshold"><span class="meter"><i></i><b></b></span></span>
      <span class="gaze" title="Gaze position (scroll zones shaded)"><i></i></span>
      <span class="fps muted"></span>
    </div>
    <div class="band top" hidden></div><div class="band bottom" hidden></div>
    <div class="gdot" hidden></div>`;
  const $ = (s) => shadow.querySelector(s);
  $('.hud').addEventListener('click', () => {
    if (alive()) chrome.runtime.sendMessage({ to: 'background', type: 'open-settings' });
  });

  let hudRaf = 0;
  function renderHud() {
    if (!hudRaf) hudRaf = requestAnimationFrame(drawHud);
  }

  function drawHud() {
    hudRaf = 0;
    // Only on pages where LazyScroll is switched on; turning a site off makes it disappear entirely.
    if (!settings.showHud || !wanted()) return hudHost.remove();
    if (!hudHost.isConnected) document.documentElement.append(hudHost);

    const paused = pauseReason();
    let label = 'LazyScroll', dot = '';
    if (!active()) label = 'LazyScroll (window not focused)';
    else if (sensor.state === 'error') {
      dot = 'err';
      label = {
        'camera-denied': 'Camera blocked: click to allow',
        'no-camera': 'No camera found',
        'camera-busy': 'Camera in use by another app',
        'camera-ended': 'Camera stopped',
      }[sensor.code] || 'Face tracking failed: click for details';
    } else if (sensor.state !== 'running') { dot = 'warn'; label = 'Starting camera…'; }
    else if (!frame?.face) { dot = 'warn'; label = 'No face'; }
    else if (paused) { dot = 'warn'; label = { typing: 'Paused while typing', fullscreen: 'Paused (fullscreen)', dialog: 'Paused' }[paused]; }
    else if (settings.scrollWithGaze && !settings.gazeModel) { dot = 'warn'; label = 'Calibrate to scroll: click'; }
    else { dot = 'ok'; label = velocity > 0 ? 'Scrolling ↓' : velocity < 0 ? 'Scrolling ↑' : focusedState() === 'liked' ? 'Liked' : 'Watching'; }

    $('.dot').className = `dot ${dot}`;
    $('.label').textContent = label;

    const tracking = active() && sensor.state === 'running' && frame?.face && !paused;
    $('.smile').hidden = !(tracking && adapter && settings.likeOnSmile && focused);
    $('.meter i').style.width = `${Math.max(0, Math.min(1, smileDelta / (settings.smileThreshold * 1.5))) * 100}%`;

    const page = tracking ? gazeResult?.page : null;
    $('.gaze').hidden = !(settings.scrollWithGaze && page);
    if (page) {
      const pos = Math.max(-1.2, Math.min(1.2, page.y));
      $('.gaze').style.setProperty('--zone', `${((1.2 - settings.scrollEnter) / 2.4) * 100}%`);
      $('.gaze i').style.top = `${((pos + 1.2) / 2.4) * 100}%`;
      $('.gaze').classList.toggle('on', velocity !== 0);
    }

    // Debug: the estimated gaze point, clamped to the window edge when it's off the page.
    const debug = settings.debugGaze && !!page;
    const dotEl = $('.gdot');
    dotEl.hidden = !debug;
    $('.band.top').hidden = $('.band.bottom').hidden = !debug;
    if (debug) {
      const bandH = `${((1 - settings.scrollEnter) / 2) * 100}vh`;
      $('.band.top').style.height = $('.band.bottom').style.height = bandH;
      dotEl.style.left = `${Math.max(0, Math.min(innerWidth, ((page.x + 1) / 2) * innerWidth))}px`;
      dotEl.style.top = `${Math.max(0, Math.min(innerHeight, ((page.y + 1) / 2) * innerHeight))}px`;
      dotEl.className = `gdot ${gazeResult.zone}${velocity ? ' scrolling' : ''}`;
    }

    $('.fps').textContent = tracking ? `${fps} fps` : '';
  }

  // ---------- lifecycle ----------

  function refresh() {
    if (active()) connect(); else disconnect();
    updateFocus();
    renderHud();
  }

  function applySettings(next) {
    settings = { ...settings, ...next };
    smile.configure(settings);
    gaze.configure(settings);
    refresh();
  }

  lazyScrollSettings().then(applySettings);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !alive()) return;
    applySettings(Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.newValue ?? LAZYSCROLL_DEFAULTS[k]])));
  });
  document.addEventListener('visibilitychange', refresh);
  // Only track while this window has focus, so it never scrolls a page you aren't using.
  addEventListener('focus', refresh);
  addEventListener('blur', () => setTimeout(refresh, 0)); // let activeElement settle (focus may have moved into an iframe)
})();
