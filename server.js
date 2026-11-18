'use strict';
// Simple Web Proxy - zero dependencies, Node 18+
const http = require('http'), https = require('https'), zlib = require('zlib'), dns = require('dns');
const net = require('net'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Store } = require('./lib/store');
const { rewriteJs, jsAvailable } = require('./lib/jsrewrite');

const PORT = +process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || process.env.ACCESS_KEY || '';   // كلمة سر الأدمن (لوحة /_admin). لو فاضية: الموقع مفتوح للكل (تطوير بس!)
const ON_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');   // المفاتيح والكوكيز (على Railway اربط Volume)
const SEARX = (process.env.SEARXNG_URL || '').replace(/\/+$/, '');   // اختياري: عنوان SearXNG بتاعك
const JS_MAX = (+process.env.JS_MAX_MB || 4) * 1048576;
const JS_BYPASS = (process.env.JS_BYPASS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const RATE = +process.env.RATE_LIMIT || 900;                  // طلبات/دقيقة لكل IP
const MAX_REWRITE = (+process.env.MAX_REWRITE_MB || 8) * 1048576;
const TIMEOUT = +process.env.TIMEOUT_MS || 30000;
const TRUST_PROXY = process.env.TRUST_PROXY ? process.env.TRUST_PROXY === '1' : ON_RAILWAY;   // خلف Nginx/Railway
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1';      // للتطوير فقط
const JS_REWRITE = process.env.JS_REWRITE !== '0' && jsAvailable;
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
const store = new Store(DATA_DIR);
if (ON_RAILWAY && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.DATA_DIR) console.error('[تحذير] مفيش Volume متربط: المفاتيح هتتمسح مع كل redeploy. اربط Volume على /data');
if (!ADMIN_KEY) console.error('[تحذير] ADMIN_KEY مش متظبط: الموقع مفتوح للكل ولوحة الأدمن معطّلة');
const SW_ON = !SUB;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/px-client.js': ['px-client.js', 'application/javascript; charset=utf-8'],
  '/sw.js': ['sw.js', 'application/javascript; charset=utf-8', { 'service-worker-allowed': '/' }],
};
for (const k in STATIC) STATIC[k][0] = fs.readFileSync(path.join(PUB, STATIC[k][0]));
STATIC['/'][0] = Buffer.from(STATIC['/'][0].toString('utf8').replace('<!--CFG-->', `<script>window.__CFG=${JSON.stringify({ searx: !!SEARX, sw: SW_ON })}</script>`));
const ADMIN_HTML = fs.readFileSync(path.join(PUB, 'admin.html'));

const enc = s => Buffer.from(s).toString('base64url');
const dec = s => Buffer.from(s, 'base64url').toString('utf8');
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
  if (TRUST_PROXY && req.headers['x-real-ip']) return String(req.headers['x-real-ip']).trim();
  return (TRUST_PROXY && req.headers['x-forwarded-for'] || r).split(',')[0].trim();
}
const hits = new Map();
setInterval(() => hits.clear(), 60000).unref();
function limited(ip) { const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n > RATE; }

// ---------- Cookie jar (per session) ----------
const jars = new Map(), JFILE = path.join(DATA_DIR, 'cookies.json');
let jarsDirty = false;
try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(JFILE, 'utf8')))) jars.set(k, v); } catch {}
function saveJars() {
  if (!jarsDirty) return; jarsDirty = false;
  const now = Date.now(), o = {};
  for (const [k, j] of jars) { const live = j.filter(c => !c.exp || c.exp > now); if (live.length) o[k] = live; }
  try { const t = JFILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, JFILE); } catch {}
}
setInterval(saveJars, 10000).unref();
process.on('SIGTERM', saveJars);
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
    jar.push(ck); jarsDirty = true;
  }
}
function cookieHeader(jar, u) {
  const now = Date.now();
  return jar.filter(c => (!c.exp || c.exp > now) && (u.hostname === c.domain || u.hostname.endsWith('.' + c.domain)) &&
    u.pathname.startsWith(c.path) && (!c.secure || u.protocol === 'https:')).map(c => c.name + '=' + c.value).join('; ');
}

// ---------- Origin <-> subdomain id ----------
const SECRET = process.env.SECRET || store.secret;
const OFILE = path.join(DATA_DIR, 'origins.json');
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
// فك روابط التتبع بتاعة محركات البحث (DuckDuckGo / Google / Bing) عشان نروح للموقع مباشرة من غير قفزة زيادة بتفلت بره البروكسي
function unwrap(a) {
  try {
    const h = a.hostname.replace(/^www\./, '');
    let t = null;
    if (h === 'duckduckgo.com' || h === 'html.duckduckgo.com') { if (a.pathname === '/l/' || a.pathname === '/l') t = a.searchParams.get('uddg'); }
    else if (/^google\.[a-z.]+$/.test(h)) { if (a.pathname === '/url') t = a.searchParams.get('q') || a.searchParams.get('url'); }
    else if (h === 'bing.com') {
      if (a.pathname.startsWith('/ck/a')) { const v = a.searchParams.get('u'); if (v && /^a1/.test(v)) t = Buffer.from(v.slice(2), 'base64url').toString('utf8'); }
    }
    if (t && /^https?:\/\//i.test(t)) return new URL(t);
  } catch {}
  return a;
}
function rewriteUrl(u, base) {
  if (!u) return u; u = u.trim();
  if (!u || SKIP.test(u)) return u;
  try {
    let a = new URL(u, base);
    if (!/^https?:$/.test(a.protocol)) return u;
    a = unwrap(a);
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
  // <meta http-equiv=refresh content="0; url='...'"> (بيدعم الاقتباس الداخلي وغير المقتبس)
  html = html.replace(/<meta\b[^>]*>/gi, tag => {
    if (!/http-equiv\s*=\s*["']?refresh/i.test(tag)) return tag;
    return tag.replace(/(content\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i, (m, pre, a, s, u) => {
      const v = a ?? s ?? u, q = a != null ? '"' : s != null ? "'" : '"';
      const nv = v.replace(/(^\s*[\d.]*\s*[;,]\s*url\s*=\s*)(['"]?)([^'";]+)\2/i, (mm, p2, q2, link) => p2 + q2 + rewriteUrl(link.replace(/&amp;/g, '&'), b).replace(/"/g, '%22') + q2);
      return pre + q + nv + q;
    });
  });
  html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, c, z) => a + rewriteCss(c, b) + z);
  if (JS_REWRITE) {
    html = html.replace(/(<script\b([^>]*)>)([\s\S]*?)(<\/script>)/gi, (m, open, attrs, body, close) => {
      const t = (attrs.match(/\stype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
      if (t && !/^(module|(text|application)\/(x-)?(java|ecma)script)$/i.test(t)) return m;
      return open + rewriteJs(body) + close;
    });
    const unesc = v => v.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    html = html.replace(/(\son[a-z]+\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (m, pre, a, s2) => {
      const v = a ?? s2, q = a != null ? '"' : "'"; if (!/location/.test(v)) return m;
      const nv = rewriteJs(unesc(v)); if (nv === unesc(v)) return m;
      return pre + q + nv.replace(/&/g, '&amp;').replace(q === '"' ? /"/g : /'/g, q === '"' ? '&quot;' : '&#39;') + q;
    });
  }
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
const setAdminCookie = (v, extra = '') => `pxadmin=${v}; Path=/_admin; HttpOnly; SameSite=Strict${SCHEME === 'https' ? '; Secure' : ''}${extra}`;

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
  for (const k of ['content-type', 'content-length', 'range', 'if-range', 'if-none-match', 'if-modified-since']) if (req.headers[k]) h[k] = req.headers[k];
  if (req.headers.range) h['accept-encoding'] = 'identity';   // الميديا: مفيش ضغط عشان الـ range يشتغل صح
  const MEDIA_TO = 180000;

  const lib = target.protocol === 'https:' ? https : http;
  const idem = req.method === 'GET' || req.method === 'HEAD';
  let cur = null, gone = false;
  req.on('aborted', () => { gone = true; if (cur) cur.destroy(); });
  res.on('close', () => { if (!res.writableEnded && cur) cur.destroy(); });

  const onResponse = ur => {
    const sc = ur.headers['set-cookie']; if (sc) storeCookies(jar, host, sc);
    const out = {};
    for (const [k, v] of Object.entries(ur.headers)) if (!STRIP.has(k)) out[k] = v;
    if (setSid) out['set-cookie'] = [setCookie('pxsid', sid, '; Max-Age=31536000')];
    if (ur.headers.location) out.location = rewriteUrl(ur.headers.location, target.href);
    if (ur.headers.refresh) out.refresh = ur.headers.refresh.replace(/(^\s*[\d.]*\s*[;,]\s*url\s*=\s*)(['"]?)([^'";]+)\2/i, (m, p2, q2, link) => p2 + q2 + rewriteUrl(link, target.href) + q2);
    const ct = (ur.headers['content-type'] || '').toLowerCase();
    const isHtml = /text\/html|application\/xhtml/.test(ct), isCss = /text\/css/.test(ct);
    const dest = String(req.headers['sec-fetch-dest'] || '');
    const isJs = JS_REWRITE && /javascript|ecmascript/.test(ct) && !/worker/.test(dest) && !JS_BYPASS.some(b => host === b || host.endsWith('.' + b)) &&
      !(+ur.headers['content-length'] > JS_MAX) && ur.statusCode === 200;
    ur.on('error', () => res.destroy());
    if (/^(video|audio)\//.test(ct) || /octet-stream|mpegurl/.test(ct)) { try { ur.socket.setTimeout(MEDIA_TO); } catch {} }   // فيديو/صوت: مهلة أطول
    if (!(isHtml || isCss || isJs) || req.method === 'HEAD' || ur.statusCode === 304) { res.writeHead(ur.statusCode, out); return ur.pipe(res); }
    const chunks = []; let size = 0, passthru = false;
    ur.on('data', c => {
      if (passthru) return res.write(c);
      size += c.length;
      if (size > (isJs ? JS_MAX : MAX_REWRITE)) {
        if (isJs) { passthru = true; res.writeHead(ur.statusCode, out); res.write(Buffer.concat(chunks)); chunks.length = 0; return res.write(c); }   // JS كبير: يعدي زي ما هو
        ur.destroy(); return errorPage(res, 502, 'الصفحة كبيرة قوي');
      }
      chunks.push(c);
    });
    ur.on('end', () => {
      if (passthru) return res.end();
      if (res.headersSent) return;
      try {
        const raw = decompress(Buffer.concat(chunks), (ur.headers['content-encoding'] || '').toLowerCase());
        const cs = (ct.match(/charset=["']?([^;"'\s]+)/) || [])[1] || 'utf-8'; let text;
        try { text = new TextDecoder(cs).decode(raw); } catch { text = raw.toString('utf8'); }
        text = isHtml ? rewriteHtml(text, target.href) : isJs ? rewriteJs(text) : rewriteCss(text, target.href);
        delete out['content-encoding']; delete out['content-length']; delete out['etag'];
        out['content-type'] = (isHtml ? 'text/html' : isJs ? 'application/javascript' : 'text/css') + '; charset=utf-8';
        if (!isJs) out['cache-control'] = 'no-store';
        res.writeHead(ur.statusCode, out); res.end(text);
      } catch (e) { console.error('[rewrite]', target.href.slice(0, 120), e && e.message); errorPage(res, 502, 'فشل تعديل الصفحة'); }
    });
  };

  const attempt = n => {
    let up;
    try {
      up = lib.request({ hostname: host, port, path: target.pathname + target.search, method: req.method, headers: h, lookup: safeLookup,
        timeout: req.headers.range ? MEDIA_TO : TIMEOUT, agent: AGENTS[target.protocol], maxHeaderSize: 65536 }, onResponse);
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
  if (!authOf(cookies)) return bye(401);
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

// ---------- Auth (مفاتيح + أدمن) ----------
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const eq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const adminSig = ADMIN_KEY ? crypto.createHmac('sha256', SECRET).update('admin:' + ADMIN_KEY).digest('hex') : '';
const ROOT_URL = SUB ? SCHEME + '://' + BASE + PUBPORT : '';
function authOf(cookies) {                       // null = مش مسموح | {admin:true} | {rec,sess} | {open:true}
  if (!ADMIN_KEY) return { open: true };
  const t = cookies.pxauth; if (!t) return null;
  if (t.startsWith('admin.')) return eq(t.slice(6), adminSig) ? { admin: true } : null;
  return store.verify(t);
}
const fails = new Map();                          // حماية من تخمين المفاتيح
const isBlockedIp = ip => { const a = (fails.get(ip) || []).filter(t => Date.now() - t < 600000); fails.set(ip, a); return a.length >= 8; };
const failIp = ip => { const a = fails.get(ip) || []; a.push(Date.now()); fails.set(ip, a); if (fails.size > 5000) fails.delete(fails.keys().next().value); };
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MSG = { bad: 'المفتاح غلط', disabled: 'المفتاح ده معطّل', expired: 'المفتاح ده انتهت صلاحيته', devices: 'المفتاح ده وصل للحد الأقصى من الأجهزة', rate: 'محاولات كتير. استنى شوية وجرّب تاني' };
const PAGE = (title, action, err, val, ph) => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body dir=rtl style="font-family:system-ui;background:#0f1117;color:#eee;display:grid;place-items:center;min-height:90vh"><form method=post action=${action} style="display:grid;gap:10px;width:min(92vw,300px)"><h3 style="margin:0">${esc(title)}</h3><input name=k value="${esc(val || '')}" placeholder="${esc(ph)}" autocomplete=off autocapitalize=off spellcheck=false autofocus style="padding:11px;border-radius:8px;border:1px solid #333;background:#1a1d27;color:#fff;direction:ltr;text-align:center"><button style="padding:11px;border:0;border-radius:8px;background:#4f7cff;color:#fff">دخول</button>${err ? '<small style="color:#f66">' + esc(MSG[err] || err) + '</small>' : ''}</form>`;
const readBody = (req, max, cb) => { let b = '', big = false; req.on('data', c => { if (b.length < max) b += c; else big = true; }); req.on('end', () => cb(big ? '' : b)); };
const sendJson = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
const sendHtml = (res, code, h, extra = {}) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra }); res.end(h); };

function handleLogin(req, res, ip, q) {
  if (!ADMIN_KEY) { res.writeHead(302, { location: '/' }); return res.end(); }
  if (req.method !== 'POST') return sendHtml(res, 200, PAGE('🔑 أدخل مفتاح الدخول', '/_login', '', q.get('k'), 'PX-XXXX-XXXX-XXXX-XXXX'));
  if (isBlockedIp(ip)) return sendHtml(res, 429, PAGE('🔑 أدخل مفتاح الدخول', '/_login', 'rate', '', 'PX-XXXX-XXXX-XXXX-XXXX'));
  readBody(req, 1000, body => {
    const k = (new URLSearchParams(body).get('k') || '').trim();
    let token = k && eq(sha(k), sha(ADMIN_KEY)) ? 'admin.' + adminSig : '', err = 'bad';
    if (!token && k) { const r = store.login(k, ip); if (r.token) token = r.token; else err = r.err; }
    if (!token) { failIp(ip); return sendHtml(res, 401, PAGE('🔑 أدخل مفتاح الدخول', '/_login', err, '', 'PX-XXXX-XXXX-XXXX-XXXX')); }
    res.writeHead(302, { location: ROOT_URL + '/', 'set-cookie': setCookie('pxauth', token, '; Max-Age=2592000') }); res.end();
  });
}

function handleAdmin(req, res, url, cookies, ip) {
  if (!ADMIN_KEY) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('ADMIN_KEY غير متظبط'); }
  const loginPage = err => sendHtml(res, err === 'rate' ? 429 : err ? 401 : 200, PAGE('🛠 دخول الأدمن', '/_admin/login', err, '', 'ADMIN_KEY'), { 'x-frame-options': 'DENY' });
  if (url === '/_admin/login' && req.method === 'POST') {
    if (isBlockedIp(ip)) return loginPage('rate');
    return readBody(req, 1000, body => {
      const k = new URLSearchParams(body).get('k') || '';
      if (!eq(sha(k), sha(ADMIN_KEY))) { failIp(ip); return loginPage('bad'); }
      res.writeHead(302, { location: '/_admin', 'set-cookie': [setAdminCookie(adminSig, '; Max-Age=86400'), setCookie('pxauth', 'admin.' + adminSig, '; Max-Age=2592000')] }); res.end();
    });
  }
  if (url === '/_admin/logout') { res.writeHead(204, { 'set-cookie': [setAdminCookie('', '; Max-Age=0')] }); return res.end(); }
  const isAdmin = cookies.pxadmin && eq(cookies.pxadmin, adminSig);
  if (!isAdmin) return url === '/_admin' && req.method === 'GET' ? loginPage('') : sendJson(res, 401, { error: 'unauthorized' });
  if (url === '/_admin') return sendHtml(res, 200, ADMIN_HTML, { 'x-frame-options': 'DENY' });
  if (req.headers['x-px-admin'] !== '1') return sendJson(res, 403, { error: 'forbidden' });
  if (url === '/_admin/api/keys' && req.method === 'GET') return sendJson(res, 200, { keys: store.list(), persistent: store.persistent });
  if (url === '/_admin/api/keys' && req.method === 'POST')
    return readBody(req, 4000, body => { try {
      const d = JSON.parse(body || '{}'), { key, rec } = store.create(d);
      sendJson(res, 200, { key, id: rec.id });
    } catch { sendJson(res, 400, { error: 'bad request' }); } });
  const m = url.match(/^\/_admin\/api\/keys\/([a-f0-9]{10})$/);
  if (m && req.method === 'POST')
    return readBody(req, 4000, body => { try {
      const d = JSON.parse(body || '{}');
      store.update(m[1], String(d.action), d.arg) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'not found' });
    } catch { sendJson(res, 400, { error: 'bad request' }); } });
  sendJson(res, 404, { error: 'not found' });
}

// ---------- بحث عبر SearXNG (اختياري) ----------
function handleSearch(req, res, q) {
  if (!SEARX) return errorPage(res, 404, 'SearXNG مش متظبط (SEARXNG_URL)');
  const term = (q.get('q') || '').trim().slice(0, 300), page = Math.max(1, Math.min(20, +q.get('p') || 1));
  const render = (body, err) => {
    const px = JSON.stringify({ base: 'http://x/', sub: SUB ? { base: BASE, scheme: SCHEME, port: PUBPORT } : null }).replace(/</g, '\\u003c');
    sendHtml(res, 200, `<!doctype html><html dir=rtl lang=ar><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(term || 'بحث')}</title>
<style>body{font:15px system-ui;background:#0f1117;color:#eceef5;margin:0;padding:16px}.w{max-width:720px;margin:0 auto}form{display:flex;gap:8px;margin-bottom:18px}input{flex:1;min-width:0;padding:12px;border-radius:10px;border:1px solid #272b3b;background:#171a24;color:#fff;direction:ltr;font:inherit}button{padding:12px 16px;border:0;border-radius:10px;background:#4f7cff;color:#fff;font:inherit}
.r{margin:0 0 20px}.r a.t{color:#8ab4ff;font-size:17px;text-decoration:none;display:block;direction:ltr;text-align:start}.r a.t:hover{text-decoration:underline}.r small{display:block;color:#7fbf8f;direction:ltr;text-align:start;margin:2px 0}.r p{margin:4px 0 0;color:#b8bdd0;line-height:1.55}
.a{background:#171a24;border:1px solid #272b3b;border-radius:10px;padding:12px;margin-bottom:16px}.sg a,.pg a{display:inline-block;margin:0 0 8px 8px;padding:6px 12px;border-radius:99px;background:#171a24;border:1px solid #272b3b;color:#eceef5;text-decoration:none}.e{color:#f99;text-align:center;padding:30px}</style>
<div class=w><form action=/_search><input name=q value="${esc(term)}" autofocus placeholder="ابحث..."><button>بحث</button></form>${body}</div>
<script>window.__PX=${px};window.__PX.base=location.href</script><script src="/px-client.js"></script>`);
  };
  if (!term) return render('');
  const u = new URL(SEARX + '/search'); u.search = new URLSearchParams({ q: term, format: 'json', pageno: page, safesearch: '0' }).toString();
  const lib = u.protocol === 'https:' ? https : http;
  const rq = lib.request(u, { method: 'GET', timeout: 12000, headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' } }, ur => {
    const ch = []; let n = 0;
    ur.on('data', c => { n += c.length; if (n < 3e6) ch.push(c); });
    ur.on('end', () => {
      let j; try { j = JSON.parse(Buffer.concat(ch).toString('utf8')); } catch { return render('<div class=e>رد SearXNG مش JSON. فعّل <code>json</code> في search.formats في settings.yml</div>'); }
      let h = '';
      for (const a of (j.answers || []).slice(0, 2)) h += `<div class=a>${esc(typeof a === 'string' ? a : a.answer || '')}</div>`;
      const list = (j.results || []).filter(r => /^https?:\/\//i.test(r.url || ''));
      for (const r of list) { let host = ''; try { host = new URL(r.url).hostname; } catch {}
        h += `<div class=r><a class=t href="${esc(rewriteUrl(r.url, r.url))}">${esc(r.title || r.url)}</a><small>${esc(host)}</small>${r.content ? '<p>' + esc(r.content.slice(0, 280)) + '</p>' : ''}</div>`; }
      if (!list.length) h += '<div class=e>مفيش نتايج</div>';
      const sg = (j.suggestions || []).slice(0, 6); if (sg.length) h += '<div class=sg>' + sg.map(x => `<a href="/_search?q=${encodeURIComponent(x)}">${esc(x)}</a>`).join('') + '</div>';
      h += '<div class=pg>' + (page > 1 ? `<a href="/_search?q=${encodeURIComponent(term)}&p=${page - 1}">→ السابق</a>` : '') + (list.length ? `<a href="/_search?q=${encodeURIComponent(term)}&p=${page + 1}">التالي ←</a>` : '') + '</div>';
      render(h);
    });
  });
  rq.on('timeout', () => rq.destroy(new Error('timeout')));
  rq.on('error', e => { console.error('[searx]', e.code || e.message); if (!res.headersSent) render('<div class=e>مقدرتش أوصل لـ SearXNG (' + esc(e.code || e.message) + ')</div>'); });
  rq.end();
}

// ---------- Server ----------
const server = http.createServer((req, res) => {
  const ip = clientIp(req);
  const cookies = parseCookies(req.headers.cookie);
  const url = req.url.split('?')[0];
  const sub = isSubHost(req);

  if (!sub) {
    if (url === '/health') { res.writeHead(200); return res.end('ok'); }
    if (url === '/_login') return handleLogin(req, res, ip, new URL(req.url, 'http://x').searchParams);
    if (url === '/_logout') { res.writeHead(302, { location: '/_login', 'set-cookie': [setCookie('pxauth', '', '; Max-Age=0')] }); return res.end(); }
    if (url === '/_admin' || url.startsWith('/_admin/')) return handleAdmin(req, res, url, cookies, ip);
  }
  const auth = authOf(cookies);
  if (!auth) {
    if (req.method === 'GET' && (sub || url === '/' || url === '/_go' || url === '/_search')) { res.writeHead(302, { location: ROOT_URL + '/_login' }); return res.end(); }
    res.writeHead(401); return res.end('Unauthorized');
  }

  if (!sub) {
    const sec = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    if (STATIC[url]) { res.writeHead(200, { ...sec, 'content-type': STATIC[url][1], 'cache-control': 'no-cache', ...(STATIC[url][2] || {}) }); return res.end(STATIC[url][0]); }
    const q = new URL(req.url, 'http://x').searchParams;
    if (url === '/_search') { if (auth.rec) store.touch(auth, ip); return handleSearch(req, res, q); }
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
  if (auth.rec) store.touch(auth, ip);
  let sid = cookies.pxsid, setSid = false;
  if (!sid || !/^[a-f0-9]{32}$/.test(sid)) { sid = crypto.randomBytes(16).toString('hex'); setSid = true; }
  handleProxy(req, res, sid, setSid, target);
});
server.on('upgrade', handleUpgrade);
server.listen(PORT, () => console.log(`Proxy running on port ${PORT} (${SUB ? 'subdomain mode: *.' + BASE : 'path mode'}) | keys: ${ADMIN_KEY ? 'on' : 'OFF'} | js-rewrite: ${JS_REWRITE ? 'on' : 'off'} | searxng: ${SEARX ? 'on' : 'off'} | data: ${DATA_DIR}`));
