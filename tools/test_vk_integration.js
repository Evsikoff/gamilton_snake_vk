'use strict';

// Offline integration checks. Run: node tools/test_vk_integration.js
// Each test gets an isolated browser-like VM; no VK account/network is required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = path.join(__dirname, '..', 'js', 'vk-games.js');
const LOCAL_KEY = 'gamilton-snake-v1';
const tests = [];
function test(name, body) { tests.push({ name, body }); }
function plain(value) { return JSON.parse(JSON.stringify(value)); }
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function drain() {
  // Flush promise continuations across both the host and VM realms.
  await new Promise((resolve) => setImmediate(resolve));
}
function target(properties = {}) {
  const listeners = new Map();
  return Object.assign({
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    dispatchEvent(event) {
      for (const callback of listeners.get(event.type) || []) callback(event);
      return true;
    }
  }, properties);
}

function browser(options = {}) {
  const calls = [];
  const warnings = [];
  const cloud = options.cloud || Object.create(null);
  const local = options.local || Object.create(null);
  const subscriptions = [];
  const media = [{ muted: false }, { muted: true }];
  const attrs = Object.create(null);
  const styles = Object.create(null);
  let clock = 0;
  let timerId = 0;
  const timers = new Map();
  const document = target({
    visibilityState: 'visible', hidden: false, fullscreenElement: null,
    documentElement: {
      style: { setProperty(key, value) { styles[key] = value; } },
      setAttribute(key, value) { attrs[key] = value; },
      removeAttribute(key) { delete attrs[key]; }
    },
    body: { classList: { add() {}, remove() {}, toggle() {} } },
    querySelectorAll(selector) { return /audio|video/.test(selector) ? media : []; },
    getElementById() { return null; },
    createEvent() { return { initCustomEvent(type, bubbles, cancelable, detail) {
      Object.assign(this, { type, bubbles, cancelable, detail });
    } }; }
  });
  const context = target({
    document, navigator: {
      language: 'ru-RU', userAgent: options.mobile ? 'Android Mobile' : 'integration-test'
    },
    location: { search: options.search === undefined ? '?vk_app_id=123&vk_platform=desktop_web' : options.search,
      protocol: 'https:', hostname: 'game.example', href: 'https://game.example/' },
    URLSearchParams, URL, TextEncoder, TextDecoder, Uint8Array,
    console: { log() {}, warn(...args) { warnings.push(args); }, error(...args) { warnings.push(args); } },
    localStorage: {
      getItem(key) {
        if (options.localThrows) throw new Error('Storage is blocked');
        return Object.prototype.hasOwnProperty.call(local, key) ? local[key] : null;
      },
      setItem(key, value) {
        if (options.localThrows) throw new Error('Storage quota exhausted');
        local[key] = String(value);
      },
      removeItem(key) { delete local[key]; }
    },
    setTimeout(callback, delay = 0) {
      timers.set(++timerId, { callback, at: clock + Number(delay) });
      return timerId;
    },
    clearTimeout(id) { timers.delete(id); },
    CustomEvent: class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    Event: class Event { constructor(type) { this.type = type; } },
    innerWidth: 1024, innerHeight: 768,
    matchMedia() { return { matches: !!options.mobile, addEventListener() {}, addListener() {} }; },
    requestAnimationFrame(callback) { return context.setTimeout(callback, 16); },
    btoa(value) { return Buffer.from(value, 'binary').toString('base64'); },
    atob(value) { return Buffer.from(value, 'base64').toString('binary'); }
  });
  context.window = context;
  context.self = context;
  context.top = options.standalone ? context : {};
  context.parent = context.top;
  const harness = { context, document, local, cloud, calls, warnings, media, attrs, styles, subscriptions };
  function defaultSend(method, params) {
    if (method === 'VKWebAppStorageGet') {
      return Promise.resolve({ keys: params.keys.map((key) => ({ key, value: cloud[key] || '' })) });
    }
    if (method === 'VKWebAppStorageSet') {
      assert.equal(typeof params.value, 'string', 'VK Storage accepts strings only');
      assert(Buffer.byteLength(params.value, 'utf8') <= 4096, 'VK Storage value exceeds 4096 UTF-8 bytes');
      JSON.parse(params.value); // Every root/chunk value must be valid JSON.
      cloud[params.key] = params.value;
      return Promise.resolve({ result: true });
    }
    return Promise.resolve({ result: true });
  }
  harness.defaultSend = defaultSend;
  if (options.bridge !== false) {
    context.vkBridge = {
      send(method, params) {
        calls.push({ method, params: params === undefined ? undefined : plain(params) });
        return options.send ? options.send(method, params, harness) : defaultSend(method, params);
      },
      subscribe(callback) { subscriptions.push(callback); },
      unsubscribe(callback) { const index = subscriptions.indexOf(callback); if (index >= 0) subscriptions.splice(index, 1); },
      isWebView() { return !!options.mobile; },
      isIframe() { return !options.standalone; },
      isEmbedded() { return !options.standalone; },
      supports() { return true; },
      supportsAsync() { return Promise.resolve(true); }
    };
  }
  if (options.fullscreen !== false) {
    document.fullscreenEnabled = true;
    document.documentElement.requestFullscreen = () => {
      calls.push({ method: 'html.requestFullscreen', userActivation: !!harness.userActivation });
      if (options.fullscreenReject) return Promise.reject(new Error('Fullscreen denied'));
      document.fullscreenElement = document.documentElement;
      document.dispatchEvent({ type: 'fullscreenchange' });
      return Promise.resolve();
    };
    document.exitFullscreen = () => {
      calls.push({ method: 'html.exitFullscreen' });
      document.fullscreenElement = null;
      document.dispatchEvent({ type: 'fullscreenchange' });
      return Promise.resolve();
    };
  }
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(SOURCE, 'utf8'), context, { filename: SOURCE });
  harness.api = context.VKGames;
  assert(harness.api, 'adapter must export window.VKGames');
  harness.emit = (type, data = {}) => {
    for (const callback of subscriptions) callback({ detail: { type, data } });
  };
  harness.visibility = (hidden) => {
    document.hidden = hidden;
    document.visibilityState = hidden ? 'hidden' : 'visible';
    document.dispatchEvent({ type: 'visibilitychange' });
  };
  harness.advance = async (milliseconds) => {
    const end = clock + milliseconds;
    await drain();
    for (let guard = 0; guard < 1000; guard++) {
      const next = [...timers].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) { clock = end; return; }
      const [id, timer] = next;
      clock = timer.at;
      timers.delete(id);
      timer.callback();
      await drain();
    }
    throw new Error('Runaway timer loop');
  };
  harness.count = (method) => calls.filter((call) => call.method === method).length;
  harness.hooks = () => {
    const events = [];
    harness.api.registerLifecycleHooks(Object.fromEntries(['pause', 'resume', 'mute', 'unmute'].map((name) => [name,
      () => { events.push(name); calls.push({ method: 'hook.' + name }); }])));
    return events;
  };
  return harness;
}

test('initializes Bridge once and loads legacy string JSON before local progress', async () => {
  const cloudProgress = { unlocked: 4, score: 440, paths: {}, closed: {} };
  const h = browser({ local: { [LOCAL_KEY]: JSON.stringify({ unlocked: 2, score: 20 }) },
    cloud: { gameState: JSON.stringify(cloudProgress) } });
  const first = h.api.init();
  const second = h.api.init();
  const [state, sameState] = await Promise.all([first, second]);
  assert.equal(h.count('VKWebAppInit'), 1);
  assert.deepEqual(plain(state.initialData), cloudProgress);
  assert.deepEqual(plain(sameState.initialData), cloudProgress);
  assert.deepEqual(JSON.parse(h.local[LOCAL_KEY]), cloudProgress);
  assert.equal(state.sdkAvailable, true);
  assert(h.subscriptions.length > 0, 'configuration/lifecycle events must be subscribed');
});

test('works locally with a missing Bridge and blocked localStorage', async () => {
  const h = browser({ bridge: false, standalone: true, search: '', localThrows: true });
  const state = await h.api.init();
  assert.deepEqual(plain(state.initialData), {});
  assert.equal(state.sdkAvailable, false);
  const value = { score: 53, unlocked: 2 };
  await h.api.saveProgress(value, true);
  assert.deepEqual(plain(h.api.getProgress()), value, 'in-memory progress survives blocked localStorage');
  assert.equal(h.api.canShowAds(), false);
  assert.equal(h.api.showRewardedAd({ onRewarded() { assert.fail('offline reward'); } }), false);
});

test('CDN Bridge present on a standalone page cannot hang startup or advertise', async () => {
  const h = browser({ standalone: true, search: '', local: { [LOCAL_KEY]: '{"score":77}' },
    send() { return new Promise(() => {}); } });
  const pending = h.api.init();
  await h.advance(10000);
  const state = await pending;
  assert.equal(state.initialData.score, 77);
  assert.equal(h.api.canShowAds(), false);
  assert.equal(h.count('VKWebAppStorageGet'), 0);
});

for (const failure of ['reject', 'throw', 'false', 'hang']) {
  test('Bridge initialization ' + failure + ' preserves local progress', async () => {
    const h = browser({ local: { [LOCAL_KEY]: '{"score":91}' }, send(method, params, host) {
      if (method !== 'VKWebAppInit') return host.defaultSend(method, params);
      if (failure === 'reject') return Promise.reject(new Error('Disconnected'));
      if (failure === 'throw') throw new Error('Unsupported transport');
      if (failure === 'false') return Promise.resolve({ result: false });
      return new Promise(() => {});
    } });
    const pending = h.api.init();
    if (failure === 'hang') await h.advance(10000);
    const state = await pending;
    assert.equal(state.initialData.score, 91);
    assert.equal(h.api.canShowAds(), false);
    assert.equal(h.count('VKWebAppStorageGet'), 0);
  });
}

for (const raw of ['{broken JSON', 'null', '[]', '"string"']) {
  test('malformed cloud progress falls back to local: ' + raw, async () => {
    const h = browser({ cloud: { gameState: raw }, local: { [LOCAL_KEY]: '{"score":123,"unlocked":3}' } });
    assert.equal((await h.api.init()).initialData.score, 123);
  });
}

test('cloud read failure preserves local saves without overwriting an unknown cloud snapshot', async () => {
  const h = browser({ local: { [LOCAL_KEY]: '{"score":17}' }, send(method, params, host) {
    if (method === 'VKWebAppStorageGet') return Promise.reject(new Error('Storage temporarily offline'));
    return host.defaultSend(method, params);
  } });
  assert.equal((await h.api.init()).initialData.score, 17);
  assert.equal(await h.api.saveProgress({ score: 18 }, true), false);
  assert.equal(JSON.parse(h.local[LOCAL_KEY]).score, 18);
  assert.equal(h.api.getProgress().score, 18);
  assert.equal(h.count('VKWebAppStorageSet'), 0);
});

test('a hanging cloud read has a bounded startup fallback', async () => {
  const h = browser({ local: { [LOCAL_KEY]: '{"score":87}' }, send(method, params, host) {
    return method === 'VKWebAppStorageGet' ? new Promise(() => {}) : host.defaultSend(method, params);
  } });
  const pending = h.api.init();
  await h.advance(10000);
  assert.equal((await pending).initialData.score, 87);
  assert.equal(h.api.getProgress().score, 87);
});

test('progress edited during startup wins over the older cloud snapshot', async () => {
  const read = deferred();
  const h = browser({ send(method, params, host) {
    return method === 'VKWebAppStorageGet' ? read.promise : host.defaultSend(method, params);
  } });
  const pending = h.api.init();
  await drain();
  const recent = { score: 88, unlocked: 3, updatedAt: 200, paths: { 0: '3,4,5' } };
  await h.api.saveProgress(recent, false);
  read.resolve({ keys: [{ key: 'gameState', value: JSON.stringify({
    score: 10, unlocked: 1, updatedAt: 100, paths: { 0: '0,1,2' }
  }) }] });
  assert.deepEqual(plain((await pending).initialData), { ...recent, closed: {} });
  await h.api.flushProgress();
  assert.equal((await browser({ cloud: h.cloud }).api.init()).initialData.paths[0], recent.paths[0]);
});

function fullProgress() {
  const solutions = JSON.parse(fs.readFileSync(path.join(__dirname, 'solutions.json'), 'utf8'));
  const progress = { score: 12345, unlocked: 8, paths: {}, closed: {}, note: 'Прогресс 🐍'.repeat(350) };
  for (let i = 0; i < 8; i++) {
    assert(Array.isArray(solutions[i + 1]), 'all eight full level solutions must be present');
    progress.paths[i] = solutions[i + 1].map(([x, y]) => y * 40 + x).join(',');
    progress.closed[i] = 1;
  }
  return progress;
}

test('all eight full paths and Unicode round-trip through JSON values <= 4096 bytes', async () => {
  const cloud = Object.create(null);
  const h = browser({ cloud });
  await h.api.init();
  const progress = fullProgress();
  assert(Buffer.byteLength(JSON.stringify(progress)) > 4096, 'fixture must exercise chunking');
  assert.equal(await h.api.saveProgress(progress, true), true);
  const writes = h.calls.filter((call) => call.method === 'VKWebAppStorageSet');
  assert(writes.length > 2, 'large progress requires several keys');
  assert.equal(writes.at(-1).params.key, 'gameState', 'manifest is committed after all chunks');
  const manifest = JSON.parse(cloud.gameState);
  assert.equal(manifest.format, 'gamilton-snake-chunks-v1');
  assert(manifest.count > 1);
  const restored = browser({ cloud, localThrows: true });
  assert.deepEqual(plain((await restored.api.init()).initialData), progress);
  assert.deepEqual(plain(restored.api.getProgress()), progress);
});

test('missing or corrupted cloud chunks cannot overwrite valid local progress', async () => {
  const original = browser();
  await original.api.init();
  await original.api.saveProgress(fullProgress(), true);
  const manifest = JSON.parse(original.cloud.gameState);
  const key = 'gameState_' + manifest.slot + '_0';
  for (const replacement of ['', JSON.stringify('tampered but still JSON')]) {
    const cloud = { ...original.cloud, [key]: replacement };
    const h = browser({ cloud, local: { [LOCAL_KEY]: '{"score":456}' } });
    assert.equal((await h.api.init()).initialData.score, 456);
    assert.equal(JSON.parse(h.local[LOCAL_KEY]).score, 456);
  }
});

test('failed chunk write leaves the previously committed cloud snapshot readable', async () => {
  let fail = false;
  const h = browser({ send(method, params, host) {
    if (fail && method === 'VKWebAppStorageSet' && params.key !== 'gameState') {
      return Promise.reject(new Error('Interrupted chunk upload'));
    }
    return host.defaultSend(method, params);
  } });
  await h.api.init();
  const previous = { score: 101, paths: { 0: '0,1,2,3' } };
  assert.equal(await h.api.saveProgress(previous, true), true);
  const rootBefore = h.cloud.gameState;
  fail = true;
  assert.equal(await h.api.saveProgress(fullProgress(), true), false);
  assert.equal(h.cloud.gameState, rootBefore);
  const reader = browser({ cloud: h.cloud });
  assert.deepEqual(plain((await reader.api.init()).initialData), previous);
});

test('an older failing save cannot replace a newer queued snapshot', async () => {
  const failedWrite = deferred();
  let intercepted = false;
  const h = browser({ send(method, params, host) {
    if (method === 'VKWebAppStorageSet' && !intercepted) {
      intercepted = true;
      return failedWrite.promise;
    }
    return host.defaultSend(method, params);
  } });
  await h.api.init();
  const old = h.api.saveProgress({ score: 1, unlocked: 1 }, true);
  await drain();
  assert.equal(intercepted, true);
  const latest = { score: 999, unlocked: 8, paths: { 0: '0,1,2,3' } };
  await h.api.saveProgress(latest, false);
  failedWrite.reject(new Error('Older save failed'));
  await old;
  await h.advance(10000);
  await h.api.flushProgress();
  assert.deepEqual(plain(h.api.getProgress()), latest);
  const reader = browser({ cloud: h.cloud });
  assert.deepEqual(plain((await reader.api.init()).initialData), latest);
  assert.deepEqual(JSON.parse(h.local[LOCAL_KEY]), latest);
});

test('saving progress snapshots data and coalesces rapid debounced updates', async () => {
  const h = browser();
  await h.api.init();
  const mutable = { score: 1, paths: { 0: '0,1,2' } };
  await h.api.saveProgress(mutable, false);
  mutable.paths[0] = 'mutated outside adapter';
  assert.equal(h.api.getProgress().paths[0], '0,1,2');
  await h.api.saveProgress({ score: 2 }, false);
  await h.api.saveProgress({ score: 3 }, false);
  await h.advance(10000);
  assert.equal(h.calls.filter((call) => call.method === 'VKWebAppStorageSet' && call.params.key === 'gameState').length, 1);
  assert.equal((await browser({ cloud: h.cloud }).api.init()).initialData.score, 3);
});

for (const ad of [{ method: 'showRewardedAd', format: 'reward' }, { method: 'showFullscreenAd', format: 'interstitial' }]) {
  for (const outcome of ['success', 'false', 'cancel', 'reject', 'throw']) {
    test(ad.format + ' ad ' + outcome + ': one close, correct reward, pause/audio restored', async () => {
      const h = browser({ send(method, params, host) {
        if (method !== 'VKWebAppShowNativeAds') return host.defaultSend(method, params);
        assert.equal(params.ad_format, ad.format);
        if (outcome === 'throw') throw new Error('Native transport threw');
        if (outcome === 'cancel' || outcome === 'reject') return Promise.reject(new Error(outcome));
        return Promise.resolve({ result: outcome === 'success' });
      } });
      await h.api.init();
      const events = h.hooks();
      let reward = 0, closes = 0, shown;
      h.api.startGameplay();
      assert.equal(h.api[ad.method]({
        onRewarded() { reward++; }, onClose(value) { closes++; shown = value; }
      }), true);
      await drain();
      assert.equal(reward, ad.format === 'reward' && outcome === 'success' ? 1 : 0);
      assert.equal(closes, 1);
      assert.equal(shown, outcome === 'success');
      assert.equal(events.filter((name) => name === 'pause').length, 1);
      assert.equal(events.filter((name) => name === 'resume').length, 1);
      assert.equal(events.filter((name) => name === 'mute').length, 1);
      assert.equal(events.filter((name) => name === 'unmute').length, 1);
      assert.deepEqual(h.media.map((element) => element.muted), [false, true]);
      const adIndex = h.calls.findIndex((call) => call.method === 'VKWebAppShowNativeAds');
      for (const hook of ['pause', 'mute']) {
        assert(h.calls.findIndex((call) => call.method === 'hook.' + hook) < adIndex, hook + ' must precede native ad');
      }
    });
  }
}

test('startup preloads both ad formats so the first show is not answered with an empty slot', async () => {
  const h = browser();
  await h.api.init();
  const checks = h.calls.filter((call) => call.method === 'VKWebAppCheckNativeAds');
  assert.deepEqual(checks.map((call) => call.params.ad_format).sort(), ['interstitial', 'reward']);
  assert(checks.every((call) => call.params.use_waterfall === true), 'waterfall widens ad fill');
  assert.deepEqual(plain(h.api.adStatus()), { interstitial: true, reward: true });
});

test('method support is probed with supportsAsync, never the deprecated supports', async () => {
  const h = browser();
  let deprecated = 0;
  const asked = [];
  h.context.vkBridge.supports = () => { deprecated++; return true; };
  h.context.vkBridge.supportsAsync = (name) => { asked.push(name); return Promise.resolve(true); };
  await h.api.init();
  await drain();
  for (let i = 0; i < 12; i++) h.api.canShowAds();
  assert.equal(deprecated, 0, 'bridge.supports is deprecated and must stay unused');
  assert.deepEqual(asked.sort(), ['VKWebAppCheckNativeAds', 'VKWebAppShowNativeAds']);
  assert.equal(h.api.canShowAds(), true);
});

test('a client without native ads turns the buttons off instead of failing on click', async () => {
  const h = browser();
  const announced = [];
  h.context.addEventListener('vkplatformchange', () => announced.push(1));
  h.context.vkBridge.supportsAsync = (name) => Promise.resolve(name !== 'VKWebAppShowNativeAds');
  await h.api.init();
  await drain();
  assert.equal(h.api.canShowAds(), false);
  assert.equal(h.api.showRewardedAd({}), false);
  assert.equal(announced.length, 1, 'the game needs one nudge to redraw the level strip');
});

test('an ad refused immediately is preloaded and retried exactly once', async () => {
  let attempts = 0;
  const h = browser({ send(method, params, host) {
    if (method !== 'VKWebAppShowNativeAds') return host.defaultSend(method, params);
    attempts++;
    return attempts === 1 ? Promise.reject(new Error('Ad is not ready')) : Promise.resolve({ result: true });
  } });
  await h.api.init();
  let reward = 0, closes = 0, shown;
  h.api.showRewardedAd({ onRewarded() { reward++; }, onClose(value) { closes++; shown = value; } });
  await drain();
  assert.equal(attempts, 2, 'a refusal with no ad loaded deserves one more try');
  assert.equal(reward, 1);
  assert.equal(closes, 1);
  assert.equal(shown, true);
  const retryCheck = h.calls.findIndex((call) => call.method === 'VKWebAppCheckNativeAds' &&
    h.calls.indexOf(call) > h.calls.findIndex((first) => first.method === 'VKWebAppShowNativeAds'));
  assert(retryCheck >= 0, 'the retry must ask the client to load a clip first');
});

test('an empty ad network is reported in Russian and not asked twice', async () => {
  let attempts = 0;
  const h = browser({ send(method, params, host) {
    if (method !== 'VKWebAppShowNativeAds') return host.defaultSend(method, params);
    attempts++;
    return Promise.reject({ error_type: 'client_error', error_data: { error_code: 20, error_reason: 'No ads' } });
  } });
  await h.api.init();
  let failure = '', closes = 0;
  h.api.showRewardedAd({ onError(error) { failure = h.api.describeError(error); }, onClose() { closes++; } });
  await drain();
  assert.equal(attempts, 1, 'the network has nothing to serve; a retry cannot change that');
  assert.equal(closes, 1);
  assert.equal(failure, 'сейчас нет подходящей рекламы');
});

test('an ad the player closes after watching is never restarted', async () => {
  const ad = deferred();
  let attempts = 0;
  const h = browser({ send(method, params, host) {
    if (method !== 'VKWebAppShowNativeAds') return host.defaultSend(method, params);
    attempts++;
    return ad.promise;
  } });
  await h.api.init();
  let closes = 0, shown;
  h.api.showRewardedAd({ onClose(value) { closes++; shown = value; } });
  await h.advance(30000); // Ролик шёл: отказ приходит уже вне окна повтора.
  ad.reject(new Error('User closed the ad'));
  await drain();
  assert.equal(attempts, 1);
  assert.equal(closes, 1);
  assert.equal(shown, false);
});

test('a client too slow for the first handshake still gets ads and cloud saves', async () => {
  let handshakes = 0;
  const h = browser({ local: { [LOCAL_KEY]: '{"score":64}' }, send(method, params, host) {
    if (method !== 'VKWebAppInit') return host.defaultSend(method, params);
    return ++handshakes === 1 ? new Promise(() => {}) : Promise.resolve({ result: true });
  } });
  const announced = [];
  h.context.addEventListener('vkplatformchange', (event) => announced.push(event.detail));
  const pending = h.api.init();
  await h.advance(3000); // Первое ожидание истекло, повтор ещё не ушёл.
  const state = await pending;
  assert.equal(state.sdkAvailable, false, 'startup must not wait for a stalled client');
  assert.equal(state.initialData.score, 64);
  assert.equal(h.api.canShowAds(), false);
  await h.advance(10000);
  assert.equal(h.api.canShowAds(), true, 'a late VKWebAppInit must re-enable advertising');
  assert.deepEqual(plain(announced), [{ sdkAvailable: true }]);
  assert.equal(h.count('VKWebAppStorageGet'), 1);
  assert.equal(h.api.showRewardedAd({}), true);
});

test('a client that never answers stops retrying the handshake', async () => {
  const h = browser({ send(method, params, host) {
    return method === 'VKWebAppInit' ? Promise.reject(new Error('Disconnected')) : host.defaultSend(method, params);
  } });
  await h.api.init();
  await h.advance(120000);
  assert.equal(h.count('VKWebAppInit'), 4, 'one handshake plus a bounded number of retries');
  assert.equal(h.api.canShowAds(), false);
});

test('ad lock rejects overlap and visibility keeps gameplay/audio paused after ad closes', async () => {
  const ad = deferred();
  const h = browser({ send(method, params, host) {
    return method === 'VKWebAppShowNativeAds' ? ad.promise : host.defaultSend(method, params);
  } });
  await h.api.init();
  const events = h.hooks();
  let reward = 0, close = 0;
  assert.equal(h.api.showRewardedAd({ onRewarded() { reward++; }, onClose() { close++; } }), true);
  assert.equal(h.api.showFullscreenAd({}), false);
  assert.equal(h.count('VKWebAppShowNativeAds'), 1);
  h.visibility(true);
  ad.resolve({ result: true });
  await drain();
  assert.equal(reward, 1);
  assert.equal(close, 1);
  assert.equal(events.includes('resume'), false);
  assert.deepEqual(h.media.map((element) => element.muted), [true, true]);
  h.visibility(false);
  assert.equal(events.filter((name) => name === 'resume').length, 1);
  assert.deepEqual(h.media.map((element) => element.muted), [false, true]);
});

test('throwing application ad callbacks cannot strand the pause or duplicate a reward', async () => {
  const h = browser();
  await h.api.init();
  const events = h.hooks();
  let rewards = 0, closes = 0;
  h.api.showRewardedAd({
    onRewarded() { rewards++; throw new Error('UI reward callback failed'); },
    onClose() { closes++; throw new Error('UI close callback failed'); }
  });
  await drain();
  assert.equal(rewards, 1);
  assert.equal(closes, 1);
  assert.equal(events.filter((name) => name === 'resume').length, 1);
  assert.deepEqual(h.media.map((element) => element.muted), [false, true]);
  assert.equal(h.api.showFullscreenAd({}), true, 'ad lock must be released');
  await drain();
});

test('a timed-out ad restores gameplay and ignores late reward delivery', async () => {
  const pendingAd = deferred();
  const h = browser({ send(method, params, host) {
    return method === 'VKWebAppShowNativeAds' ? pendingAd.promise : host.defaultSend(method, params);
  } });
  await h.api.init();
  const events = h.hooks();
  let rewards = 0, closes = 0;
  h.api.showRewardedAd({ onRewarded() { rewards++; }, onClose(shown) { assert.equal(shown, false); closes++; } });
  await h.advance(120001);
  assert.equal(closes, 1);
  assert.equal(events.filter((name) => name === 'resume').length, 1);
  assert.deepEqual(h.media.map((element) => element.muted), [false, true]);
  pendingAd.resolve({ result: true });
  await drain();
  assert.equal(rewards, 0);
  assert.equal(closes, 1);
});

test('platform hide flushes pending progress and overlapping visibility delays resume', async () => {
  const h = browser();
  await h.api.init();
  const events = h.hooks();
  await h.api.saveProgress({ score: 72 }, false);
  h.emit('VKWebAppViewHide');
  await drain();
  assert(h.count('VKWebAppStorageSet') > 0, 'platform hide should flush without waiting for debounce');
  h.visibility(true);
  h.emit('VKWebAppViewRestore');
  assert.equal(events.includes('resume'), false);
  h.visibility(false);
  assert.equal(events.filter((name) => name === 'pause').length, 1);
  assert.equal(events.filter((name) => name === 'resume').length, 1);
  assert.deepEqual(h.media.map((element) => element.muted), [false, true]);
});

test('desktop fullscreen is invoked during the user gesture and tracks browser exit', async () => {
  const h = browser();
  await h.api.init();
  assert.equal(h.api.fullscreen.available(), true);
  assert.equal(h.api.fullscreen.status(), false);
  h.userActivation = true;
  const pending = h.api.fullscreen.request();
  h.userActivation = false;
  const request = h.calls.find((call) => call.method === 'html.requestFullscreen');
  assert(request, 'requestFullscreen must run synchronously before user activation is lost');
  assert.equal(request.userActivation, true);
  await pending;
  assert.equal(h.api.fullscreen.status(), true);
  await h.api.fullscreen.exit();
  assert.equal(h.api.fullscreen.status(), false);
  assert.equal(h.count('html.exitFullscreen'), 1);
});

test('fullscreen rejection is handled without marking an inactive browser fullscreen', async () => {
  const h = browser({ fullscreenReject: true });
  await h.api.init();
  await h.api.fullscreen.request();
  assert.equal(h.api.fullscreen.status(), false);
});

test('mobile view styling and configuration updates expose viewport/safe-area data', async () => {
  const h = browser({ mobile: true, search: '?vk_app_id=123&vk_platform=mobile_android' });
  const updates = [];
  h.context.addEventListener('vkconfigchange', (event) => updates.push(event.detail));
  await h.api.init();
  assert(h.count('VKWebAppSetViewSettings') >= 1, 'mobile view styling should be configured');
  const config = { viewport_width: 390, viewport_height: 844, insets: { top: 24, bottom: 34, left: 0, right: 0 } };
  h.emit('VKWebAppUpdateConfig', config);
  const received = h.api.getConfig();
  assert.equal(received.viewport_width, 390);
  assert.equal(received.viewport_height, 844);
  assert.equal(received.insets.bottom, 34);
  assert.equal(h.styles['--vk-inset-bottom'], '34px');
  assert.equal(h.styles['--vk-viewport-height'], '844px');
  assert(updates.length > 0, 'game UI must receive configuration changes');
});

test('native mobile fullscreen requests need configuration evidence before reporting active', async () => {
  const h = browser({ mobile: true, fullscreen: false, search: '?vk_app_id=123&vk_platform=mobile_android' });
  await h.api.init();
  const fullscreenEvents = [];
  h.context.addEventListener('vkfullscreenchange', (event) => fullscreenEvents.push(event.detail.fullscreen));
  await h.api.fullscreen.request();
  assert(h.calls.some((call) => call.method === 'VKWebAppSetViewSettings' && call.params.fullscreen === true));
  assert.equal(h.api.fullscreen.status(), false, 'view-style success alone is not proof of fullscreen');
  h.emit('VKWebAppUpdateConfig', { fullscreen: true });
  assert.equal(h.api.fullscreen.status(), true);
  assert.equal(fullscreenEvents.at(-1), true);
  await h.api.fullscreen.exit();
  assert(h.calls.some((call) => call.method === 'VKWebAppSetViewSettings' && call.params.fullscreen === false));
  h.emit('VKWebAppUpdateConfig', { fullscreen: false });
  assert.equal(h.api.fullscreen.status(), false);
});

(async function run() {
  let failed = 0;
  for (const { name, body } of tests) {
    let watchdog;
    try {
      await Promise.race([body(), new Promise((resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error('Test did not settle within 3 seconds')), 3000);
      })]);
      console.log('OK  ' + name);
    } catch (error) {
      failed++;
      console.error('FAIL ' + name + '\n' + (error.stack || error));
    } finally { clearTimeout(watchdog); }
  }
  console.log('\nVK Bridge integration: ' + (tests.length - failed) + '/' + tests.length + ' passed');
  if (failed) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
