(() => {
  let settings = { ...LAZYSCROLL_DEFAULTS };
  const smile = new SmileDetector(settings);
  const gaze = new GazeScroller(settings);

  // ---------- focused tweet ----------

  let focused = null;

  function focusedState() {
    return focused?.dataset.lazyscroll;
  }

  function setState(article, state) {
    if (article && article === focused) article.dataset.lazyscroll = state;
  }

  function isLiked(article) {
    return !!article.querySelector('[data-testid="unlike"]');
  }

  // The tweet crossing the vertical middle of the viewport, else the nearest one to it.
  function pickFocused() {
    const mid = innerHeight / 2;
    let best = null, bestDist = Infinity;
    for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
      const r = a.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) continue;
      const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
      if (d < bestDist) { bestDist = d; best = a; }
    }
    return best;
  }

  function updateFocus() {
    const next = active() && settings.likeOnSmile ? pickFocused() : null;
    if (next === focused) return;
    focused?.removeAttribute('data-lazyscroll');
    focused = next;
    smile.reset();
    if (focused) focused.dataset.lazyscroll = isLiked(focused) ? 'liked' : 'baseline';
  }

  let focusRaf = 0;
  const scheduleFocus = () => {
    if (!focusRaf) focusRaf = requestAnimationFrame(() => { focusRaf = 0; updateFocus(); });
  };
  addEventListener('scroll', scheduleFocus, { passive: true });
  addEventListener('resize', scheduleFocus);
  // X recycles tweet nodes while you scroll, so re-check whenever the timeline DOM changes.
  new MutationObserver(scheduleFocus).observe(document.body, { childList: true, subtree: true });

  function like(article) {
    const btn = article.querySelector('[data-testid="like"]');
    if (!btn) return false;
    btn.click();
    return true;
  }

  // ---------- scrolling ----------

  let velocity = 0;      // px/s, + is down
  let lastFrameAt = 0;
  let scrollRaf = 0;
  let lastTick = 0;

  function scrollTick(now) {
    // Sensor went quiet (tab hidden, camera stopped): never keep scrolling blind.
    if (now - lastFrameAt > 300) velocity = 0;
    if (!velocity) { scrollRaf = 0; return; }
    const dt = Math.min(50, now - lastTick);
    lastTick = now;
    scrollBy(0, (velocity * dt) / 1000);
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
  let fps = 0, fpsCount = 0, fpsWindowStart = performance.now();

  const alive = () => !!chrome.runtime?.id; // false after the extension is reloaded/updated
  const active = () => alive() && settings.enabled && document.visibilityState === 'visible' &&
    (settings.likeOnSmile || settings.scrollWithGaze);

  function paused() {
    const el = document.activeElement;
    const typing = el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
    return typing || !!document.querySelector('[aria-modal="true"]');
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

    if (paused()) {
      velocity = 0;
      gazeResult = null;
      gaze.reset();
      smile.reset();
      return renderHud();
    }

    if (settings.scrollWithGaze || settings.debugGaze) {
      gazeResult = gaze.push(msg, screenToPage);
      velocity = settings.scrollWithGaze ? gazeResult.velocity : 0;
      if (velocity) startScrollLoop();
    }

    const state = focusedState();
    if (settings.likeOnSmile && focused && (state === 'baseline' || state === 'watching')) {
      if (velocity) {
        // Don't judge a tweet while it's moving; take a fresh baseline once scrolling stops.
        smile.reset();
        setState(focused, 'baseline');
      } else {
        const r = smile.push(msg);
        smileDelta = r.delta;
        if (r.phase === 'watching' && state === 'baseline') setState(focused, 'watching');
        if (r.fired && like(focused)) setState(focused, 'liked');
      }
    }
    renderHud();
  }

  // ---------- HUD ----------

  let smileDelta = 0;
  let gazeResult = null;
  const hudHost = document.createElement('div');
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
      .meter { width: 56px; height: 6px; border-radius: 3px; background: #333639; position: relative; overflow: hidden; }
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
    const show = settings.showHud && alive();
    if (!show) return hudHost.remove();
    if (!hudHost.isConnected) document.documentElement.append(hudHost);

    let label = 'LazyScroll', dot = '';
    if (!settings.enabled) label = 'LazyScroll off';
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
    else if (settings.scrollWithGaze && !settings.gazeModel) { dot = 'warn'; label = 'Calibrate to scroll: click'; }
    else if (paused()) { dot = 'warn'; label = 'Paused'; }
    else { dot = 'ok'; label = velocity > 0 ? 'Scrolling ↓' : velocity < 0 ? 'Scrolling ↑' : focusedState() === 'liked' ? 'Liked' : 'Watching'; }

    $('.dot').className = `dot ${dot}`;
    $('.label').textContent = label;

    const tracking = settings.enabled && sensor.state === 'running' && frame?.face;
    $('.smile').hidden = !(tracking && settings.likeOnSmile);
    $('.meter i').style.width = `${Math.max(0, Math.min(1, smileDelta / (settings.smileThreshold * 1.5))) * 100}%`;

    const page = tracking ? gazeResult?.page : null;
    $('.gaze').hidden = !(tracking && settings.scrollWithGaze && page);
    if (page) {
      const pos = Math.max(-1.2, Math.min(1.2, page.y));
      $('.gaze').style.setProperty('--zone', `${((1.2 - settings.scrollEnter) / 2.4) * 100}%`);
      $('.gaze i').style.top = `${((pos + 1.2) / 2.4) * 100}%`;
      $('.gaze').classList.toggle('on', velocity !== 0);
    }

    // Debug: the estimated gaze point, clamped to the window edge when it's off the page.
    const debug = settings.debugGaze && settings.enabled && !!page;
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

  function applySettings(next) {
    settings = { ...settings, ...next };
    smile.configure(settings);
    gaze.configure(settings);
    if (active()) connect(); else disconnect();
    updateFocus();
    renderHud();
  }

  lazyScrollSettings().then(applySettings);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !alive()) return;
    applySettings(Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.newValue ?? LAZYSCROLL_DEFAULTS[k]])));
  });
  document.addEventListener('visibilitychange', () => applySettings({}));
})();
