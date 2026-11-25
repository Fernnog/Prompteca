// Infraestrutura desacoplada de Splash Screen, Instalação PWA e Service Worker.
// Carregado como script clássico (defer) sem dependências externas ou do Firebase.
(function () {
  'use strict';

  var DISMISS_KEY = 'prompteca_install_dismissed';
  var splashStart = performance.now();
  var splashClosed = false;
  var deferredPrompt = null;

  var isStandalone = function () {
    return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  };

  /* ---------- 1. Controle da Splash Screen ---------- */
  function dismissSplash(immediate) {
    if (splashClosed) return;
    splashClosed = true;
    clearTimeout(failsafeTimer);

    var el = document.getElementById('splash');
    if (!el) return;

    var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    // No app instalado (standalone), o Android já exibiu a splash nativa: saída imediata
    var minShowMs = (immediate || reduced || isStandalone()) ? 0 : 300;
    var delay = Math.max(0, minShowMs - (performance.now() - splashStart));

    setTimeout(function () {
      el.classList.add('is-hidden');
      el.setAttribute('aria-hidden', 'true');
      if (reduced) {
        el.remove();
        return;
      }
      el.addEventListener('transitionend', function () { el.remove(); }, { once: true });
      setTimeout(function () { if (el.isConnected) el.remove(); }, 400);
    }, delay);
  }

  // Failsafe secundário (3,5 s), completamente independente do Firebase/app.js
  var failsafeTimer = setTimeout(function () { dismissSplash(true); }, 3500);

  // API pública mínima consumida pelo app.js nos marcos reais de prontidão
  window.PromptecaSplash = { dismiss: dismissSplash };

  /* ---------- 2. Proteção de Armazenamento Offline (IndexedDB + CacheStorage) ---------- */
  if (navigator.storage && typeof navigator.storage.persist === 'function') {
    navigator.storage.persist().catch(function () {});
  }

  /* ---------- 3. Fluxo de Instalação no Android (beforeinstallprompt) ---------- */
  var bar = document.getElementById('installBar');
  var barBtn = document.getElementById('installBarBtn');
  var barDismiss = document.getElementById('installBarDismiss');
  var popWrap = document.getElementById('installPopWrap');
  var popBtn = document.getElementById('installPopBtn');

  function readDismissed() {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch (_) { return false; }
  }

  function saveDismissed() {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch (_) {}
  }

  function hideAllInstallUI() {
    if (bar) bar.hidden = true;
    if (popWrap) popWrap.hidden = true;
  }

  function setInstallButtonsDisabled(flag) {
    if (barBtn) barBtn.disabled = flag;
    if (popBtn) popBtn.disabled = flag;
  }

  async function triggerInstall() {
    if (!deferredPrompt) return;
    setInstallButtonsDisabled(true);
    try {
      deferredPrompt.prompt();
      var choice = await deferredPrompt.userChoice;
      if (choice && choice.outcome === 'accepted') hideAllInstallUI();
    } catch (_) {
      // Prompt cancelado ou indisponível
    } finally {
      deferredPrompt = null;
      setInstallButtonsDisabled(false);
    }
  }

  if (!isStandalone()) {
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      if (popWrap) popWrap.hidden = false;
      if (bar && !readDismissed()) bar.hidden = false;
    });

    if (barBtn) barBtn.addEventListener('click', triggerInstall);
    if (popBtn) popBtn.addEventListener('click', triggerInstall);

    if (barDismiss) {
      barDismiss.addEventListener('click', function () {
        if (bar) bar.hidden = true;
        saveDismissed();
      });
    }

    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      hideAllInstallUI();
    });
  }

  /* ---------- 4. Registro do Service Worker e Pré-Cache Dinâmico Pós-Load ---------- */
  var canRegisterSW =
    'serviceWorker' in navigator &&
    (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');

  if (canRegisterSW) {
    var pageLoaded = document.readyState === 'complete'
      ? Promise.resolve()
      : new Promise(function (resolve) { window.addEventListener('load', resolve, { once: true }); });

    navigator.serviceWorker.register('./sw.js').then(function () {
      return Promise.all([pageLoaded, navigator.serviceWorker.ready]);
    }).then(function (results) {
      var reg = results[1];
      var worker = reg && reg.active;
      if (!worker || !performance || typeof performance.getEntriesByType !== 'function') return;

      // Coleta as URLs exatas carregadas nesta sessão (incluindo ?v=N, SDK do Firebase e fontes)
      var seen = Object.create(null);
      var urls = [];
      var entries = performance.getEntriesByType('resource') || [];
      for (var i = 0; i < entries.length; i++) {
        var name = entries[i] && entries[i].name;
        if (name && !seen[name]) {
          seen[name] = true;
          urls.push(name);
        }
      }
      if (urls.length) {
        worker.postMessage({ type: 'WARM_CACHE', urls: urls.slice(0, 60) });
      }
    }).catch(function (err) {
      console.warn('Service Worker indisponível:', err);
    });
  }
})();