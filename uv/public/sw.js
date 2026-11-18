importScripts('/uv/uv.bundle.js');
importScripts('/uv/uv.config.js');
importScripts(__uv$config.sw || '/uv/uv.sw.js');
const uv = new UVServiceWorker();
self.addEventListener('fetch', e => e.respondWith(uv.fetch(e)));
