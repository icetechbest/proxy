'use strict';
// تخزين المفاتيح والجلسات في ملف JSON (على Railway لازم Volume عشان يفضل بعد الـ redeploy)
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';           // من غير 0/O/1/I عشان مفيش لخبطة
const DAY = 864e5, SESSION_TTL = 30 * DAY;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const normKey = k => String(k || '').trim().toUpperCase().replace(/\s+/g, '');

class Store {
  constructor(dir) {
    this.dir = dir; this.file = path.join(dir, 'data.json'); this.dirty = false; this.persistent = false;
    this.data = { secret: crypto.randomBytes(24).toString('hex'), keys: [] };
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (d && d.secret) Object.assign(this.data, d); } catch {}
    this.flush(true);
    setInterval(() => this.flush(), 5000).unref();
    process.on('SIGTERM', () => { this.flush(); process.exit(0); });
  }
  flush(force) {
    if (!this.dirty && !force) return;
    try { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.data)); fs.renameSync(tmp, this.file); this.dirty = false; this.persistent = true; }
    catch (e) { this.persistent = false; if (force) console.error('[store] مش قادر أكتب في', this.dir, '(' + (e.code || e.message) + ') - المفاتيح هتتمسح عند الريستارت'); }
  }
  get secret() { return this.data.secret; }
  sign(id, sess) { return crypto.createHmac('sha256', this.secret).update(id + '.' + sess).digest('hex').slice(0, 32); }

  // ---- مفاتيح ----
  create({ label, days, maxDevices }) {
    const b = crypto.randomBytes(16); let s = '';
    for (let i = 0; i < 16; i++) s += ALPHA[b[i] % 32];
    const key = 'PX-' + s.match(/.{4}/g).join('-'), now = Date.now();
    days = Math.max(0, Math.min(3650, +days || 0)); maxDevices = Math.max(0, Math.min(1000, +maxDevices || 0));
    const rec = { id: crypto.randomBytes(5).toString('hex'), label: String(label || '').slice(0, 60) || 'بدون اسم', hash: sha(key), hint: key.slice(0, 7) + '…' + key.slice(-4),
      created: now, expires: days ? now + days * DAY : 0, enabled: true, maxDevices, sessions: {}, logins: 0, requests: 0, lastUsed: 0, lastIp: '' };
    this.data.keys.push(rec); this.dirty = true; this.flush();
    return { key, rec };
  }
  find(id) { return this.data.keys.find(k => k.id === id); }
  status(r) { return !r.enabled ? 'disabled' : (r.expires && r.expires <= Date.now()) ? 'expired' : 'active'; }
  list() {
    return this.data.keys.map(r => ({ id: r.id, label: r.label, hint: r.hint, created: r.created, expires: r.expires, status: this.status(r), maxDevices: r.maxDevices,
      devices: Object.keys(r.sessions).length, logins: r.logins, requests: r.requests, lastUsed: r.lastUsed, lastIp: r.lastIp }));
  }
  update(id, action, arg) {
    const r = this.find(id); if (!r) return false;
    if (action === 'toggle') r.enabled = !r.enabled;
    else if (action === 'extend') { const d = Math.max(1, Math.min(3650, +arg || 30)); r.expires = Math.max(r.expires || 0, Date.now()) + d * DAY; }
    else if (action === 'noexpiry') r.expires = 0;
    else if (action === 'reset') r.sessions = {};
    else if (action === 'rename') r.label = String(arg || '').slice(0, 60) || r.label;
    else if (action === 'devices') r.maxDevices = Math.max(0, Math.min(1000, +arg || 0));
    else if (action === 'delete') this.data.keys = this.data.keys.filter(k => k !== r);
    else return false;
    this.dirty = true; this.flush(); return true;
  }

  // ---- دخول وجلسات ----
  login(input, ip) {
    const h = sha(normKey(input)), r = this.data.keys.find(k => k.hash === h);
    if (!r) return { err: 'bad' };
    if (!r.enabled) return { err: 'disabled' };
    if (r.expires && r.expires <= Date.now()) return { err: 'expired' };
    const now = Date.now();
    for (const s in r.sessions) if (now - r.sessions[s] > SESSION_TTL) delete r.sessions[s];
    if (r.maxDevices && Object.keys(r.sessions).length >= r.maxDevices) return { err: 'devices' };
    const sess = crypto.randomBytes(8).toString('hex');
    r.sessions[sess] = now; r.logins++; r.lastUsed = now; r.lastIp = ip || ''; this.dirty = true;
    return { token: r.id + '.' + sess + '.' + this.sign(r.id, sess), rec: r };
  }
  verify(token) {
    const p = String(token || '').split('.'); if (p.length !== 3) return null;
    const r = this.find(p[0]); if (!r) return null;
    const good = Buffer.from(this.sign(p[0], p[1])), got = Buffer.from(p[2]);
    if (good.length !== got.length || !crypto.timingSafeEqual(good, got)) return null;
    if (!r.enabled || (r.expires && r.expires <= Date.now()) || r.sessions[p[1]] === undefined) return null;
    return { rec: r, sess: p[1] };
  }
  touch(a, ip) { const n = Date.now(); a.rec.requests++; a.rec.sessions[a.sess] = n; a.rec.lastUsed = n; if (ip) a.rec.lastIp = ip; this.dirty = true; }
}
module.exports = { Store, sha };
