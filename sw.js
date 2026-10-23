/**
 * AI 健身 Service Worker。
 *
 * 策略：
 *  - 预缓存应用壳（页面 + JS），保证二次打开秒开
 *  - WASM 与模型（约 19MB）按需缓存（cache-first）：首次在线访问时流式下载，
 *    之后完全离线可用——训练本来就设计为端侧运行
 *  - 页面导航 network-first，离线时回退到缓存的壳
 *  - 命中率无关的请求（其他域名）直接放行
 */
const CACHE = 'ai-fitness-722cabbdf8';
// wasm 提前预缓存：Worker 会在 SW 激活前就请求它，运行时拦截会漏掉
const SHELL = ['./', './index.html', './app.js', './worker.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './wasm/vision_wasm_internal.js', './wasm/vision_wasm_internal.wasm', './models/pose_landmarker_lite.task'];
/** 这些路径走 cache-first，一旦缓存永不回源（模型与运行时不变，按 MANIFEST.md 升级） */
const IMMUTABLE_PREFIXES = ['./wasm/', './models/', './icons/'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 其他域名直接放行

  // 不可变资源：cache-first
  const path = url.pathname;
  const isImmutable = IMMUTABLE_PREFIXES.some((prefix) => {
    // 兼容子路径部署（如 GitHub Pages /ai-fitness-demo/）
    return path.endsWith(prefix.slice(1)) || path.includes(prefix.slice(2));
  });
  if (isImmutable) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // 页面导航：network-first，离线回退壳
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html')),
    );
    return;
  }

  // 其余同源静态：stale-while-revalidate
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit ?? network;
    }),
  );
});
