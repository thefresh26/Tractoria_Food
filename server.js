// Servidor para Render: entrega la página y la API (/api?a=...) en el mismo sitio.
const http = require('http');
const fs = require('fs');
const path = require('path');
const handler = require('./api/index.js');

const PAGE = path.join(__dirname, 'index.html');
const MAX_BODY = 2 * 1024 * 1024; // 2 MB: fotos ya llegan comprimidas

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); };

  if (url.pathname === '/api') {
    let body = '', size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { res.status(413).json({ error: 'Archivo muy pesado' }); req.destroy(); return; }
      body += c;
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      req.query = Object.fromEntries(url.searchParams);
      try { req.body = body ? JSON.parse(body) : {}; } catch { return res.status(400).json({ error: 'Datos no válidos' }); }
      handler(req, res);
    });
    return;
  }
  if (url.pathname === '/healthz') return res.end('ok');
  if (url.pathname === '/logo.webp') {
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    return fs.createReadStream(path.join(__dirname, 'logo.webp')).pipe(res);
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(PAGE).pipe(res);
}).listen(process.env.PORT || 3000, () => console.log('Desayunos Trattoria en el puerto', process.env.PORT || 3000));
