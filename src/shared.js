// Loaded by every context (service worker, offscreen page, settings page, content script).
globalThis.AUTOLIKE_DEFAULTS = {
  apiKey: '',
  apiBase: 'https://api.openai.com/v1',
  model: 'gpt-6-luna',
  enabled: true,
  threshold: 0.9,       // like when P(expression changed) >= this
  dwellMs: 120,         // how long a tweet must stay centred before the baseline is taken
  intervalMs: 200,      // minimum gap between decision requests for the same tweet
  maxInFlight: 2,       // overlapping requests per tweet, hides network latency
  maxChecks: 25,        // give up on a tweet after this many API calls
  motionGate: 1.5,      // skip the API call when the face crop barely moved (0 = always call)
  cropFraction: 0.6,    // centre square of the webcam frame to send, as a fraction of its height
  imageSize: 224,       // px, side of the square JPEG sent to the API
  showHud: true,
};

globalThis.autolikeSettings = async function () {
  const stored = await chrome.storage.local.get(Object.keys(AUTOLIKE_DEFAULTS));
  return { ...AUTOLIKE_DEFAULTS, ...stored };
};
