// Service Worker do Prompteca — App Shell com Stale-While-Revalidate ATÔMICO.
// Isolado por prefixo/escopo e compatível com Firestore Offline (nunca intercepta Firestore nem Auth).
//
// Invariante: o index.html gravado no cache NUNCA referencia um asset (?v=N local ou SDK do Firebase)
// que não esteja também no cache. Assim, abrir o app offline após um deploy jamais quebra.
const CACHE_PREFIX = 'prompteca-';
const CACHE_NAME = CACHE_PREFIX + 'shell-v3';
const MANIFEST_TIMEOUT_MS = 3000;

// Host do SDK do Firebase (versão no caminho: /firebasejs/10.12.2/...)
const FIREBASE_CDN_HOST = 'www.gstatic.com';

// Chave interna (nunca requisitada pela rede) que registra qual aba abriu sobre um shell antigo
const UPDATE_FLAG_PATH = '__prompteca-shell-updated';

// Arquivos auxiliares. O index.html é tratado à parte, de forma transacional, no install.
const CORE_PRECACHE = [
  './manifest.webmanifest',
  './image/favicon.ico',
  './image/favicon-32x32.png',
  './image/favicon-16x16.png',
  './image/apple-touch-icon.png',
  './image/android-chrome-192x192.png?v=2',
  './image/android-chrome-512x512.png?v=2',
  './image/android-chrome-maskable-512x512.png?v=2'
];

const scopeUrl = path => new URL(path, self.registration.scope).href;
const shellIndexUrl = () => scopeUrl('index.html');
const getSwPathname = () => new URL('sw.js', self.registration.scope).pathname;
const matchOwnCache = req => caches.match(req, { cacheName: CACHE_NAME });

// Lista branca única compartilhada entre fetch e WARM_CACHE.
function isCacheableUrl(url) {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  // Requisições de diagnóstico (?_diag=...) vão direto à rede: nunca leem nem gravam no cache
  if (url.searchParams.has('_diag')) return false;
  if (url.origin === self.location.origin) {
    return url.href.startsWith(self.registration.scope) && url.pathname !== getSwPathname();
  }
  if (url.hostname === FIREBASE_CDN_HOST && url.pathname.startsWith('/firebasejs/')) return true;
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return true;
  return false;
}

function isImmutableUrl(url) {
  if (url.origin === self.location.origin && url.searchParams.has('v')) return true;
  if (url.hostname === FIREBASE_CDN_HOST && url.pathname.startsWith('/firebasejs/')) return true;
  return false;
}

function isManifestUrl(url) {
  return url.origin === self.location.origin && url.pathname.endsWith('/manifest.webmanifest');
}

// Somente a raiz do escopo e o index.html recebem a estratégia de App Shell
function isShellNavigation(url) {
  const scopePath = new URL(self.registration.scope).pathname;
  return url.pathname === scopePath || url.pathname === scopePath + 'index.html';
}

async function putInCache(reqOrUrl, response, pruneVersioned) {
  if (!response || !response.ok) return;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(reqOrUrl, response);

  // Expurga versões antigas (?v=4 quando ?v=5 entra) apenas dentro do próprio CACHE_NAME
  if (pruneVersioned) {
    const rawUrl = typeof reqOrUrl === 'string' ? reqOrUrl : reqOrUrl.url;
    const reqUrl = new URL(rawUrl, self.location.origin);
    if (reqUrl.origin === self.location.origin && reqUrl.searchParams.has('v')) {
      const keys = await cache.keys();
      await Promise.all(
        keys
          .filter(k => {
            const u = new URL(k.url);
            return u.origin === reqUrl.origin && u.pathname === reqUrl.pathname && u.search !== reqUrl.search;
          })
          .map(k => cache.delete(k))
      );
    }
  }
}

/* ---------- Gerenciador transacional do App Shell ---------- */

// Assets que o shell precisa ter offline: arquivos locais versionados (?v=N) e módulos do SDK do Firebase
function isTrackedShellAsset(u) {
  if (u.searchParams.has('_diag')) return false;
  if (u.origin === self.location.origin) {
    return u.href.startsWith(self.registration.scope) && u.searchParams.has('v');
  }
  return u.protocol === 'https:' &&
    u.hostname === FIREBASE_CDN_HOST &&
    u.pathname.startsWith('/firebasejs/') &&
    u.pathname.endsWith('.js');
}

const HTML_REF_RE = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;
// Imports estáticos (import ... from "x", export ... from "x", import "x") e dinâmicos (import("x"))
const JS_IMPORT_RE = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

function extractTrackedUrls(text, baseUrl, re) {
  const out = new Set();
  for (const m of text.matchAll(re)) {
    try {
      const u = new URL(m[1], baseUrl);
      if (isTrackedShellAsset(u)) out.add(u.href);
    } catch (_) {}
  }
  return Array.from(out);
}

// Fase 1: percorre o HTML e, recursivamente, os imports dos módulos JS (em paralelo, nível a nível).
// Usa o que já está em cache; baixa o que falta. Qualquer falha aborta a transação inteira.
async function stageShellAssets(html, baseUrl) {
  const active = new Set();
  const staged = [];

  let level = extractTrackedUrls(html, baseUrl, HTML_REF_RE);
  level.forEach(u => active.add(u));

  while (level.length) {
    const found = await Promise.all(level.map(async url => {
      let res = await matchOwnCache(url);
      if (!res) {
        const fetched = await fetch(url);
        if (!fetched || !fetched.ok) {
          throw new Error('Falha ao baixar asset do shell: ' + url);
        }
        staged.push({ url, response: fetched.clone() });
        res = fetched;
      }
      if (!new URL(url).pathname.endsWith('.js')) return [];
      return extractTrackedUrls(await res.text(), url, JS_IMPORT_RE);
    }));

    level = [];
    found.flat().forEach(u => {
      if (!active.has(u)) {
        active.add(u);
        level.push(u);
      }
    });
  }

  return { staged, active };
}

function firebaseRoot(u) {
  if (u.hostname !== FIREBASE_CDN_HOST) return null;
  const m = u.pathname.match(/^\/firebasejs\/[^/]+\//);
  return m ? m[0] : null;
}

// Fase 4: poda pós-commit — remove só versões substituídas de arquivos ainda em uso
async function pruneObsoleteShellAssets(cache, activeUrls) {
  const activeSearchByPath = new Map();
  const activeFbRoots = new Set();
  activeUrls.forEach(raw => {
    const u = new URL(raw);
    if (u.origin === self.location.origin) activeSearchByPath.set(u.pathname, u.search);
    else {
      const root = firebaseRoot(u);
      if (root) activeFbRoots.add(root);
    }
  });

  const keys = await cache.keys();
  await Promise.all(
    keys
      .filter(k => {
        const u = new URL(k.url);
        if (u.origin === self.location.origin) {
          return u.searchParams.has('v') &&
            activeSearchByPath.has(u.pathname) &&
            activeSearchByPath.get(u.pathname) !== u.search;
        }
        const root = firebaseRoot(u);
        return Boolean(root) && activeFbRoots.size > 0 && !activeFbRoots.has(root);
      })
      .map(k => cache.delete(k))
  );
}

// Transação completa: staging → grava assets → commit do index.html → poda → aviso de atualização.
// previousHtml === null significa "não havia shell em cache" (primeira visita ou install).
async function commitShell(netRes, previousHtml, resultingClientId) {
  const indexUrl = shellIndexUrl();
  const newHtml = await netRes.clone().text();

  const { staged, active } = await stageShellAssets(newHtml, indexUrl);

  // Fase 2: grava os assets novos (os antigos continuam intactos)
  const cache = await caches.open(CACHE_NAME);
  for (const item of staged) {
    await cache.put(item.url, item.response);
  }

  // Fase 3: commit do index.html, somente depois de todos os assets estarem gravados
  const changed = previousHtml !== null && previousHtml !== newHtml;
  if (previousHtml === null || changed) {
    await cache.put(indexUrl, netRes);
  }

  // Fase 4: poda segura das versões substituídas
  await pruneObsoleteShellAssets(cache, active);

  if (changed) {
    // Marca qual aba abriu sobre o shell antigo (lida pela página via CHECK_UPDATE)
    await cache.put(
      scopeUrl(UPDATE_FLAG_PATH),
      new Response(JSON.stringify({ clientId: resultingClientId || '' }), {
        headers: { 'Content-Type': 'application/json' }
      })
    );
    // Aviso imediato às abas já abertas (complementar; a verificação ativa cobre a aba nova)
    const windows = await self.clients.matchAll({ type: 'window' });
    windows.forEach(c => c.postMessage({ type: 'SHELL_UPDATED' }));
  }
}

async function answerUpdateCheck(source) {
  if (!source || !source.id) return;
  const cache = await caches.open(CACHE_NAME);
  const flagUrl = scopeUrl(UPDATE_FLAG_PATH);
  const res = await cache.match(flagUrl);
  if (!res) return;

  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (data.clientId && data.clientId === source.id) {
    await cache.delete(flagUrl);
    source.postMessage({ type: 'SHELL_UPDATED' });
  }
}

/* ---------- Ciclo de vida ---------- */

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Auxiliares: falhas individuais (ex.: ícone ainda não publicado) não bloqueiam a instalação
    await Promise.allSettled(
      CORE_PRECACHE.map(async path => {
        const res = await fetch(path, { cache: 'no-cache' });
        if (res && res.ok && !res.redirected) await cache.put(path, res);
      })
    );

    // Shell: transacional. Se algum asset faltar, a instalação falha e o SW anterior continua ativo.
    const indexRes = await fetch(shellIndexUrl(), { cache: 'no-cache' });
    if (!indexRes.ok || indexRes.redirected) {
      throw new Error('index.html indisponível durante a instalação');
    }
    await commitShell(indexRes, null, '');

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  // Apaga SOMENTE caches antigos do próprio Prompteca (nunca afeta outros apps na mesma origem)
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  const data = event.data;
  if (!data) return;

  // A página pergunta, após o load, se abriu sobre um shell que já foi substituído
  if (data.type === 'CHECK_UPDATE') {
    event.waitUntil(answerUpdateCheck(event.source).catch(() => {}));
    return;
  }

  // Recebe as URLs efetivamente carregadas pela página após window.load e aquece o cache
  if (data.type !== 'WARM_CACHE' || !Array.isArray(data.urls)) return;

  event.waitUntil((async () => {
    const urls = data.urls.slice(0, 60);
    await Promise.allSettled(
      urls.map(async raw => {
        let parsed;
        try { parsed = new URL(raw, self.location.origin); } catch (_) { return; }
        if (!isCacheableUrl(parsed)) return;

        const existing = await matchOwnCache(parsed.href);
        if (existing) return;

        const res = await fetch(parsed.href);
        if (res && res.ok) {
          await putInCache(parsed.href, res, isImmutableUrl(parsed));
        }
      })
    );
  })());
});

/* ---------- Estratégias (event.waitUntil registrado de forma SÍNCRONA, conforme a spec) ---------- */

// App Shell: entrega o index.html do cache na hora e revalida em segundo plano, de forma atômica.
// Sem cache (primeira visita): entrega a resposta da rede imediatamente e monta o cache depois.
function respondNavigation(event) {
  const indexUrl = shellIndexUrl();
  const clientId = event.resultingClientId || '';

  const task = (async () => {
    const cached = await matchOwnCache(indexUrl);

    if (cached) {
      const previousHtml = cached.clone().text();
      const bg = (async () => {
        const net = await fetch(event.request, { cache: 'no-cache' });
        if (!net || !net.ok || net.redirected) return;
        await commitShell(net, await previousHtml, clientId);
      })();
      return { response: cached, bg };
    }

    const net = await fetch(event.request, { cache: 'no-cache' });
    const bg = (net && net.ok && !net.redirected)
      ? commitShell(net.clone(), null, '')
      : Promise.resolve();
    return { response: net, bg };
  })();

  // Falhas na revalidação mantêm o shell anterior 100% íntegro
  event.waitUntil(
    task.then(r => r.bg).catch(err => console.warn('[Prompteca SW] Revalidação do shell adiada:', err))
  );
  event.respondWith(task.then(r => r.response));
}

function respondCacheFirst(event, pruneVersioned) {
  let cacheWrite = Promise.resolve();

  const responsePromise = matchOwnCache(event.request).then(cached => {
    if (cached) return cached;
    return fetch(event.request).then(res => {
      if (res && res.ok) {
        cacheWrite = putInCache(event.request, res.clone(), pruneVersioned).catch(() => {});
      }
      return res;
    });
  });

  event.waitUntil(responsePromise.catch(() => {}).then(() => cacheWrite));
  event.respondWith(responsePromise);
}

function respondStaleWhileRevalidate(event) {
  let cacheWrite = Promise.resolve();

  const netPromise = fetch(event.request).then(res => {
    if (res && res.ok) {
      cacheWrite = putInCache(event.request, res.clone(), false).catch(() => {});
    }
    return res;
  });

  event.waitUntil(netPromise.catch(() => {}).then(() => cacheWrite));

  event.respondWith(
    matchOwnCache(event.request).then(cached => cached || netPromise)
  );
}

// Network-First resiliente (manifesto e navegações que não são o shell): rede quando ok;
// cache em erro HTTP, falha de rede ou rede lenta; Response.error() apenas sem rede nem cópia local.
function respondNetworkFirst(event) {
  const netPromise = fetch(event.request, { cache: 'no-cache' });

  const cacheWrite = netPromise
    .then(res => (res && res.ok ? putInCache(event.request, res.clone(), false) : null))
    .catch(() => {});

  event.waitUntil(cacheWrite);

  event.respondWith((async () => {
    const cached = await matchOwnCache(event.request);

    const network = netPromise
      .then(res => (res && res.ok ? res : (cached || res)))
      .catch(() => cached || Response.error());

    if (!cached) return network;

    const timeoutFallback = new Promise(resolve => setTimeout(() => resolve(cached), MANIFEST_TIMEOUT_MS));
    return Promise.race([network, timeoutFallback]);
  })());
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (!isCacheableUrl(url)) return;

  if (req.mode === 'navigate') {
    if (isShellNavigation(url)) respondNavigation(event);
    else respondNetworkFirst(event);
    return;
  }

  if (isManifestUrl(url)) {
    respondNetworkFirst(event);
    return;
  }

  if (isImmutableUrl(url)) {
    respondCacheFirst(event, url.origin === self.location.origin);
    return;
  }

  respondStaleWhileRevalidate(event);
});
