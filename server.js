'use strict';
// Simple Web Proxy - zero dependencies, Node 18+
const http = require('http'), https = require('https'), zlib = require('zlib'), dns = require('dns');
const net = require('net'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const ACCESS_KEY = process.env.ACCESS_KEY || '';              // لو اتحط، الموقع بيطلب كلمة سر
const RATE = +process.env.RATE_LIMIT || 900;                  // طلبات/دقيقة لكل IP
const MAX_REWRITE = (+process.env.MAX_REWRITE_MB || 8) * 1048576;
const TIMEOUT = +process.env.TIMEOUT_MS || 30000;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';          // فعّلها خلف Nginx
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1';      // للتطوير فقط
const BASE = (process.env.BASE_DOMAIN || '').toLowerCase();   // لو اتحط: وضع subdomain لكل موقع
const SUB = !!BASE;
const SCHEME = process.env.PUBLIC_SCHEME || 'https';
const PUBPORT = process.env.PUBLIC_PORT ? ':' + process.env.PUBLIC_PORT : '';
const PORTS = new Set([80, 443, 8080, 8443]);
const PREFIX = '/_px/';
// --- Termux/Android: IPv6 غالباً مش شغال على الشبكة -> IPv4 الأول + fallback سريع ---
try { dns.setDefaultResultOrder('ipv4first'); } catch {}
try { net.setDefaultAutoSelectFamily(true); net.setDefaultAutoSelectFamilyAttemptTimeout(400); } catch {}
process.on('uncaughtException', e => console.error('[uncaught]', e && e.stack || e));   // مايقعش السيرفر (وده اللي بيطلّع 502 من Cloudflare)
process.on('unhandledRejection', e => console.error('[unhandled]', e));
const AGENTS = { 'https:': new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 8 }), 'http:': new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 8 }) };
const RETRY = new Set(['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN']);

let BLOCK = (process.env.BLOCKLIST || '').split(',');
try { BLOCK = BLOCK.concat(fs.readFileSync(path.join(__dirname, 'blocklist.txt'), 'utf8').split(/\r?\n/)); } catch {}
BLOCK = BLOCK.map(s => s.trim().toLowerCase()).filter(s => s && !s.startsWith('#'));
const isBlocked = h => BLOCK.some(b => h === b || h.endsWith('.' + b));

const PUB = path.join(__dirname, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/px-client.js': ['px-client.js', 'application/javascript; charset=utf-8'],
};
for (const k in STATIC) STATIC[k][0] = fs.readFileSync(path.join(PUB, STATIC[k][0]));

const enc = s => Buffer.from(s).toString('base64url');
const dec = s => Buffer.from(s, 'base64url').toString('utf8');
const authToken = ACCESS_KEY ? crypto.createHash('sha256').update('px:' + ACCESS_KEY).digest('hex') : '';
const parseCookies = h => Object.fromEntries((h || '').split(';').map(c => c.trim().split(/=(.*)/s).slice(0, 2)).filter(a => a[0]));

// ---------- SSRF protection ----------
function isPrivate(ip) {
  if (ALLOW_PRIVATE) return false;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
}
// DNS fallback: لو getaddrinfo بتاع Termux فشل (ENOTFOUND) نسأل DNS عام مباشرة
const RES = new dns.Resolver();
try { RES.setServers((process.env.DNS_SERVERS || '1.1.1.1,8.8.8.8,9.9.9.9').split(',').map(s => s.trim()).filter(Boolean)); } catch {}
const DNS_FAIL = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ESERVFAIL', 'ENODATA', 'EAI_NODATA', 'EAI_FAIL']);
function resolveFallback(host, cb) {
  RES.resolve4(host, (e4, a4) => {
    RES.resolve6(host, (e6, a6) => {
      const out = [...(a4 || []).map(address => ({ address, family: 4 })), ...(a6 || []).map(address => ({ address, family: 6 }))];
      out.length ? cb(null, out) : cb(e4 || e6);
    });
  });
}
function safeLookup(hostname, opts, cb) {
  const done = (addrs) => {
    if (addrs.some(a => isPrivate(a.address))) return cb(new Error('blocked-address'));
    addrs.sort((a, b) => a.family - b.family);
    if (opts && opts.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  };
  dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (!err) return done(addrs);
    if (!DNS_FAIL.has(err.code)) return cb(err);
    resolveFallback(hostname, (e2, a2) => {
      if (e2) { console.error('[dns] lookup+fallback failed', hostname, err.code, e2.code); return cb(err); }
      console.error('[dns] fallback ok', hostname);
      done(a2);
    });
  });
}

// ---------- Rate limit ----------
const LOOP = /^(::1|127\.|::ffff:127\.)/;
function clientIp(req) {
  const r = req.socket.remoteAddress || '';
  if (LOOP.test(r) && req.headers['cf-connecting-ip']) return String(req.headers['cf-connecting-ip']).trim();   // cloudflared بيجي من localhost
  return (TRUST_PROXY && req.headers['x-forwarded-for'] || r).split(',')[0].trim();
}
const hits = new Map();
setInterval(() => hits.clear(), 60000).unref();
function limited(ip) { const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n > RATE; }

// ---------- Cookie jar (per session) ----------
const jars = new Map();
function jarFor(sid) {
  let j = jars.get(sid);
  if (!j) { if (jars.size > 5000) jars.delete(jars.keys().next().value); j = []; jars.set(sid, j); }
  return j;
}
function storeCookies(jar, host, list) {
  for (const c of list) {
    const p = c.split(';'); const [n, ...v] = p[0].split('=');
    const ck = { name: n.trim(), value: v.join('='), domain: host, path: '/', secure: false, exp: 0 };
    for (const a of p.slice(1)) {
      const [k, ...vv] = a.split('='); const key = k.trim().toLowerCase(), val = vv.join('=').trim();
      if (key === 'domain') ck.domain = val.replace(/^\./, '').toLowerCase();
      else if (key === 'path') ck.path = val || '/';
      else if (key === 'secure') ck.secure = true;
      else if (key === 'max-age') ck.exp = Date.now() + (+val) * 1000;
      else if (key === 'expires' && !ck.exp) ck.exp = Date.parse(val) || 0;
    }
    if (!(ck.domain === host || host.endsWith('.' + ck.domain))) continue;
    const i = jar.findIndex(x => x.name === ck.name && x.domain === ck.domain && x.path === ck.path);
    if (i >= 0) jar.splice(i, 1);
    if (ck.exp && ck.exp <= Date.now()) continue;
    jar.push(ck);
  }
}
function cookieHeader(jar, u) {
  const now = Date.now();
  return jar.filter(c => (!c.exp || c.exp > now) && (u.hostname === c.domain || u.hostname.endsWith('.' + c.domain)) &&
    u.pathname.startsWith(c.path) && (!c.secure || u.protocol === 'https:')).map(c => c.name + '=' + c.value).join('; ');
}

// ---------- Origin <-> subdomain id ----------
const SECRET = process.env.SECRET || crypto.randomBytes(16).toString('hex');
const OFILE = path.join(__dirname, 'origins.json');
const o2i = new Map(), i2o = new Map();
try { for (const [o, i] of Object.entries(JSON.parse(fs.readFileSync(OFILE, 'utf8')))) { o2i.set(o, i); i2o.set(i, o); } } catch {}
let dirty = false;
setInterval(() => { if (dirty) { dirty = false; try { fs.writeFileSync(OFILE, JSON.stringify(Object.fromEntries(o2i))); } catch {} } }, 5000).unref();
function oid(origin) {
  let i = o2i.get(origin);
  if (!i) {
    if (o2i.size > 100000) return 'o' + '0'.repeat(20);
    i = 'o' + crypto.createHmac('sha256', SECRET).update(origin).digest('hex').slice(0, 20);
    o2i.set(origin, i); i2o.set(i, origin); dirty = true;
  }
  return i;
}
const subUrl = a => `${SCHEME}://${oid(a.origin)}.${BASE}${PUBPORT}${a.pathname}${a.search}${a.hash}`;

// ---------- Rewriting ----------
const SKIP = /^(#|data:|javascript:|mailto:|tel:|blob:|about:)/i;
function rewriteUrl(u, base) {
  if (!u) return u; u = u.trim();
  if (!u || SKIP.test(u)) return u;
  try {
    const a = new URL(u, base);
    if (!/^https?:$/.test(a.protocol)) return u;
    if (SUB) return subUrl(a);
    const h = a.hash; a.hash = '';
    return PREFIX + enc(a.href) + h;
  } catch { return u; }
}
function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => `url(${q}${rewriteUrl(u, base)}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => `@import ${q}${rewriteUrl(u, base)}${q}`);
}
function rewriteHtml(html, base) {
  let b = base;
  html = html.replace(/<base\s[^>]*href\s*=\s*["']?([^"'\s>]+)["']?[^>]*>/i, (m, h) => { try { b = new URL(h, base).href; } catch {} return ''; });
  html = html.replace(/\s(?:integrity|nonce|crossorigin)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '');
  html = html.replace(/(\s(?:href|src|action|formaction|poster|data|background)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (m, pre, a, s, u) => `${pre}"${rewriteUrl((a ?? s ?? u).replace(/&amp;/g, '&'), b).replace(/"/g, '%22')}"`);
  html = html.replace(/(\ssrcset\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (m, pre, a, s) =>
    `${pre}"${(a ?? s).split(',').map(x => { const t = x.trim().split(/\s+/); t[0] = rewriteUrl(t[0], b); return t.join(' '); }).join(', ')}"`);
  html = html.replace(/(<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["']\s*\d+\s*;\s*url=)([^"']+)/gi, (m, pre, u) => pre + rewriteUrl(u, b));
  html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, c, z) => a + rewriteCss(c, b) + z);
  html = html.replace(/(\sstyle\s*=\s*)"([^"]*)"/gi, (m, pre, c) => pre + '"' + rewriteCss(c, b) + '"');
  const tag = `<script>window.__PX=${JSON.stringify({ base: b, sub: SUB ? { base: BASE, scheme: SCHEME, port: PUBPORT } : null }).replace(/</g, '\\u003c')}</script><script src="${SUB ? SCHEME + '://' + BASE + PUBPORT : ''}/px-client.js"></script>`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + tag) : tag + html;
}

// ---------- Proxy core ----------
const STRIP = new Set(['content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'strict-transport-security',
  'set-cookie', 'location', 'link', 'alt-svc', 'report-to', 'nel', 'permissions-policy', 'cross-origin-opener-policy',
  'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'connection', 'keep-alive', 'transfer-encoding']);

function errorPage(res, code, msg) {
  if (res.headersSent) return res.end();
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><body dir=rtl style="font-family:system-ui;background:#0f1117;color:#eee;display:grid;place-items:center;min-height:90vh;text-align:center"><div><h2>⚠️ ${msg}</h2><a style="color:#7aa2ff" href="${SUB ? SCHEME + '://' + BASE + PUBPORT : ''}/">الرجوع للرئيسية</a></div>`);
}
function decompress(buf, encoding) {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buf);
    if (encoding === 'br') return zlib.brotliDecompressSync(buf);
    if (encoding === 'deflate') return zlib.inflateSync(buf);
  } catch {}
  return buf;
}
const hostOf = req => (req.headers.host || '').split(':')[0].toLowerCase();
const isSubHost = req => SUB && hostOf(req) !== BASE && hostOf(req) !== 'www.' + BASE;
const setCookie = (n, v, extra = '') => `${n}=${v}; Path=/; HttpOnly; SameSite=Lax${SUB ? '; Domain=' + BASE : ''}${SCHEME === 'https' ? '; Secure' : ''}${extra}`;

// returns URL | null (not a proxy request) | 'unknown'
function resolveTarget(req) {
  try {
    if (SUB) {
      const m = hostOf(req).match(/^(o[0-9a-f]{20})\.(.+)$/);
      if (!m || m[2] !== BASE) return null;
      const origin = i2o.get(m[1]); if (!origin) return 'unknown';
      return new URL(req.url, origin);
    }
    if (!req.url.startsWith(PREFIX)) return null;
    const [p, q] = req.url.slice(PREFIX.length).split(/\?(.*)/s);
    const t = new URL(dec(p));
    if (q && req.method === 'GET') t.search = t.search ? t.search + '&' + q : '?' + q;
    return t;
  } catch { return 'invalid'; }
}
function checkTarget(t, req) {
  if (!/^https?:$/.test(t.protocol)) return 'رابط غير صالح';
  const host = t.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = +t.port || (t.protocol === 'https:' ? 443 : 80);
  if (isBlocked(host)) return 'الموقع ده محظور على السيرفر';
  if (host === hostOf(req) || (SUB && (host === BASE || host.endsWith('.' + BASE)))) return 'مينفعش تفتح البروكسي من جوه البروكسي';
  if (!ALLOW_PRIVATE && !PORTS.has(port)) return 'البورت ده غير مسموح';
  if (net.isIP(host) && isPrivate(host)) return 'العنوان ده غير مسموح';
  return null;
}
function upstreamHeaders(req, target, jar) {
  const h = {
    'user-agent': req.headers['user-agent'] || 'Mozilla/5.0',
    'accept': req.headers.accept || '*/*',
    'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
  };
  const ref = req.headers.referer || '', m = !SUB && ref.match(/\/_px\/([^/?#]+)/);
  try { h.referer = m ? dec(m[1]) : target.origin + '/'; } catch { h.referer = target.origin + '/'; }
  if (req.headers.origin) h.origin = target.origin;
  const ck = cookieHeader(jar, target); if (ck) h.cookie = ck;
  return h;
}

function handleProxy(req, res, sid, setSid, target) {
  const err = checkTarget(target, req); if (err) return errorPage(res, 403, err);
  const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = +target.port || (target.protocol === 'https:' ? 443 : 80);
  const jar = jarFor(sid);
  const h = upstreamHeaders(req, target, jar);
  h['accept-encoding'] = 'gzip, deflate, br';
  for (const k of ['content-type', 'content-length', 'range', 'if-none-match', 'if-modified-since']) if (req.headers[k]) h[k] = req.headers[k];

  const lib = target.protocol === 'https:' ? https : http;
  const idem = req.method === 'GET' || req.method === 'HEAD';
  let cur = null, gone = false;
  req.on('aborted', () => { gone = true; if (cur) cur.destroy(); });
  res.on('close', () => { if (!res.writableEnded && cur) cur.destroy(); });

  const onResponse = ur => {
    const sc = ur.headers['set-cookie']; if (sc) storeCookies(jar, host, sc);
    const out = {};
    for (const [k, v] of Object.entries(ur.headers)) if (!STRIP.has(k)) out[k] = v;
    if (setSid) out['set-cookie'] = [setCookie('pxsid', sid)];
    if (ur.headers.location) out.location = rewriteUrl(ur.headers.location, target.href);
    const ct = (ur.headers['content-type'] || '').toLowerCase();
    const isHtml = /text\/html|application\/xhtml/.test(ct), isCss = /text\/css/.test(ct);
    ur.on('error', () => res.destroy());
    if (!(isHtml || isCss) || req.method === 'HEAD' || ur.statusCode === 304) { res.writeHead(ur.statusCode, out); return ur.pipe(res); }
    const chunks = []; let size = 0;
    ur.on('data', c => { size += c.length; if (size > MAX_REWRITE) { ur.destroy(); return errorPage(res, 502, 'الصفحة كبيرة قوي'); } chunks.push(c); });
    ur.on('end', () => {
      if (res.headersSent) return;
      try {
        const raw = decompress(Buffer.concat(chunks), (ur.headers['content-encoding'] || '').toLowerCase());
        const cs = (ct.match(/charset=["']?([^;"'\s]+)/) || [])[1] || 'utf-8'; let text;
        try { text = new TextDecoder(cs).decode(raw); } catch { text = raw.toString('utf8'); }
        text = isHtml ? rewriteHtml(text, target.href) : rewriteCss(text, target.href);
        delete out['content-encoding']; delete out['content-length']; delete out['etag'];
        out['content-type'] = (isHtml ? 'text/html' : 'text/css') + '; charset=utf-8';
        out['cache-control'] = 'no-store';
        res.writeHead(ur.statusCode, out); res.end(text);
      } catch (e) { console.error('[rewrite]', target.href.slice(0, 120), e && e.message); errorPage(res, 502, 'فشل تعديل الصفحة'); }
    });
  };

  const attempt = n => {
    let up;
    try {
      up = lib.request({ hostname: host, port, path: target.pathname + target.search, method: req.method, headers: h, lookup: safeLookup,
        timeout: TIMEOUT, agent: AGENTS[target.protocol], maxHeaderSize: 65536 }, onResponse);
    } catch (e) { console.error('[proxy] build', target.href.slice(0, 120), e.code || e.message); return errorPage(res, 502, 'طلب غير صالح (' + (e.code || e.message) + ')'); }
    cur = up;
    up.on('timeout', () => up.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    up.on('error', e => {
      const code = e.code || (e.errors && e.errors[0] && e.errors[0].code) || e.message;
      const all = e.errors ? ' [' + e.errors.map(x => x.address + ':' + x.code).join(', ') + ']' : '';
      console.error('[proxy]', target.href.slice(0, 120), code, all, n ? '(retry ' + n + ')' : '');
      if (gone || res.headersSent) return res.destroy();
      if (idem && n < 2 && RETRY.has(code)) return setTimeout(() => attempt(n + 1), 150);
      errorPage(res, 502, e.message === 'blocked-address' ? 'العنوان ده غير مسموح' : 'مقدرتش أوصل للموقع (' + code + ')');
    });
    if (idem) up.end(); else req.pipe(up);
  };
  attempt(0);
}

// ---------- WebSocket tunnel ----------
function handleUpgrade(req, socket, head) {
  const bye = (code = 400) => { try { socket.end(`HTTP/1.1 ${code} Error\r\nConnection: close\r\n\r\n`); } catch {} };
  const cookies = parseCookies(req.headers.cookie);
  if (ACCESS_KEY && cookies.pxauth !== authToken) return bye(401);
  const ip = clientIp(req);
  if (limited(ip)) return bye(429);
  const target = resolveTarget(req);
  if (!target || typeof target === 'string' || checkTarget(target, req)) return bye(403);
  const sid = cookies.pxsid; if (!sid || !/^[a-f0-9]{32}$/.test(sid)) return bye(401);
  const jar = jarFor(sid), host = target.hostname.replace(/^\[|\]$/g, '');
  const h = upstreamHeaders(req, target, jar);
  h.connection = 'Upgrade'; h.upgrade = 'websocket';
  for (const k of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) if (req.headers[k]) h[k] = req.headers[k];
  h.origin = target.origin;
  const lib = target.protocol === 'https:' ? https : http;
  const up = lib.request({ hostname: host, port: +target.port || (target.protocol === 'https:' ? 443 : 80), path: target.pathname + target.search, method: 'GET', headers: h, lookup: safeLookup, timeout: TIMEOUT });
  up.on('upgrade', (ur, us, uhead) => {
    let r = 'HTTP/1.1 101 Switching Protocols\r\n';
    for (let i = 0; i < ur.rawHeaders.length; i += 2) r += `${ur.rawHeaders[i]}: ${ur.rawHeaders[i + 1]}\r\n`;
    socket.write(r + '\r\n'); if (uhead && uhead.length) socket.write(uhead);
    if (head && head.length) us.write(head);
    us.pipe(socket); socket.pipe(us);
    const kill = () => { us.destroy(); socket.destroy(); }; us.on('error', kill); socket.on('error', kill); us.on('close', kill); socket.on('close', kill);
  });
  up.on('response', r => { bye(r.statusCode || 502); r.resume(); });
  up.on('timeout', () => up.destroy()); up.on('error', () => bye(502));
  up.end();
}

// ---------- Server ----------
const LOGIN = e => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><body dir=rtl style="font-family:system-ui;background:#0f1117;color:#eee;display:grid;place-items:center;min-height:90vh"><form method=post action=/login style="display:grid;gap:10px;width:260px"><h3>🔒 كلمة السر</h3><input type=password name=k autofocus style="padding:10px;border-radius:8px;border:1px solid #333;background:#1a1d27;color:#fff"><button style="padding:10px;border:0;border-radius:8px;background:#4f7cff;color:#fff">دخول</button>${e ? '<small style="color:#f66">كلمة السر غلط</small>' : ''}</form>`;

const server = http.createServer((req, res) => {
  const ip = clientIp(req);
  const cookies = parseCookies(req.headers.cookie);
  const url = req.url.split('?')[0];
  const sub = isSubHost(req);

  if (!sub) {
    if (url === '/health') { res.writeHead(200); return res.end('ok'); }
    if (url === '/login') {
      if (!ACCESS_KEY) { res.writeHead(302, { location: '/' }); return res.end(); }
      if (req.method === 'POST') {
        let body = ''; req.on('data', c => { if (body.length < 1000) body += c; });
        return req.on('end', () => {
          const k = new URLSearchParams(body).get('k') || '';
          if (crypto.createHash('sha256').update('px:' + k).digest('hex') === authToken) { res.writeHead(302, { location: '/', 'set-cookie': setCookie('pxauth', authToken, '; Max-Age=2592000') }); return res.end(); }
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }); res.end(LOGIN(true));
        });
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(LOGIN(false));
    }
  }
  if (ACCESS_KEY && cookies.pxauth !== authToken) {
    if (req.method === 'GET' && (sub || url === '/')) { res.writeHead(302, { location: (SUB ? SCHEME + '://' + BASE + PUBPORT : '') + '/login' }); return res.end(); }
    res.writeHead(401); return res.end('Unauthorized');
  }

  if (!sub) {
    const sec = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    if (STATIC[url]) { res.writeHead(200, { ...sec, 'content-type': STATIC[url][1], 'cache-control': 'no-cache' }); return res.end(STATIC[url][0]); }
    const q = new URL(req.url, 'http://x').searchParams;
    if (url === '/_go') {            // يحوّل أي رابط لرابط البروكسي (path أو subdomain)
      try {
        const t = new URL(q.get('u')); if (!/^https?:$/.test(t.protocol)) throw 0;
        res.writeHead(302, { location: SUB ? subUrl(t) : PREFIX + enc(t.href) + t.hash }); return res.end();
      } catch { return errorPage(res, 400, 'رابط غير صالح'); }
    }
    if (url === '/_oid' && SUB) {    // بيستخدمه الـ client script لتحويل origin لـ subdomain
      try {
        const o = new URL(q.get('o')); if (!/^https?:$/.test(o.protocol)) throw 0;
        const origin = req.headers.origin || '', okOrigin = origin.endsWith('.' + BASE + PUBPORT) || origin.includes('.' + BASE + ':') || origin.endsWith('.' + BASE);
        res.writeHead(200, { 'content-type': 'text/plain', ...(okOrigin ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' } : {}) });
        return res.end(oid(o.origin));
      } catch { res.writeHead(400); return res.end(); }
    }
  }

  const target = resolveTarget(req);
  if (target === null) { res.writeHead(404); return res.end('Not found'); }
  if (target === 'unknown') return errorPage(res, 404, 'الموقع ده غير معروف (افتحه من الصفحة الرئيسية)');
  if (target === 'invalid') return errorPage(res, 400, 'رابط غير صالح');
  if (limited(ip)) { res.writeHead(429, { 'retry-after': '60' }); return res.end('Too many requests'); }
  let sid = cookies.pxsid, setSid = false;
  if (!sid || !/^[a-f0-9]{32}$/.test(sid)) { sid = crypto.randomBytes(16).toString('hex'); setSid = true; }
  handleProxy(req, res, sid, setSid, target);
});
server.on('upgrade', handleUpgrade);
server.listen(PORT, () => console.log(`Proxy running on http://localhost:${PORT} (${SUB ? 'subdomain mode: *.' + BASE : 'path mode'})`));
