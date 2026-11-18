(() => {
  const realLoc = location, swRegister = window.ServiceWorkerContainer && ServiceWorkerContainer.prototype.register;
  const P = '/_px/'; let B = (window.__PX || {}).base || location.href;
  const enc = s => { const b = new TextEncoder().encode(s); let x = ''; b.forEach(c => x += String.fromCharCode(c)); return btoa(x).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const skip = /^(#|data:|javascript:|mailto:|tel:|blob:|about:)/i;
  const SUB = (window.__PX || {}).sub, ROOT = SUB ? `${SUB.scheme}://${SUB.base}${SUB.port}` : '';
  const ids = new Map(), xo0 = XMLHttpRequest.prototype.open;
  function oidSync(origin) {
    let i = ids.get(origin); if (i) return i;
    try { const x = new XMLHttpRequest(); xo0.call(x, 'GET', ROOT + '/_oid?o=' + encodeURIComponent(origin), false); x.withCredentials = true; x.send(); if (x.status === 200) i = x.responseText; } catch {}
    if (i) ids.set(origin, i); return i;
  }
  // فك روابط التتبع بتاعة محركات البحث (نفس منطق السيرفر)
  function unwrap(a) {
    try {
      const h = a.hostname.replace(/^www\./, ''); let t = null;
      if (h === 'duckduckgo.com' || h === 'html.duckduckgo.com') { if (a.pathname === '/l/' || a.pathname === '/l') t = a.searchParams.get('uddg'); }
      else if (/^google\.[a-z.]+$/.test(h)) { if (a.pathname === '/url') t = a.searchParams.get('q') || a.searchParams.get('url'); }
      else if (h === 'bing.com' && a.pathname.startsWith('/ck/a')) {
        const v = a.searchParams.get('u');
        if (v && /^a1/.test(v)) { const b = v.slice(2).replace(/-/g, '+').replace(/_/g, '/'); t = new TextDecoder().decode(Uint8Array.from(atob(b), c => c.charCodeAt(0))); }
      }
      if (t && /^https?:\/\//i.test(t)) return new URL(t);
    } catch {}
    return a;
  }
  function px(u) {
    if (u == null) return u;
    if (typeof u !== 'string') { if (u instanceof URL) u = u.href; else return u; }
    u = u.trim(); if (!u || skip.test(u) || (!SUB && u.startsWith(P))) return u;
    try {
      let a = new URL(u, B);
      if (/^https?:$/.test(a.protocol)) a = unwrap(a);
      if (SUB) {
        if (!/^https?:$/.test(a.protocol) || a.hostname.endsWith('.' + SUB.base)) return u;
        const i = oidSync(a.origin); return i ? `${SUB.scheme}://${i}.${SUB.base}${SUB.port}${a.pathname}${a.search}${a.hash}` : u;
      }
      if (a.origin === location.origin && a.pathname.startsWith(P)) return a.pathname + a.search + a.hash;
      if (!/^https?:$/.test(a.protocol)) return u;
      const h = a.hash; a.hash = ''; return P + enc(a.href) + h;
    } catch { return u; }
  }
  // ===== location وهمي: الموقع يشوف عنوانه الحقيقي (مش عنوان البروكسي) وأي تنقل بيعدي على البروكسي =====
  const L = {
    get href() { try { return new URL(B).href.replace(/#.*$/, '') + realLoc.hash; } catch { return B; } },
    set href(v) { realLoc.href = px(String(v)); },
    get origin() { try { return new URL(B).origin; } catch { return realLoc.origin; } },
    get hash() { return realLoc.hash; }, set hash(v) { realLoc.hash = v; },
    assign(v) { realLoc.assign(px(String(v))); }, replace(v) { realLoc.replace(px(String(v))); }, reload() { realLoc.reload(); },
    get ancestorOrigins() { return realLoc.ancestorOrigins; },
    toString() { return this.href; }, [Symbol.toPrimitive]() { return this.href; },
  };
  for (const k of ['protocol', 'host', 'hostname', 'port', 'pathname', 'search']) Object.defineProperty(L, k, {
    enumerable: true, get() { try { return new URL(B)[k]; } catch { return realLoc[k]; } },
    set(v) { try { const u = new URL(B); u[k] = v; realLoc.href = px(u.href); } catch {} } });
  const defLoc = o => { try { Object.defineProperty(o, '__pxlocation', { get: () => L, set: v => { L.href = v; }, configurable: true }); } catch {} };
  defLoc(window); defLoc(Document.prototype);
  for (const k of ['URL', 'documentURI']) try { Object.defineProperty(Document.prototype, k, { get: () => L.href, configurable: true }); } catch {}
  try { Object.defineProperty(Document.prototype, 'domain', { get: () => L.hostname, set() {}, configurable: true }); } catch {}
  // Workers: السكريبت بيتجاب من البروكسي. وSW بتاع الموقع ممنوع يتسجل (هيسرق الـ scope من بتاعنا)
  for (const N of ['Worker', 'SharedWorker']) if (window[N]) {
    const O = window[N]; const W = function (u, o) { return new O((typeof u === 'string' || u instanceof URL) ? px(String(u)) : u, o); };
    W.prototype = O.prototype; window[N] = W;
  }
  if (window.ServiceWorkerContainer) {
    const fake = { scope: '/', active: null, installing: null, waiting: null, unregister: () => Promise.resolve(true), update: () => Promise.resolve() };
    ServiceWorkerContainer.prototype.register = () => Promise.resolve(fake);
    ServiceWorkerContainer.prototype.getRegistrations = () => Promise.resolve([]);
    ServiceWorkerContainer.prototype.getRegistration = () => Promise.resolve(undefined);
    if (!SUB && window.top === window && swRegister) { try { swRegister.call(navigator.serviceWorker, '/sw.js', { scope: '/' }).catch(() => {}); } catch {} }
  }
  // WebSocket / EventSource / Worker
  const OW = window.WebSocket;
  function PW(u, p) {
    let w = u;
    try {
      const a = new URL(String(u), B); const secure = location.protocol === 'https:' ? 'wss' : 'ws';
      a.protocol = a.protocol === 'wss:' ? 'https:' : a.protocol === 'ws:' ? 'http:' : a.protocol;
      if (/^https?:$/.test(a.protocol)) {
        if (SUB) { const i = oidSync(a.origin); if (i) w = `${secure}://${i}.${SUB.base}${SUB.port}${a.pathname}${a.search}`; }
        else { a.hash = ''; w = `${secure}://${location.host}${P}${enc(a.href)}`; }
      }
    } catch {}
    return p === undefined ? new OW(w) : new OW(w, p);
  }
  PW.prototype = OW.prototype; ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k, i) => PW[k] = i); window.WebSocket = PW;
  if (window.EventSource) { const OE = window.EventSource; window.EventSource = function (u, o) { return new OE(px(u), o); }; window.EventSource.prototype = OE.prototype; }
  // fetch / XHR / open / beacon
  const of = window.fetch; window.fetch = function (i, o) { return of.call(this, i instanceof Request ? i : px(i), o); };
  const xo = xo0; XMLHttpRequest.prototype.open = function (m, u, ...r) { return xo.call(this, m, px(u), ...r); };
  const wo = window.open; window.open = function (u, ...r) { return wo.call(this, px(u), ...r); };
  if (navigator.sendBeacon) { const sb = navigator.sendBeacon.bind(navigator); navigator.sendBeacon = (u, d) => sb(px(u), d); }
  // attributes & properties
  const A = { href: 1, src: 1, action: 1, poster: 1, formaction: 1 };
  const sa = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (n, v) { if (A[String(n).toLowerCase()]) v = px(v); return sa.call(this, n, v); };
  for (const [C, p] of [[HTMLAnchorElement, 'href'], [HTMLImageElement, 'src'], [HTMLScriptElement, 'src'], [HTMLLinkElement, 'href'],
    [HTMLIFrameElement, 'src'], [HTMLFormElement, 'action'], [HTMLSourceElement, 'src'], [HTMLMediaElement, 'src']]) {
    const d = Object.getOwnPropertyDescriptor(C.prototype, p); if (!d || !d.set) continue;
    Object.defineProperty(C.prototype, p, { get: d.get, set(v) { d.set.call(this, px(v)); }, configurable: true });
  }
  for (const k of ['pushState', 'replaceState']) {
    const o = history[k];
    history[k] = function (s, t, u) { if (u != null) { const n = px(u); try { B = new URL(u, B).href; } catch {} u = n; } return o.call(this, s, t, u); };
  }
  // history + bookmarks + toolbar (top window only)
  const get = k => { try { return JSON.parse(localStorage.getItem(k)) || []; } catch { return []; } };
  const set = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const go = v => {
    v = v.trim(); if (!v) return;
    if (!/^[a-z]+:\/\//i.test(v)) v = (/^[\w-]+(\.[\w-]+)+([/:?#]|$)/.test(v) && !/\s/.test(v)) ? 'https://' + v : 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(v);
    location.href = SUB ? ROOT + '/_go?u=' + encodeURIComponent(v) : P + enc(v);
  };
  // ===== داخل المتصفح الوهمي (iframe) =====
  const framed = window.top !== window && window.parent === window.top;
  const meta = () => {
    if (!framed) return;
    let fav = ''; try { const ic = document.querySelector('link[rel~="icon"]'); fav = px(ic ? ic.getAttribute('href') : new URL('/favicon.ico', B).href); } catch {}
    try { parent.postMessage({ px: 1, type: 'meta', url: B, title: document.title || '', fav }, '*'); } catch {}
  };
  if (framed) {
    addEventListener('DOMContentLoaded', meta); addEventListener('load', meta); addEventListener('popstate', meta); addEventListener('hashchange', meta);
    let last = ''; setInterval(() => { const k = document.title + '|' + B; if (k !== last) { last = k; meta(); } }, 1000);
    for (const k of ['pushState', 'replaceState']) { const o = history[k]; history[k] = function () { const r = o.apply(this, arguments); setTimeout(meta, 0); return r; }; }
    addEventListener('message', e => {
      if (e.source !== parent || !e.data || e.data.px !== 1) return;
      const c = e.data.cmd; if (c === 'back') history.back(); else if (c === 'forward') history.forward(); else if (c === 'reload') location.reload(); else if (c === 'stop') stop();
    });
    window.open = function (u, t) {
      if (!u) return null;
      if (t && /^_(self|top|parent)$/i.test(t)) { location.href = px(u); return null; }
      parent.postMessage({ px: 1, type: 'newtab', proxy: px(u) }, '*'); return null;
    };
  }
  // ===== اعتراض كل طرق فتح الروابط: ماتفتحش تاب حقيقي في المتصفح ولا تهرب من البروكسي =====
  const isProxied = u => { try { const a = new URL(u, location.href); return SUB ? (a.hostname === SUB.base || a.hostname.endsWith('.' + SUB.base)) : a.origin === location.origin; } catch { return false; } };
  const fixEl = el => {   // يتأكد إن href/action متحول لرابط البروكسي (حتى لو اتضاف ديناميكي بـ innerHTML)
    const n = el.tagName === 'FORM' ? 'action' : 'href', raw = el.getAttribute(n);
    if (raw == null) return; const p = px(raw); if (p !== raw) sa.call(el, n, p);
  };
  const external = t => t && !/^_?self$/i.test(t) && !/^_(top|parent)$/i.test(t) && !(window.frames && window.frames[t]);   // _blank / _new / اسم نافذة تانية
  function onLink(e) {
    const a = e.target && e.target.closest && e.target.closest('a[href],area[href]'); if (!a) return;
    fixEl(a);
    if (e.type === 'pointerdown' || e.type === 'contextmenu' || e.type === 'touchstart') return;   // تجهيز الرابط بس (لـ "افتح في تاب جديد" / الضغط المطول)
    const aux = e.type === 'auxclick'; if (aux && e.button !== 1) return;
    if (a.hasAttribute('download') || !isProxied(a.href)) return;
    const t = a.getAttribute('target') || '', mod = e.ctrlKey || e.metaKey || e.shiftKey || aux;
    if (!framed) return;                      // برا المتصفح الوهمي: الرابط أصلاً بقى رابط بروكسي
    if (/^_(top|parent)$/i.test(t) && !mod) { e.preventDefault(); parent.postMessage({ px: 1, type: 'navigate', proxy: a.href }, '*'); }
    else if (mod || external(t)) { e.preventDefault(); parent.postMessage({ px: 1, type: 'newtab', proxy: a.href, bg: !!(e.ctrlKey || e.metaKey || aux) }, '*'); }
  }
  for (const ev of ['click', 'auxclick', 'pointerdown', 'contextmenu']) window.addEventListener(ev, onLink, true);
  window.addEventListener('touchstart', onLink, { capture: true, passive: true });
  window.addEventListener('submit', e => {    // فورم بـ target=_blank -> يتفتح في نفس التاب جوه البروكسي
    const f = e.target; if (!f || f.tagName !== 'FORM') return;
    fixEl(f); const s = e.submitter;
    if (s && s.hasAttribute('formaction')) { const p = px(s.getAttribute('formaction')); if (p) sa.call(s, 'formaction', p); }
    if (!framed) return;
    if (external(f.getAttribute('target') || '')) f.target = '_self';
    if (s && external(s.getAttribute('formtarget') || '')) s.setAttribute('formtarget', '_self');
  }, true);
  if (!SUB) new MutationObserver(ms => {      // روابط اتضافت بالـ JS (innerHTML...)
    for (const m of ms) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.matches('a[href],area[href],form[action]')) fixEl(n);
      n.querySelectorAll('a[href],area[href],form[action]').forEach(fixEl);
    }
  }).observe(document, { childList: true, subtree: true });
  // آخر خط دفاع: أي تنقل (location.href=... / assign / replace) لموقع خارجي يتحول لرابط بروكسي
  if (window.navigation && navigation.addEventListener) navigation.addEventListener('navigate', e => {
    try {
      if (!e.cancelable || e.hashChange || e.downloadRequest != null || e.navigationType === 'traverse' || e.navigationType === 'reload') return;
      const d = new URL(e.destination.url);
      if (!/^https?:$/.test(d.protocol) || isProxied(d.href)) return;
      const p = px(d.href); if (!p || p === d.href) return;
      e.preventDefault(); setTimeout(() => { location.href = p; }, 0);
    } catch {}
  });
  if (window.top !== window) return;
  addEventListener('DOMContentLoaded', () => {
    const h = get('px_hist'); if (!h[0] || h[0].u !== B) { h.unshift({ t: document.title || B, u: B, d: Date.now() }); set('px_hist', h.slice(0, 100)); }
    const host = document.createElement('div'); host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;bottom:14px;left:14px';
    const s = host.attachShadow({ mode: 'open' });
    s.innerHTML = `<style>*{box-sizing:border-box;font:14px system-ui}button{cursor:pointer;border:0;border-radius:8px;padding:8px 10px;background:#2a2f42;color:#fff}
    #t{width:42px;height:42px;border-radius:50%;background:#4f7cff;font-size:18px;box-shadow:0 2px 10px #0006}
    #p{display:none;margin-bottom:8px;background:#161925;padding:10px;border-radius:12px;box-shadow:0 4px 20px #0008;width:min(92vw,360px);direction:rtl}
    #p.o{display:block}input{width:100%;padding:9px;border-radius:8px;border:1px solid #333;background:#0f1117;color:#fff;margin-bottom:8px;direction:ltr}
    .r{display:flex;gap:6px;flex-wrap:wrap}small{display:block;color:#9aa;margin-top:8px;word-break:break-all;direction:ltr}</style>
    <div id=p><input id=i placeholder="رابط أو بحث..."><div class=r><button id=g>اذهب</button><button id=h>🏠</button><button id=r>↻</button><button id=b>⭐ حفظ</button><button id=c>نسخ الرابط</button></div><small id=u></small></div><button id=t>🌐</button>`;
    const $ = id => s.getElementById(id);
    $('u').textContent = B; $('i').value = B;
    $('t').onclick = () => $('p').classList.toggle('o');
    $('g').onclick = () => go($('i').value); $('i').onkeydown = e => { if (e.key === 'Enter') go($('i').value); };
    $('h').onclick = () => location.href = ROOT + '/'; $('r').onclick = () => location.reload();
    $('c').onclick = () => navigator.clipboard && navigator.clipboard.writeText(B);
    $('b').onclick = () => { const b = get('px_bm'); if (!b.some(x => x.u === B)) b.unshift({ t: document.title || B, u: B }); set('px_bm', b); $('b').textContent = '✓ اتحفظ'; };
    document.documentElement.appendChild(host);
  });
})();
