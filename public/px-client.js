(() => {
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
  function px(u) {
    if (u == null) return u;
    if (typeof u !== 'string') { if (u instanceof URL) u = u.href; else return u; }
    u = u.trim(); if (!u || skip.test(u) || (!SUB && u.startsWith(P))) return u;
    try {
      const a = new URL(u, B);
      if (SUB) {
        if (!/^https?:$/.test(a.protocol) || a.hostname.endsWith('.' + SUB.base)) return u;
        const i = oidSync(a.origin); return i ? `${SUB.scheme}://${i}.${SUB.base}${SUB.port}${a.pathname}${a.search}${a.hash}` : u;
      }
      if (a.origin === location.origin && a.pathname.startsWith(P)) return a.pathname + a.search + a.hash;
      if (!/^https?:$/.test(a.protocol)) return u;
      const h = a.hash; a.hash = ''; return P + enc(a.href) + h;
    } catch { return u; }
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
    document.addEventListener('click', e => {
      const a = e.target && e.target.closest && e.target.closest('a[target]');
      if (a && /^_(blank|top|parent)$/i.test(a.target) && a.href) { e.preventDefault(); parent.postMessage({ px: 1, type: /blank/i.test(a.target) ? 'newtab' : 'navigate', proxy: a.href }, '*'); }
    }, true);
    window.open = function (u) { if (u) parent.postMessage({ px: 1, type: 'newtab', proxy: px(u) }, '*'); return null; };
  }
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
