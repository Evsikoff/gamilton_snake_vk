// VK Bridge is isolated from the game so the same build also works offline.
(function (global) {
  'use strict';

  var STORE_KEY = 'gamilton-snake-v1';
  var CLOUD_KEY = 'gameState';
  var CLOUD_FORMAT = 'gamilton-snake-chunks-v1';
  var MAX_VALUE_BYTES = 4096;
  var MAX_CHUNKS = 128;
  var CLOUD_SAVE_DELAY = 1200;
  var REQUEST_TIMEOUT = 5000;
  var INIT_TIMEOUT = 2500;
  var INIT_RETRY_TIMEOUT = 8000;
  var INIT_RETRIES = 3;
  var INIT_RETRY_DELAY = 1500;
  var AD_TIMEOUT = 120000;
  var AD_CHECK_TIMEOUT = 4000;
  // Отказ быстрее этого срока означает «ролика не было»: посмотреть или закрыть
  // рекламу за такое время игрок не успел бы.
  var AD_RETRY_WINDOW = 2500;
  var AD_FORMATS = ['interstitial', 'reward'];
  var bridge = null;
  var initPromise = null;
  var memoryData = null;
  var storageReady = false;
  var cloudSlot = 'b';
  var cloudTimer = 0;
  var pendingSave = null;
  var saveSequence = 0;
  var cloudChain = Promise.resolve(false);
  var adInProgress = false;
  var adReady = { interstitial: false, reward: false };
  var pauseReasons = {};
  var muteReasons = {};
  var mutedMedia = [];
  var config = {};
  var nativeFullscreen = false;
  var hooks = {};
  var params = new URLSearchParams(global.location.search || '');
  var environment = {
    language: String(params.get('vk_language') || 'ru').slice(0, 2).toLowerCase(),
    browserLanguage: (navigator.language || 'ru').slice(0, 2).toLowerCase(),
    deviceType: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
    appId: params.get('vk_app_id') || '',
    client: params.get('vk_client') || 'vk',
    isOdnoklassniki: params.get('vk_client') === 'ok',
    platform: params.get('vk_platform') || '',
    sdkAvailable: false
  };

  function isObject(data) { return !!data && typeof data === 'object' && !Array.isArray(data); }
  function clone(data) { return JSON.parse(JSON.stringify(data)); }
  function hasData(data) { return isObject(data) && Object.keys(data).length > 0; }
  function warn(message, error) { console.warn('VK: ' + message, error || ''); }
  function callback(target, name, value) {
    try { if (typeof target[name] === 'function') target[name](value); }
    catch (error) { console.error('VK: ошибка обработчика ' + name, error); }
  }

  function getProgress() {
    if (memoryData !== null) return clone(memoryData);
    try {
      var raw = localStorage.getItem(STORE_KEY);
      var data = raw ? JSON.parse(raw) : {};
      memoryData = isObject(data) ? data : {};
    } catch (error) { memoryData = {}; }
    return clone(memoryData);
  }

  function writeLocal(data) {
    memoryData = clone(data);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); }
    catch (error) { /* The in-memory copy still retains every level in private mode. */ }
  }

  function bridgeFlag(name) {
    try { return !!(bridge && typeof bridge[name] === 'function' && bridge[name]()); }
    catch (error) { return false; }
  }

  function isEmbedded() {
    return bridgeFlag('isEmbedded') || bridgeFlag('isWebView') || bridgeFlag('isIframe') ||
      global.parent !== global || !!environment.appId;
  }

  function isNativeMobile() {
    return environment.sdkAvailable && (bridgeFlag('isWebView') ||
      /^mobile_(android|iphone|ipad)/.test(environment.platform));
  }

  // Bound platform calls: the CDN also loads in ordinary browsers, where Init
  // otherwise waits forever for a platform parent that does not exist.
  function send(method, data, timeout) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        var error = new Error(method + ': превышено время ожидания');
        error.code = 'VK_ADAPTER_TIMEOUT';
        reject(error);
      }, timeout || REQUEST_TIMEOUT);
      var request;
      try { request = bridge.send(method, data || {}); }
      catch (error) { clearTimeout(timer); reject(error); return; }
      Promise.resolve(request).then(function (response) {
        clearTimeout(timer);
        resolve(response);
      }, function (error) {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function requireSuccess(data, method) {
    if (!data || data.result !== true) throw new Error(method + ': операция не подтверждена');
    return data;
  }

  function setPauseReason(reason, paused) {
    var wasPaused = Object.keys(pauseReasons).length > 0;
    if (paused) pauseReasons[reason] = true;
    else delete pauseReasons[reason];
    var isPaused = Object.keys(pauseReasons).length > 0;
    if (!wasPaused && isPaused) callback(hooks, 'pause', reason);
    if (wasPaused && !isPaused) callback(hooks, 'resume', reason);
  }

  function setMuteReason(reason, muted) {
    var wasMuted = Object.keys(muteReasons).length > 0;
    if (muted) muteReasons[reason] = true;
    else delete muteReasons[reason];
    var isMuted = Object.keys(muteReasons).length > 0;
    if (!wasMuted && isMuted) {
      mutedMedia = [];
      var media = document.querySelectorAll('audio, video');
      for (var i = 0; i < media.length; i++) {
        mutedMedia.push({ element: media[i], muted: media[i].muted });
        media[i].muted = true;
      }
      callback(hooks, 'mute');
    } else if (wasMuted && !isMuted) {
      for (var j = 0; j < mutedMedia.length; j++) {
        mutedMedia[j].element.muted = mutedMedia[j].muted;
      }
      mutedMedia = [];
      callback(hooks, 'unmute');
    }
  }

  function emit(name, detail) {
    global.dispatchEvent(new CustomEvent(name, { detail: detail }));
  }

  function fullscreenStatus() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement || nativeFullscreen);
  }

  function notifyFullscreen() {
    var fullscreen = fullscreenStatus();
    callback(hooks, 'fullscreen', fullscreen);
    emit('vkfullscreenchange', { fullscreen: fullscreen });
  }

  function updateConfig(next) {
    if (!isObject(next)) return;
    Object.keys(next).forEach(function (key) { config[key] = next[key]; });
    var root = document.documentElement;
    if (next.insets && isObject(next.insets)) {
      ['top', 'right', 'bottom', 'left'].forEach(function (side) {
        var value = next.insets[side];
        if (typeof value === 'number' && isFinite(value)) {
          root.style.setProperty('--vk-inset-' + side, Math.max(0, value) + 'px');
        }
      });
    }
    ['width', 'height'].forEach(function (axis) {
      var value = next['viewport_' + axis];
      if (typeof value === 'number' && isFinite(value) && value > 0) {
        root.style.setProperty('--vk-viewport-' + axis, value + 'px');
      }
    });
    if (next.appearance === 'light' || next.appearance === 'dark') {
      root.setAttribute('data-vk-appearance', next.appearance);
    }
    // This field is not promised by current Bridge types. Observe it only when
    // a client actually supplies it; result:true for view colors is not proof.
    if (typeof next.fullscreen === 'boolean') {
      nativeFullscreen = next.fullscreen;
      notifyFullscreen();
    }
    var snapshot = clone(config);
    callback(hooks, 'config', snapshot);
    emit('vkconfigchange', snapshot);
  }

  function subscribe() {
    if (typeof bridge.subscribe !== 'function') return;
    bridge.subscribe(function (event) {
      var detail = event && event.detail;
      if (!detail) return;
      if (detail.type === 'VKWebAppUpdateConfig' || detail.type === 'VKWebAppUpdateInsets') {
        updateConfig(detail.data);
      } else if (detail.type === 'VKWebAppViewHide') {
        setPauseReason('platform', true);
        setMuteReason('platform', true);
        flushProgress();
      } else if (detail.type === 'VKWebAppViewRestore') {
        setMuteReason('platform', false);
        setPauseReason('platform', false);
      }
    });
  }

  function byteLength(value) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
    return unescape(encodeURIComponent(value)).length;
  }

  function checksum(value) {
    var hash = 2166136261;
    for (var i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function splitSnapshot(json) {
    var chunks = [];
    for (var offset = 0; offset < json.length;) {
      var low = 1;
      var high = Math.min(json.length - offset, MAX_VALUE_BYTES);
      var size = 0;
      while (low <= high) {
        var middle = Math.floor((low + high) / 2);
        if (byteLength(JSON.stringify(json.slice(offset, offset + middle))) <= MAX_VALUE_BYTES) {
          size = middle;
          low = middle + 1;
        } else high = middle - 1;
      }
      if (!size || chunks.length >= MAX_CHUNKS) throw new Error('Прогресс слишком велик для VK Storage');
      chunks.push(JSON.stringify(json.slice(offset, offset + size)));
      offset += size;
    }
    return chunks;
  }

  function getValues(keys) {
    return send('VKWebAppStorageGet', { keys: keys }).then(function (data) {
      if (!data || !Array.isArray(data.keys)) throw new Error('Некорректный ответ VK Storage');
      var values = Object.create(null);
      data.keys.forEach(function (entry) {
        if (entry && typeof entry.key === 'string' && typeof entry.value === 'string') {
          values[entry.key] = entry.value;
        }
      });
      return values;
    });
  }

  function loadCloud() {
    return getValues([CLOUD_KEY]).then(function (values) {
      if (!Object.prototype.hasOwnProperty.call(values, CLOUD_KEY)) {
        throw new Error('VK Storage не вернул запрошенный ключ');
      }
      if (!values[CLOUD_KEY]) return {};
      var manifest = JSON.parse(values[CLOUD_KEY]);
      if (!isObject(manifest)) throw new Error('Некорректный прогресс VK Storage');
      if (manifest.format !== CLOUD_FORMAT) return manifest; // Legacy whole JSON object.
      if (!/^[ab]$/.test(manifest.slot) || !Number.isInteger(manifest.count) ||
          manifest.count < 1 || manifest.count > MAX_CHUNKS || typeof manifest.checksum !== 'string') {
        throw new Error('Некорректный индекс частей VK Storage');
      }
      var keys = [];
      for (var i = 0; i < manifest.count; i++) keys.push(CLOUD_KEY + '_' + manifest.slot + '_' + i);
      return getValues(keys).then(function (parts) {
        var json = keys.map(function (key) {
          if (!parts[key]) throw new Error('В VK Storage отсутствует часть сохранения');
          var chunk = JSON.parse(parts[key]);
          if (typeof chunk !== 'string') throw new Error('Повреждена часть сохранения VK Storage');
          return chunk;
        }).join('');
        if (checksum(json) !== manifest.checksum) throw new Error('Неполное сохранение VK Storage');
        var data = JSON.parse(json);
        if (!isObject(data)) throw new Error('Некорректные данные сохранения VK Storage');
        cloudSlot = manifest.slot;
        return data;
      });
    });
  }

  function mergeProgress(local, cloud) {
    var localIsNewer = Number(local.updatedAt || 0) > Number(cloud.updatedAt || 0);
    var newest = localIsNewer ? local : cloud;
    var older = localIsNewer ? cloud : local;
    var merged = clone(hasData(newest) ? newest : older);
    // Preserve levels which have never been edited on the newer device. An
    // explicit empty path on that device still means the player erased it.
    if (isObject(older.paths)) {
      merged.paths = isObject(merged.paths) ? merged.paths : {};
      merged.closed = isObject(merged.closed) ? merged.closed : {};
      Object.keys(older.paths).forEach(function (level) {
        if (!Object.prototype.hasOwnProperty.call(merged.paths, level)) {
          merged.paths[level] = older.paths[level];
          if (isObject(older.closed)) merged.closed[level] = older.closed[level] || 0;
        }
      });
    }
    if (hasData(local) && hasData(cloud)) {
      merged.unlocked = Math.max(Number(local.unlocked) || 1, Number(cloud.unlocked) || 1);
      merged.score = Math.max(Number(local.score) || 0, Number(cloud.score) || 0);
    }
    return merged;
  }

  function writeCloud(data) {
    var json = JSON.stringify(data);
    var chunks = splitSnapshot(json);
    var slot = cloudSlot === 'a' ? 'b' : 'a';
    var chain = Promise.resolve();
    // Write an inactive bank and commit its manifest last. An interrupted write
    // cannot expose half of the new progress or destroy the committed bank.
    chunks.forEach(function (value, index) {
      chain = chain.then(function () {
        return send('VKWebAppStorageSet', { key: CLOUD_KEY + '_' + slot + '_' + index, value: value });
      }).then(function (response) { requireSuccess(response, 'VKWebAppStorageSet'); });
    });
    return chain.then(function () {
      var value = JSON.stringify({ format: CLOUD_FORMAT, slot: slot, count: chunks.length, checksum: checksum(json) });
      return send('VKWebAppStorageSet', { key: CLOUD_KEY, value: value }).then(function (response) {
        requireSuccess(response, 'VKWebAppStorageSet');
        cloudSlot = slot;
      }).catch(function (error) {
        // An uncertain manifest response may already have committed. Reusing
        // that bank could corrupt it, so retain local data until the next Init.
        storageReady = false;
        throw error;
      });
    }).catch(function (error) {
      // A timed-out request may still arrive later; do not reuse its bank.
      if (error && error.code === 'VK_ADAPTER_TIMEOUT') storageReady = false;
      throw error;
    });
  }

  function flushProgress() {
    if (cloudTimer) { clearTimeout(cloudTimer); cloudTimer = 0; }
    cloudChain = cloudChain.catch(function () {}).then(function () {
      if (!storageReady || !pendingSave) return false;
      var job = pendingSave;
      pendingSave = null;
      return Promise.resolve().then(function () { return writeCloud(job.data); }).then(function () {
        return true;
      }).catch(function (error) {
        if (!pendingSave || pendingSave.sequence < job.sequence) pendingSave = job;
        warn('не удалось сохранить прогресс; локальная копия сохранена.', error);
        return false;
      });
    });
    return cloudChain;
  }

  function saveProgress(data, flush) {
    if (!isObject(data)) return Promise.resolve(false);
    var snapshot;
    try { snapshot = clone(data); }
    catch (error) { warn('прогресс нельзя сериализовать.', error); return Promise.resolve(false); }
    writeLocal(snapshot);
    pendingSave = { data: snapshot, sequence: ++saveSequence };
    if (cloudTimer) { clearTimeout(cloudTimer); cloudTimer = 0; }
    if (!storageReady) return Promise.resolve(false);
    if (flush) return flushProgress();
    cloudTimer = setTimeout(function () { cloudTimer = 0; flushProgress(); }, CLOUD_SAVE_DELAY);
    return Promise.resolve(true);
  }

  function initResult() {
    return { initialData: getProgress(), environment: environment, sdkAvailable: environment.sdkAvailable };
  }

  function syncCloud() {
    return loadCloud().then(function (cloud) {
      storageReady = true;
      var merged = mergeProgress(getProgress(), cloud);
      writeLocal(merged);
      if (hasData(merged) && JSON.stringify(merged) !== JSON.stringify(cloud)) saveProgress(merged, true);
    }).catch(function (error) {
      // Do not overwrite an unknown remote snapshot after a failed read.
      warn('облако недоступно; используется локальный прогресс.', error);
    });
  }

  function activatePlatform() {
    environment.sdkAvailable = true;
    if (isNativeMobile()) {
      send('VKWebAppSetViewSettings', { status_bar_style: 'light', action_bar_color: '#101522', navigation_bar_color: '#101522' })
        .catch(function (error) { warn('настройки панелей клиента недоступны.', error); });
    }
    preloadAds();
    return syncCloud();
  }

  // Холодный старт клиента бывает медленнее первого ожидания. Без повтора
  // единственный неуспевший VKWebAppInit навсегда отключал бы рекламу и облако.
  function retryHandshake(attempt) {
    if (environment.sdkAvailable || attempt > INIT_RETRIES || !isEmbedded()) return;
    setTimeout(function () {
      if (environment.sdkAvailable) return;
      send('VKWebAppInit', {}, INIT_RETRY_TIMEOUT).then(function (data) {
        requireSuccess(data, 'VKWebAppInit');
        return activatePlatform();
      }).then(function () {
        emit('vkplatformchange', { sdkAvailable: true });
      }, function (error) {
        warn('повторный VKWebAppInit не удался.', error);
        retryHandshake(attempt + 1);
      });
    }, INIT_RETRY_DELAY * attempt);
  }

  function init() {
    if (initPromise) return initPromise;
    getProgress();
    document.documentElement.setAttribute('data-vk-lang', environment.language);
    document.documentElement.setAttribute('data-device', environment.deviceType);
    bridge = global.vkBridge;
    if (!bridge || typeof bridge.send !== 'function') {
      initPromise = Promise.resolve(initResult());
      return initPromise;
    }
    subscribe();
    var startup = send('VKWebAppInit', {}, INIT_TIMEOUT);
    if (!isEmbedded()) {
      startup.catch(function () {});
      initPromise = Promise.resolve(initResult());
      return initPromise;
    }
    initPromise = startup.then(function (data) {
      requireSuccess(data, 'VKWebAppInit');
      return activatePlatform();
    }).catch(function (error) {
      warn('Bridge недоступен; игра работает локально.', error);
      retryHandshake(1);
    }).then(initResult);
    return initPromise;
  }

  function canShowAds() {
    return !!(environment.sdkAvailable && bridge && !adInProgress &&
      supportsMethod('VKWebAppShowNativeAds'));
  }

  // Клиент может не заявлять о поддержке метода вовсе; отсутствие ответа
  // трактуем как «поддерживает», отказ — как «нет».
  function supportsMethod(name) {
    if (!bridge || typeof bridge.supports !== 'function') return !!bridge;
    try { return bridge.supports(name) !== false; }
    catch (error) { return true; }
  }

  function describeError(error) {
    if (!error) return '';
    var data = error.error_data || (error.error && error.error.error_data) || {};
    var reason = data.error_reason;
    if (reason && typeof reason === 'object') reason = reason.error_msg || reason.error_message || '';
    var text = data.error_msg || data.error_description || reason || error.message ||
      (data.error_code === undefined ? '' : 'код ' + data.error_code);
    return String(text || error.error_type || '').slice(0, 160);
  }

  // Проверка доступности заодно просит клиент заранее загрузить ролик — без неё
  // первый VKWebAppShowNativeAds часто отвечает «рекламы нет в наличии».
  function preloadAd(format) {
    if (!environment.sdkAvailable || !bridge || !supportsMethod('VKWebAppCheckNativeAds')) {
      return Promise.resolve(false);
    }
    return send('VKWebAppCheckNativeAds', { ad_format: format, use_waterfall: true }, AD_CHECK_TIMEOUT)
      .then(function (data) {
        adReady[format] = !!(data && data.result === true);
        return adReady[format];
      }, function (error) {
        adReady[format] = false;
        warn('не удалось проверить рекламу «' + format + '».', error);
        return false;
      });
  }

  function preloadAds() {
    AD_FORMATS.forEach(function (format) { preloadAd(format); });
  }

  function requestAd(format, allowRetry) {
    var instant = allowRetry;
    var retryWindow = setTimeout(function () { instant = false; }, AD_RETRY_WINDOW);
    return send('VKWebAppShowNativeAds', { ad_format: format, use_waterfall: true }, AD_TIMEOUT)
      .then(function (data) {
        clearTimeout(retryWindow);
        adReady[format] = false;
        return !!(data && data.result === true);
      }, function (error) {
        clearTimeout(retryWindow);
        adReady[format] = false;
        // Повторяем только мгновенный отказ: иначе закрытый игроком ролик
        // запустился бы во второй раз.
        if (!instant || (error && error.code === 'VK_ADAPTER_TIMEOUT')) throw error;
        warn('ролик «' + format + '» не был готов, просим клиент загрузить его.', error);
        return preloadAd(format).then(function () { return requestAd(format, false); });
      });
  }

  function showAd(format, callbacks) {
    callbacks = callbacks || {};
    if (!canShowAds()) return false;
    adInProgress = true;
    setPauseReason('advertising', true);
    setMuteReason('advertising', true);
    callback(callbacks, 'onOpen');
    var shown = false;
    requestAd(format, true).then(function (result) {
      shown = result;
      if (shown && format === 'reward') callback(callbacks, 'onRewarded');
    }, function (error) {
      warn('реклама не показана.', error);
      callback(callbacks, 'onError', error);
    }).then(function () {
      adInProgress = false;
      setMuteReason('advertising', false);
      setPauseReason('advertising', false);
      callback(callbacks, 'onClose', shown);
      preloadAd(format);
    });
    return true;
  }

  function canFullscreen() {
    var root = document.documentElement;
    return isNativeMobile() || !!((root.requestFullscreen && document.fullscreenEnabled !== false) ||
      (root.webkitRequestFullscreen && document.webkitFullscreenEnabled !== false));
  }

  function setFullscreen(enabled) {
    var operations = [];
    if (isNativeMobile()) {
      // Compatibility with clients implementing the requested extension.
      // Current official types document only the color/style fields:
      // https://github.com/VKCOM/vk-bridge/blob/master/packages/core/src/types/data.ts
      operations.push(send('VKWebAppSetViewSettings', { status_bar_style: 'light', fullscreen: enabled })
        .then(function (data) { requireSuccess(data, 'VKWebAppSetViewSettings'); }));
    }
    var target = enabled ? document.documentElement : document;
    var method = enabled ? (target.requestFullscreen || target.webkitRequestFullscreen) :
      (target.exitFullscreen || target.webkitExitFullscreen);
    if (method && (enabled || document.fullscreenElement || document.webkitFullscreenElement)) {
      // Call synchronously inside the click, before waiting for any Bridge call.
      try { operations.push(Promise.resolve(method.call(target))); }
      catch (error) { operations.push(Promise.reject(error)); }
    }
    return Promise.all(operations.map(function (operation) {
      return operation.catch(function (error) { warn('полноэкранный режим недоступен.', error); });
    })).then(function () { notifyFullscreen(); return fullscreenStatus() === enabled; });
  }

  function registerLifecycleHooks(next) {
    next = next || {};
    ['pause', 'resume', 'mute', 'unmute', 'config', 'fullscreen'].forEach(function (name) {
      if (typeof next[name] === 'function') hooks[name] = next[name];
    });
    if (Object.keys(pauseReasons).length) callback(hooks, 'pause', 'platform');
    if (Object.keys(muteReasons).length) callback(hooks, 'mute');
    if (Object.keys(config).length) callback(hooks, 'config', clone(config));
  }

  function onVisibility() {
    var hidden = document.visibilityState === 'hidden';
    setPauseReason('visibility', hidden);
    setMuteReason('visibility', hidden);
    if (hidden) flushProgress();
  }
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('fullscreenchange', notifyFullscreen);
  document.addEventListener('webkitfullscreenchange', notifyFullscreen);
  global.addEventListener('pagehide', flushProgress);
  onVisibility();

  global.VKGames = {
    init: init,
    getProgress: getProgress,
    saveProgress: saveProgress,
    flushProgress: flushProgress,
    // Kept as game-side lifecycle boundaries; VK Bridge has no matching API.
    gameReady: function () {},
    startGameplay: function () {},
    stopGameplay: function () {},
    showFullscreenAd: function (callbacks) { return showAd('interstitial', callbacks); },
    showRewardedAd: function (callbacks) { return showAd('reward', callbacks); },
    canShowAds: canShowAds,
    preloadAds: preloadAds,
    adStatus: function () { return clone(adReady); },
    describeError: describeError,
    requestFullscreen: function () { return setFullscreen(true); },
    exitFullscreen: function () { return setFullscreen(false); },
    toggleFullscreen: function () { return setFullscreen(!fullscreenStatus()); },
    fullscreenStatus: fullscreenStatus,
    canFullscreen: canFullscreen,
    fullscreen: {
      request: function () { return setFullscreen(true); },
      exit: function () { return setFullscreen(false); },
      toggle: function () { return setFullscreen(!fullscreenStatus()); },
      status: fullscreenStatus,
      available: canFullscreen
    },
    getConfig: function () { return clone(config); },
    registerLifecycleHooks: registerLifecycleHooks,
    environment: environment
  };
})(window);
