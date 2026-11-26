// Service Worker do Prompteca — Isolado por prefixo/escopo e compatível com Firestore Offline.
const CACHE_PREFIX = 'prompteca-';
const CACHE_NAME = CACHE_PREFIX + 'shell-v2';
const NAV_TIMEOUT_MS = 2800;
const MANIFEST_TIMEOUT_MS = 3000;

// Constante única para o host do SDK do Firebase (evita duplicação e facilita conferência)
const FIREBASE_CDN_HOST = 'www.gstatic.com';

// Núcleo mínimo (sem duplicar ?v=N — assets versionados entram via Cache-First + WARM_CACHE)
const CORE_PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './image/favicon.ico',
  './image/favicon-32x32.png',
  './image/favicon-16x16.png',
  './image/apple-touch-icon.png',
  './image/android-chrome-192x192.png',
  './image/android-chrome-512x512.png',
  // Opcional: se o arquivo ainda não existir (Opção B), o Promise.allSettled do install ignora o 404
  './image/android-chrome-maskable-512x512.png'
];

const getSwPathname = () => new URL('sw.js', self.registration.scope).pathname;
const matchOwnCache = req => caches.match(req, { cacheName: CACHE_NAME });

// Lista branca única compartilhada entre fetch e WARM_CACHE.
// Restringe same-origin ao escopo exato do Prompteca e nunca intercepta Firestore nem Auth.
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

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(
        CORE_PRECACHE.map(path =>
          fetch(path, { cache: 'no-cache' }).then(res => {
            if (res && res.ok && !res.redirected) return cache.put(path, res);
          })
        )
      ))
      .then(() => self.skipWaiting())
  );
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

// Recebe as URLs efetivamente carregadas pela página após window.load e aquece o cache da 1ª visita
self.addEventListener('message', event => {
  const data = event.data;
  if (!data || data.type !== 'WARM_CACHE' || !Array.isArray(data.urls)) return;

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

// Estratégias com registro SÍNCRONO de event.waitUntil() para conformidade estrita com a spec W3C
function respondNavigation(event) {
  const indexUrl = new URL('index.html', self.registration.scope).href;
  let cacheWrite = Promise.resolve();

  const netPromise = fetch(event.request, { cache: 'no-cache' }).then(res => {
    if (res && res.ok && !res.redirected) {
      cacheWrite = putInCache(indexUrl, res.clone(), false).catch(() => {});
    }
    return res;
  });

  // Mantém o SW vivo até rede + gravação concluírem, mesmo se o timeout responder antes
  event.waitUntil(netPromise.catch(() => {}).then(() => cacheWrite));

  event.respondWith((async () => {
    const cached = (await matchOwnCache(indexUrl)) || (await matchOwnCache(self.registration.scope));
    if (!cached) return netPromise;

    const timeoutFallback = new Promise(resolve => setTimeout(() => resolve(cached), NAV_TIMEOUT_MS));
    return Promise.race([
      netPromise.catch(() => cached),
      timeoutFallback
    ]);
  })());
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

// Network-First resiliente para o manifesto: rede quando ok; cache em erro HTTP, falha de rede
// ou rede lenta (timeout); Response.error() apenas se não houver rede nem cópia local.
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
    respondNavigation(event);
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