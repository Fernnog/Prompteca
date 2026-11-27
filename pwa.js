// Infraestrutura desacoplada de Splash Screen, Instalação PWA, Diagnóstico, Service Worker e aviso de atualização.
// Carregado como script clássico (defer) sem dependências externas ou do Firebase.
(function () {
  'use strict';

  var DISMISS_KEY = 'prompteca_install_dismissed';
  var DEBUG = new URLSearchParams(location.search).has('pwa-debug');
  var splashStart = performance.now();
  var splashClosed = false;
  var deferredPrompt = null;

  var isStandalone = function () {
    return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  };

  // Desfaz a paleta fixa da splash (classe splash-active + theme-color), definida no <head> do index.html
  var endSplashChrome = function () {
    if (typeof window.__promptecaEndSplash === 'function') window.__promptecaEndSplash();
    else document.documentElement.classList.remove('splash-active');
  };

  // Momento real em que a splash HTML ficou visível (FCP); lido na hora, sem depender de callback assíncrono
  var getFcpTime = function () {
    try {
      var entry = performance.getEntriesByName('first-contentful-paint')[0];
      return entry ? entry.startTime : null;
    } catch (_) {
      return null;
    }
  };

  /* ---------- 1. Controle da Splash Screen ---------- */
  function dismissSplash(immediate) {
    if (splashClosed) return;
    splashClosed = true;
    clearTimeout(failsafeTimer);

    var el = document.getElementById('splash');
    if (!el) {
      endSplashChrome();
      return;
    }

    var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    var standalone = isStandalone();
    // App instalado: nenhuma espera artificial (a splash nativa já cobriu a abertura).
    // Navegador: mínimo de 300 ms de exposição real, contado a partir do FCP, para não piscar.
    var minShowMs = (immediate || reduced || standalone) ? 0 : 300;
    var fcp = getFcpTime();
    var visibleOrigin = fcp !== null ? fcp : splashStart;
    var now = performance.now();
    var delay = Math.max(0, minShowMs - (now - visibleOrigin));

    if (DEBUG) {
      console.info('[Prompteca Splash]', {
        standalone: standalone,
        fcpMs: fcp !== null ? Math.round(fcp) : null,
        dismissMs: Math.round(now),
        visibleMs: Math.round(Math.max(0, now - visibleOrigin)),
        appliedDelayMs: Math.round(delay)
      });
    }

    var hide = function () {
      // Restaura o tema real imediatamente antes do fade revelar o app
      endSplashChrome();
      el.classList.add('is-hidden');
      el.setAttribute('aria-hidden', 'true');
      if (reduced) {
        el.remove();
        return;
      }
      el.addEventListener('transitionend', function () { el.remove(); }, { once: true });
      setTimeout(function () { if (el.isConnected) el.remove(); }, 400);
    };

    if (delay > 0) {
      setTimeout(hide, delay);
    } else if (reduced) {
      hide();
    } else {
      // Dois quadros garantem que a transição de opacidade sempre ocorra, sem corte brusco
      requestAnimationFrame(function () {
        requestAnimationFrame(hide);
      });
    }
  }

  // Failsafe secundário (3,5 s), completamente independente do Firebase/app.js
  var failsafeTimer = setTimeout(function () { dismissSplash(true); }, 3500);

  // API pública mínima consumida pelo app.js nos marcos reais de prontidão
  window.PromptecaSplash = { dismiss: dismissSplash };

  /* ---------- 2. Proteção de Armazenamento Offline (IndexedDB + CacheStorage) ---------- */
  if (navigator.storage && typeof navigator.storage.persist === 'function') {
    navigator.storage.persist().catch(function () {});
  }

  /* ---------- 3. Fluxo de Instalação PWA (Android / Fallback Contextual) ---------- */
  var bar = document.getElementById('installBar');
  var barBtn = document.getElementById('installBarBtn');
  var barDismiss = document.getElementById('installBarDismiss');
  var popWrap = document.getElementById('installPopWrap');
  var popBtn = document.getElementById('installPopBtn');
  var installHint = document.getElementById('installHint');

  function readDismissed() {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch (_) { return false; }
  }

  function saveDismissed() {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch (_) {}
  }

  // Orientação manual conforme o ambiente; string vazia = nenhuma dica (ex.: desktop)
  function getFallbackInstallHint() {
    var ua = navigator.userAgent || '';
    if (!window.isSecureContext) {
      return 'Para instalar como app, abra o Prompteca em um endereço seguro (HTTPS).';
    }
    if (/FBAN|FBAV|Instagram|WhatsApp|Line\/|wv\)/i.test(ua)) {
      return 'Para instalar como app, toque no menu e escolha “Abrir no Chrome”.';
    }
    if (/iPhone|iPad|iPod/i.test(ua)) {
      return 'No Safari, toque em Compartilhar e escolha “Adicionar à Tela de Início”.';
    }
    if (/Android/i.test(ua)) {
      return 'Para instalar, toque no menu (⋮) do Chrome e escolha “Instalar aplicativo”. ' +
        'Se aparecer “Abrir app”, ele já está instalado. Se abriu por outro app, use antes “Abrir no Chrome”.';
    }
    return '';
  }

  function showInstallHint(text) {
    if (!installHint || !popWrap) return;
    if (!text) {
      installHint.hidden = true;
      if (!popBtn || popBtn.hidden) popWrap.hidden = true;
      return;
    }
    installHint.textContent = text;
    installHint.hidden = false;
    popWrap.hidden = false;
  }

  function hideAllInstallUI() {
    if (bar) bar.hidden = true;
    if (popBtn) popBtn.hidden = true;
    if (installHint) installHint.hidden = true;
    if (popWrap) popWrap.hidden = true;
  }

  function setInstallButtonsDisabled(flag) {
    if (barBtn) barBtn.disabled = flag;
    if (popBtn) popBtn.disabled = flag;
  }

  async function triggerInstall() {
    if (!deferredPrompt) return;
    var promptEvent = deferredPrompt;
    deferredPrompt = null; // beforeinstallprompt é de uso único
    setInstallButtonsDisabled(true);

    var accepted = false;
    try {
      await promptEvent.prompt();
      var choice = await promptEvent.userChoice;
      accepted = Boolean(choice && choice.outcome === 'accepted');
    } catch (_) {
      // Prompt cancelado ou indisponível
    } finally {
      setInstallButtonsDisabled(false);
      if (bar) bar.hidden = true;
      if (popBtn) popBtn.hidden = true;
      if (accepted) hideAllInstallUI();
      else showInstallHint(getFallbackInstallHint());
    }
  }

  // Diagnóstico sob demanda (?pwa-debug na URL ou await PromptecaPWA.diagnose() no console).
  // ?_diag=<timestamp> faz o sw.js deixar a requisição passar direto para a rede, sem cache.
  async function diagnoseInstallability() {
    var issues = [];
    var bust = String(Date.now());
    var withDiag = function (rawUrl) {
      var u = new URL(rawUrl, location.href);
      u.searchParams.set('_diag', bust);
      return u.href;
    };

    if (!window.isSecureContext) {
      issues.push('Contexto inseguro (sem HTTPS): navegadores bloqueiam Service Worker e instalação PWA.');
    }
    if (!('serviceWorker' in navigator)) {
      issues.push('Navegador atual não suporta Service Worker.');
    } else {
      try {
        var reg = await navigator.serviceWorker.getRegistration();
        if (!reg || !reg.active) issues.push('Service Worker ainda não está ativo para este escopo.');
      } catch (_) {
        issues.push('Não foi possível consultar o registro do Service Worker.');
      }
    }

    var manifestLink = document.querySelector('link[rel="manifest"]');
    if (!manifestLink) {
      issues.push('Tag <link rel="manifest"> ausente no HTML.');
    } else {
      try {
        var res = await fetch(withDiag(manifestLink.href), { cache: 'no-store' });
        if (!res.ok) {
          issues.push('Falha ao carregar o manifesto no servidor (HTTP ' + res.status + ').');
        } else {
          var manifest = await res.json();
          var icons = Array.isArray(manifest.icons) ? manifest.icons : [];
          if (!icons.length) issues.push('Manifesto sem ícones declarados.');

          await Promise.all(icons.map(async function (icon) {
            try {
              var resolvedIcon = new URL(icon.src, manifestLink.href).href;
              var iRes = await fetch(withDiag(resolvedIcon), { cache: 'no-store' });
              var ct = iRes.headers.get('content-type') || '';
              if (!iRes.ok || ct.indexOf('image/') !== 0) {
                issues.push('Ícone inválido ou ausente no servidor (' + icon.src + ' -> HTTP ' + iRes.status + ').');
                return;
              }
              // Confere se as dimensões reais batem com "sizes" e se o ícone é quadrado
              if (typeof createImageBitmap === 'function') {
                var bmp = await createImageBitmap(await iRes.blob());
                var w = bmp.width, h = bmp.height;
                if (bmp.close) bmp.close();
                var declared = String(icon.sizes || '').toLowerCase().split(/\s+/).filter(Boolean);
                if (w !== h) {
                  issues.push('Ícone não é quadrado (' + icon.src + ': ' + w + 'x' + h + ').');
                } else if (declared.length && declared.indexOf(w + 'x' + h) === -1) {
                  issues.push('Tamanho real diverge do declarado (' + icon.src + ': real ' + w + 'x' + h +
                    ', declarado ' + icon.sizes + ').');
                }
              }
            } catch (_) {
              issues.push('Erro ao validar ícone (' + icon.src + ').');
            }
          }));
        }
      } catch (_) {
        issues.push('Manifesto inacessível ou com JSON inválido.');
      }
    }

    if (issues.length) console.warn('[Prompteca PWA] Problemas detectados:', issues);
    else console.info('[Prompteca PWA] Manifesto, ícones e Service Worker válidos.');
    return issues;
  }

  // updateAvailable permite que o app.js (módulo, executado depois) descubra um aviso já recebido
  window.PromptecaPWA = { diagnose: diagnoseInstallability, updateAvailable: false };

  if (!isStandalone()) {
    // Dica manual no popover da conta até que beforeinstallprompt forneça o botão nativo
    showInstallHint(getFallbackInstallHint());

    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      if (installHint) installHint.hidden = true;
      if (popBtn) popBtn.hidden = false;
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

  if (DEBUG) {
    window.addEventListener('load', function () { diagnoseInstallability(); }, { once: true });
  }

  /* ---------- 4. Service Worker: registro, pré-cache pós-load e aviso de nova versão ---------- */
  var canRegisterSW =
    'serviceWorker' in navigator &&
    (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');

  // Ponte SW → app.js: um único aviso por página, mesmo que chegue por push e por verificação ativa
  function announceUpdate() {
    if (window.PromptecaPWA.updateAvailable) return;
    window.PromptecaPWA.updateAvailable = true;
    window.dispatchEvent(new CustomEvent('prompteca:update'));
  }

  if (canRegisterSW) {
    navigator.serviceWorker.addEventListener('message', function (event) {
      if (event.data && event.data.type === 'SHELL_UPDATED') announceUpdate();
    });
    if (typeof navigator.serviceWorker.startMessages === 'function') {
      navigator.serviceWorker.startMessages();
    }

    var pageLoaded = document.readyState === 'complete'
      ? Promise.resolve()
      : new Promise(function (resolve) { window.addEventListener('load', resolve, { once: true }); });

    navigator.serviceWorker.register('./sw.js').then(function () {
      return Promise.all([pageLoaded, navigator.serviceWorker.ready]);
    }).then(function (results) {
      var reg = results[1];
      var worker = reg && reg.active;
      if (!worker) return;

      // Pergunta ao SW se esta aba abriu sobre um shell que já foi substituído
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'CHECK_UPDATE' });
      }

      if (!performance || typeof performance.getEntriesByType !== 'function') return;

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
