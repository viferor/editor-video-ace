// Servidor para la app de la tablet: comparte el proyecto abierto en el PC por la red local (wifi).
// La tablet abre http://<ip-del-pc>:<puerto>/?k=<clave> en el navegador.
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.lrv': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg', '.fit': 'application/octet-stream', '.gpx': 'application/gpx+xml'
};

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  // primero las típicas de casa
  return out.sort((a, b) => (/^192\.168\./.test(b) ? 1 : 0) - (/^192\.168\./.test(a) ? 1 : 0));
}

async function sendFile(req, res, file, cache = false, download = false) {
  let st;
  try { st = await fsp.stat(file); } catch { res.writeHead(404); return res.end(); }
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const size = st.size;
  const range = req.headers.range;
  const common = { 'Content-Type': download ? 'application/octet-stream' : type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache ? 'max-age=3600' : 'no-cache' };
  if (download) {
    const n = path.basename(file);
    common['Content-Disposition'] = `attachment; filename="${n.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(n)}`;
  }
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
    let start = m[1] ? Number(m[1]) : 0;
    let end = m[2] ? Number(m[2]) : size - 1;
    if (!m[1] && m[2]) { start = size - Number(m[2]); end = size - 1; }
    end = Math.min(end, size - 1);
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...common, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  } else {
    res.writeHead(200, { ...common, 'Content-Length': size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }
}

const KINDS = {
  video: /\.(mp4|mov|m4v|mkv|insv)$/i,
  telemetry: /\.(fit|gpx)$/i,
  music: /\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i,
  project: /\.evproj$/i
};

/** Lista una carpeta del PC (solo nombres, tamaños y fechas) para el explorador de la tablet. */
async function browse(dir, kind, shortcuts) {
  const re = KINDS[kind] || /./;
  if (!dir) {
    // raíz: accesos rápidos + unidades
    const roots = [];
    for (const s of shortcuts) {
      try { if ((await fsp.stat(s.path)).isDirectory()) roots.push({ ...s, type: 'dir' }); } catch {}
    }
    if (process.platform === 'win32') {
      for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        const d = l + ':\\';
        try { await fsp.access(d); roots.push({ name: `Unidad ${l}:`, path: d, type: 'dir', drive: true }); } catch {}
      }
    } else roots.push({ name: '/', path: '/', type: 'dir', drive: true });
    return { dir: '', parent: null, entries: roots };
  }
  const abs = path.resolve(dir);
  const names = await fsp.readdir(abs, { withFileTypes: true });
  const entries = [];
  for (const d of names) {
    if (d.name.startsWith('.') || d.name.startsWith('$')) continue;
    const full = path.join(abs, d.name);
    if (d.isDirectory()) entries.push({ name: d.name, path: full, type: 'dir' });
    else if (d.isFile() && re.test(d.name)) {
      let st = null;
      try { st = await fsp.stat(full); } catch {}
      entries.push({ name: d.name, path: full, type: 'file', size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 });
    }
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'es', { numeric: true }) : a.type === 'dir' ? -1 : 1));
  const parent = path.dirname(abs);
  return { dir: abs, parent: parent === abs ? '' : parent, entries };
}

/** Guarda un archivo que sube la tablet (sin cargarlo entero en memoria). */
async function receiveUpload(req, dir, name, onProgress) {
  await fsp.mkdir(dir, { recursive: true });
  const safe = path.basename(String(name || 'archivo')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'archivo';
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let target = path.join(dir, safe);
  for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${stem} (${i})${ext}`);
  const part = target + '.subiendo';
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(part);
    if (onProgress) { let n = 0; req.on('data', (d) => { n += d.length; onProgress(n); }); }
    req.pipe(out);
    req.on('aborted', () => { out.destroy(); reject(new Error('subida interrumpida')); });
    req.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
  }).catch(async (e) => { await fsp.rm(part, { force: true }).catch(() => {}); throw e; });
  await fsp.rename(part, target);
  return target;
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (d) => { n += d.length; if (n > limit) { reject(new Error('demasiado grande')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/**
 * opts: { distDir, iconPath, isAllowed(path), onApply(edits), onExport(opts), onCancelExport(),
 *         analyzeVideo(path, dur), analyzeMusic(path) }
 */
function createTabletServer(opts) {
  const token = opts.token || crypto.randomBytes(6).toString('base64url');
  let state = null;
  let version = 0;
  const waiters = new Set();
  const clients = new Map(); // ip -> { last, ua, version, errors }

  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      const authed = url.searchParams.get('k') === token || req.headers['x-k'] === token;
      // código de la app (no lleva datos del proyecto)
      if (p === '/' || p === '/tablet' || p === '/tablet.html') return sendFile(req, res, path.join(opts.distDir, 'tablet.html'));
      if (p.startsWith('/assets/')) {
        const f = path.join(opts.distDir, path.normalize(p).replace(/^([/\\])+/, ''));
        if (!f.startsWith(opts.distDir)) { res.writeHead(403); return res.end(); }
        return sendFile(req, res, f, true);
      }
      if (p === '/icono.png') return sendFile(req, res, opts.iconPath, true);
      if (p === '/manifest.webmanifest') {
        res.writeHead(200, { 'Content-Type': TYPES['.webmanifest'] });
        return res.end(JSON.stringify({
          name: 'Editor Video Ace', short_name: 'Editor Ace', start_url: `/?k=${token}`, display: 'fullscreen', display_override: ['fullscreen', 'standalone'],
          orientation: 'landscape', background_color: '#111316', theme_color: '#111316',
          icons: [{ src: '/icono.png', sizes: '512x512', type: 'image/png' }]
        }));
      }
      if (!authed) {
        const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
        clients.set(ip, { ...(clients.get(ip) || {}), last: Date.now(), ua: req.headers['user-agent'] || '', stage: 'sin clave (QR antiguo)' });
        return json(res, 401, { error: 'Falta la clave. Vuelve a escanear el código QR del PC.' });
      }

      if (p === '/api/hello' && req.method === 'POST') {
        // la tablet avisa de que ha arrancado (o de un error), aunque aún no tenga datos
        const b = await readBody(req).catch(() => ({}));
        const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
        const c = clients.get(ip) || {};
        clients.set(ip, { ...c, last: Date.now(), ua: req.headers['user-agent'] || '', error: b.error || c.error || null, stage: b.stage || c.stage });
        return json(res, 200, { ok: true, hasState: !!state });
      }
      if (p === '/api/state' && req.method === 'GET') {
        const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
        const c0 = clients.get(ip) || {};
        clients.set(ip, { ...c0, last: Date.now(), ua: req.headers['user-agent'] || '', stage: 'conectada', got: c0.got || !!state });
        const since = Number(url.searchParams.get('since') || -1);
        if (version > since || !state) return json(res, 200, { version, state });
        // espera hasta 20 s a que haya cambios (así la tablet se entera al momento)
        const w = { res, timer: null };
        w.timer = setTimeout(() => { waiters.delete(w); json(res, 200, { version, state }); }, 20000);
        waiters.add(w);
        req.on('close', () => { clearTimeout(w.timer); waiters.delete(w); });
        return;
      }
      if (p === '/api/browse' && req.method === 'GET') {
        try {
          return json(res, 200, await browse(url.searchParams.get('dir') || '', url.searchParams.get('kind') || '', opts.shortcuts ? opts.shortcuts() : []));
        } catch (e) {
          return json(res, 400, { error: 'No se puede abrir esa carpeta: ' + (e.code || e.message) });
        }
      }
      if (p === '/api/upload' && req.method === 'POST') {
        const kind = url.searchParams.get('kind') || 'any';
        const name = url.searchParams.get('name') || '';
        let dir = url.searchParams.get('dir') || '';
        if (kind !== 'any' && (!KINDS[kind] || !KINDS[kind].test(name))) return json(res, 400, { error: 'Tipo de archivo no admitido' });
        if (dir) {
          try { if (!(await fsp.stat(dir)).isDirectory()) throw 0; } catch { return json(res, 400, { error: 'Esa carpeta del PC no existe' }); }
        } else dir = opts.uploadDir(kind);
        const size = Number(req.headers['content-length'] || 0);
        const id = crypto.randomBytes(4).toString('hex');
        opts.onTransfer?.({ id, dir: 'up', name, size, done: 0 });
        try {
          let last = 0;
          const saved = await receiveUpload(req, dir, name, (n) => {
            if (Date.now() - last < 700) return;
            last = Date.now();
            opts.onTransfer?.({ id, dir: 'up', name, size, done: n });
          });
          opts.onTransfer?.({ id, dir: 'up', name, size, done: size, finished: true, path: saved });
          return json(res, 200, { path: saved });
        } catch (e) {
          opts.onTransfer?.({ id, dir: 'up', name, size, done: 0, finished: true, error: e.message });
          throw e;
        }
      }
      if (p === '/api/download') {
        const f = url.searchParams.get('p') || '';
        try { if (!(await fsp.stat(f)).isFile()) throw 0; } catch { res.writeHead(404); return res.end(); }
        if (req.method === 'GET' && !req.headers.range) opts.onTransfer?.({ id: crypto.randomBytes(4).toString('hex'), dir: 'down', name: path.basename(f), finished: true });
        return sendFile(req, res, f, false, true);
      }
      if (p === '/api/command' && req.method === 'POST') {
        const c = await readBody(req);
        try {
          return json(res, 200, { ok: true, result: await opts.onCommand(c) });
        } catch (e) {
          return json(res, 500, { error: String((e && e.message) || e) });
        }
      }
      if (p === '/api/state' && req.method === 'POST') {
        const edits = await readBody(req);
        opts.onApply(edits);
        return json(res, 200, { ok: true });
      }
      if (p === '/api/export' && req.method === 'POST') {
        const o = await readBody(req);
        opts.onExport(o);
        return json(res, 200, { ok: true });
      }
      if (p === '/api/export/cancel' && req.method === 'POST') {
        opts.onCancelExport();
        return json(res, 200, { ok: true });
      }
      if (p === '/api/analyze' && req.method === 'POST') {
        const b = await readBody(req);
        if (!opts.isAllowed(b.path)) return json(res, 403, { error: 'no permitido' });
        return json(res, 200, await opts.analyzeVideo(b.path, b.duration));
      }
      if (p === '/api/audioLevels' && req.method === 'POST') {
        const b = await readBody(req);
        if (!opts.isAllowed(b.path)) return json(res, 403, { error: 'no permitido' });
        return json(res, 200, await opts.audioLevels(b.path));
      }
      if (p === '/api/analyzeMusic' && req.method === 'POST') {
        const b = await readBody(req);
        if (!opts.isAllowed(b.path)) return json(res, 403, { error: 'no permitido' });
        return json(res, 200, await opts.analyzeMusic(b.path));
      }
      if (p === '/media') {
        const f = url.searchParams.get('p') || '';
        if (!opts.isAllowed(f)) { res.writeHead(403); return res.end(); }
        return sendFile(req, res, f);
      }
      res.writeHead(404);
      res.end();
    } catch (e) {
      try { json(res, 500, { error: String(e && e.message || e) }); } catch {}
    }
  });

  return {
    token,
    /** Tablets que se han conectado (para mostrarlo en el PC). */
    clients() {
      return [...clients.entries()].map(([ip, c]) => ({ ip, ...c, ago: Math.round((Date.now() - (c.last || 0)) / 1000) }));
    },
    hasState: () => !!state,
    /** Nuevo estado del proyecto (lo manda el editor del PC): despierta a la tablet. */
    setState(s) {
      state = s;
      version++;
      for (const w of waiters) { clearTimeout(w.timer); json(w.res, 200, { version, state }); }
      waiters.clear();
    },
    async listen(port = 8765) {
      for (let p = port; p < port + 20; p++) {
        const ok = await new Promise((resolve) => {
          server.once('error', () => resolve(false));
          server.listen(p, '0.0.0.0', () => resolve(true));
        });
        if (ok) return p;
      }
      throw new Error('No hay ningún puerto libre');
    },
    close() {
      for (const w of waiters) { clearTimeout(w.timer); try { w.res.end(); } catch {} }
      waiters.clear();
      server.close();
      server.closeAllConnections?.();
    }
  };
}

const newToken = () => crypto.randomBytes(6).toString('base64url');
module.exports = { createTabletServer, lanAddresses, newToken };
