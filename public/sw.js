'use strict';
// Service Worker: أي طلب خرج من صفحة بروكسي بعنوان خام (cross-origin أو مسار نسبي ضايع) بيتحول لطلب بروكسي.
// بيشتغل في وضع الـ path بس (على Railway). في وضع الـ subdomain الـ px-client بيكفي.
const P = '/_px/';
const OWN = /^\/(_go|_oid|_login|_logout|_admin|_search|px-client\.js|sw\.js|health)(\/|$)/;
const dec = s => { try { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0))); } catch { return null; } };
const enc = s => { const b = new TextEncoder().encode(s); let x = ''; b.forEach(c => x += String.fromCharCode(c)); return btoa(x).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const isHttp = d => !!d && /^https?:\/\//i.test(d);
const baseOf = url => { try { const m = new URL(url).pathname.match(/^\/_px\/([^/?#]+)/); const d = m && dec(m[1]); return isHttp(d) ? d : null; } catch { return null; } };

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const r = e.request; if (r.mode === 'navigate') return;
  let u; try { u = new URL(r.url); } catch { return; }
  if (!/^https?:$/.test(u.protocol)) return;
  if (u.origin === location.origin) {
    if (OWN.test(u.pathname)) return;
    if (u.pathname.startsWith(P) && isHttp(dec(u.pathname.slice(P.length).split('/')[0]))) return;   // رابط بروكسي سليم
  }
  e.respondWith((async () => {
    const c = e.clientId ? await self.clients.get(e.clientId) : null;
    const base = c && baseOf(c.url);
    if (!base) return fetch(r);                                       // الطلب مش جاي من صفحة بروكسي
    let target;
    if (u.origin !== location.origin) target = u.href;                // موقع خارجي اتنده عليه مباشرة
    else if (u.pathname.startsWith(P)) target = new URL(u.pathname.slice(P.length) + u.search, base).href;   // importScripts('rel.js') الخ
    else target = new URL(u.pathname + u.search, base).href;          // مسار نسبي من الجذر ('/api/x')
    const init = { method: r.method, headers: r.headers, credentials: 'include', redirect: 'follow' };
    if (r.method !== 'GET' && r.method !== 'HEAD') init.body = await r.arrayBuffer();
    return fetch(P + enc(target), init);
  })());
});
