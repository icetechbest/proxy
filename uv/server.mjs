// Ultraviolet mode (UNTESTED scaffold - needs `npm install`, written for UV 2.x + bare-server-node 2.x)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBareServer } from '@tomphttp/bare-server-node';
import { uvPath } from '@titaniumnetwork-dev/ultraviolet';

const PORT = +process.env.PORT || 8080;
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const bare = createBareServer('/bare/');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css', '.map': 'application/json' };

function serve(res, file) {
  fs.readFile(file, (e, d) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(d);
  });
}
const safe = (root, rel) => { const f = path.normalize(path.join(root, rel)); return f.startsWith(root) ? f : null; };

const server = http.createServer((req, res) => {
  if (bare.shouldRoute(req)) return bare.routeRequest(req, res);
  const url = decodeURIComponent(req.url.split('?')[0]);
  let f;
  if (url.startsWith('/uv/')) {
    f = safe(pub, url);                                   // uv.config.js (ملفنا) الأول
    if (!f || !fs.existsSync(f)) f = safe(uvPath, url.slice(4)); // وبعدين ملفات المكتبة
  } else f = safe(pub, url === '/' ? '/index.html' : url);
  if (!f) { res.writeHead(400); return res.end(); }
  serve(res, f);
});
server.on('upgrade', (req, socket, head) => bare.shouldRoute(req) ? bare.routeUpgrade(req, socket, head) : socket.end());
server.listen(PORT, () => console.log(`UV proxy on http://localhost:${PORT}`));
