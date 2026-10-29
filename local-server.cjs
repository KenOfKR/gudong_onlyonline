'use strict';

// Tiny dependency-free local server for Windows/macOS/Linux development.
// It listens on loopback only; it is not intended for public hosting.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.cwd());
const port = Number(process.env.PORT) || 8000;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav'
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  const file = path.resolve(root, `.${pathname}`);
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      const status = err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 404 : 500;
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(status === 404 ? `File not found: ${pathname}` : 'Internal server error');
      return;
    }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    });
    if (req.method === 'HEAD') res.end();
    else res.end(data);
  });
});

server.on('error', err => {
  console.error(`本機伺服器啟動失敗：${err.message}`);
  if (err.code === 'EADDRINUSE') console.error(`連接埠 ${port} 已被占用，請關閉舊伺服器或改用 PORT=8001。`);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`古董局中局 v10.6.0 本機伺服器已啟動：http://127.0.0.1:${port}`);
  console.log('此伺服器僅監聽本機迴圈位址；按 Ctrl+C 停止。');
});
