const { app, BrowserWindow, ipcMain, dialog, protocol, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { Readable } = require('stream');
const ff = require('./ffmpeg.cjs');
const { analyzeMusic } = require('./music.cjs');

const isDev = process.argv.includes('--dev');

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }
]);

// Solo se sirven archivos que la app ha abierto o generado.
const allowed = new Set();
const allow = (p) => allowed.add(path.resolve(p).toLowerCase());
const isAllowed = (p) => allowed.has(path.resolve(p).toLowerCase());

const MIME = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.lrv': 'video/mp4', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm' };

function registerMediaProtocol() {
  protocol.handle('media', async (req) => {
    try {
      const url = new URL(req.url);
      const file = decodeURIComponent(url.pathname.slice(1));
      if (!isAllowed(file)) return new Response('forbidden', { status: 403 });
      const { size } = await fsp.stat(file);
      const type = MIME[path.extname(file).toLowerCase()] || 'video/mp4';
      const range = req.headers.get('range');
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
        let start = m[1] ? Number(m[1]) : 0;
        let end = m[2] ? Number(m[2]) : size - 1;
        if (!m[1] && m[2]) { start = size - Number(m[2]); end = size - 1; }
        end = Math.min(end, size - 1);
        if (start > end || start >= size) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        }
        const body = Readable.toWeb(fs.createReadStream(file, { start, end }));
        return new Response(body, {
          status: 206,
          headers: {
            'Content-Type': type,
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': String(end - start + 1),
            'Accept-Ranges': 'bytes'
          }
        });
      }
      const body = Readable.toWeb(fs.createReadStream(file));
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }
      });
    } catch (e) {
      return new Response(String(e), { status: 500 });
    }
  });
}

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#111316',
    title: 'Editor Video Ace',
    icon: path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  if (isDev) {
    win.loadURL('http://127.0.0.1:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
  win.on('close', (e) => {
    if (win && win.__forceClose) return;
    e.preventDefault();
    win.webContents.send('app:before-close');
  });
}

ipcMain.handle('app:close-confirmed', () => {
  if (win) { win.__forceClose = true; win.close(); }
});

// --- Diálogos -------------------------------------------------------------
ipcMain.handle('dialog:openVideos', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Añadir clips de vídeo',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Vídeo', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'insv'] }]
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('dialog:openTelemetry', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Cargar actividad (FIT o GPX)',
    properties: ['openFile'],
    filters: [{ name: 'Actividad', extensions: ['fit', 'gpx'] }]
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:openProject', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Abrir proyecto',
    properties: ['openFile'],
    filters: [{ name: 'Proyecto', extensions: ['evproj'] }]
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:saveProject', async (_e, defaultName) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Guardar proyecto',
    defaultPath: defaultName || 'proyecto.evproj',
    filters: [{ name: 'Proyecto', extensions: ['evproj'] }]
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('dialog:saveExport', async (_e, defaultName) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Exportar vídeo',
    defaultPath: path.join(app.getPath('videos'), defaultName || 'resumen.mp4'),
    filters: [{ name: 'MP4', extensions: ['mp4'] }]
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('dialog:confirm', async (_e, message, buttons) => {
  const r = await dialog.showMessageBox(win, { type: 'question', message, buttons, defaultId: 0, cancelId: buttons.length - 1 });
  return r.response;
});

// --- Archivos ---------------------------------------------------------------
ipcMain.handle('fs:readFile', async (_e, p) => new Uint8Array(await fsp.readFile(p)));
ipcMain.handle('fs:readText', async (_e, p) => fsp.readFile(p, 'utf8'));
ipcMain.handle('fs:writeText', async (_e, p, text) => { await fsp.writeFile(p, text, 'utf8'); return true; });
ipcMain.handle('fs:exists', async (_e, p) => { try { await fsp.access(p); return true; } catch { return false; } });
ipcMain.handle('dialog:openFolder', async (_e, title) => {
  const r = await dialog.showOpenDialog(win, { title: title || 'Elegir carpeta', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
// Busca archivos por nombre dentro de una carpeta (y sus subcarpetas, hasta 6 niveles)
ipcMain.handle('fs:findFiles', async (_e, dir, names) => {
  const want = new Map(names.map((n) => [n.toLowerCase(), n]));
  const found = {};
  const walk = async (d, depth) => {
    if (depth > 6 || Object.keys(found).length === want.size) return;
    let entries = [];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('.') && e.name !== 'node_modules') await walk(full, depth + 1); }
      else if (want.has(e.name.toLowerCase()) && !found[want.get(e.name.toLowerCase())]) found[want.get(e.name.toLowerCase())] = full;
    }
  };
  await walk(dir, 0);
  return found;
});
// Vídeos y actividades (FIT/GPX) de una carpeta: la propia carpeta y sus subcarpetas (hasta 2 niveles, p. ej. DCIM\Camera01)
ipcMain.handle('fs:scanMedia', async (_e, dir) => {
  const videos = [];
  const activities = [];
  const walk = async (d, depth) => {
    let entries = [];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 2 && !e.name.startsWith('.') && !e.name.startsWith('$') && e.name !== 'node_modules') await walk(full, depth + 1);
      } else if (/\.(mp4|mov|m4v|mkv)$/i.test(e.name) && !/\.part\.mp4$/i.test(e.name) && !e.name.startsWith('._')) videos.push(full);
      else if (/\.(fit|gpx)$/i.test(e.name)) activities.push(full);
    }
  };
  await walk(dir, 0);
  const byName = (a, b) => path.basename(a).localeCompare(path.basename(b), 'es', { numeric: true });
  return { videos: videos.sort(byName), activities: activities.sort(byName) };
});
ipcMain.handle('shell:showItem', (_e, p) => shell.showItemInFolder(p));

// --- Vídeo ------------------------------------------------------------------
ipcMain.handle('media:probe', async (_e, p) => {
  allow(p);
  return ff.probe(p);
});

ipcMain.handle('media:encoders', () => ff.detectEncoders());

let proxyDirReady = false;
const proxyDir = () => {
  const d = path.join(app.getPath('userData'), 'proxies');
  fs.mkdirSync(d, { recursive: true });
  if (!proxyDirReady) { ff.cleanPartials(d); proxyDirReady = true; }
  return d;
};

// Sesión de recuperación (el trabajo sin guardar se conserva al cerrar)
ipcMain.handle('app:recoveryPath', () => path.join(app.getPath('userData'), 'sesion-recuperada.evproj'));

/**
 * Las cámaras Insta360 guardan junto a cada VID_xxx.mp4 una copia ligera LRV_xxx.lrv (720p).
 * Si existe y dura lo mismo, sirve directamente de vista previa: no hay que generar nada.
 */
async function findLrv(src, duration) {
  const dir = path.dirname(src), base = path.basename(src);
  if (!/^VID_/i.test(base)) return null;
  const stem = base.replace(/^VID_/i, 'LRV_').replace(/\.[^.]+$/, '');
  for (const ext of ['.lrv', '.LRV']) {
    const p = path.join(dir, stem + ext);
    if (!fs.existsSync(p)) continue;
    try {
      const info = await ff.probe(p);
      if (Math.abs(info.duration - duration) < 1) return p;
    } catch {}
  }
  return null;
}

ipcMain.handle('media:proxy', async (e, src, durationSec) => {
  const info = await ff.probe(src);
  if (!info.duration) info.duration = durationSec;
  const lrv = await findLrv(src, info.duration);
  if (lrv) { allow(lrv); return lrv; }
  const st = await fsp.stat(src);
  // v1 + giro: los proxies de vídeos girados hechos antes de esta corrección se rehacen
  const ver = info.rotation ? `v1|r${info.rotation}` : 'v1';
  const key = crypto.createHash('sha1').update(`${path.resolve(src).toLowerCase()}|${st.size}|${st.mtimeMs}|${ver}`).digest('hex').slice(0, 20);
  const dest = path.join(proxyDir(), key + '.mp4');
  allow(dest);
  if (fs.existsSync(dest)) return dest;
  const enc = await ff.detectEncoders();
  const job = ff.makeProxy(src, dest, info, enc, (pct, eta) => {
    if (!e.sender.isDestroyed()) e.sender.send('proxy:progress', { src, pct, eta });
  });
  return job.done;
});

// Música: elegir canción y detectar su ritmo (se guarda en caché)
ipcMain.handle('dialog:openAny', async (_e, title) => {
  const r = await dialog.showOpenDialog(win, { title: title || 'Elegir archivos', properties: ['openFile', 'multiSelections'] });
  if (r.canceled) return [];
  const out = [];
  for (const p of r.filePaths) { try { out.push({ path: p, name: path.basename(p), size: (await fsp.stat(p)).size }); } catch {} }
  return out;
});
ipcMain.handle('dialog:openMusic', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Elegir música (puedes seleccionar varias canciones con Ctrl o Mayús)',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'] }]
  });
  return r.canceled ? [] : r.filePaths;
});
async function analyzeMusicCached(file) {
  allow(file);
  const st = await fsp.stat(file);
  const key = crypto.createHash('sha1').update(`${path.resolve(file).toLowerCase()}|${st.size}|${st.mtimeMs}|m1`).digest('hex').slice(0, 20);
  const dir = path.join(app.getPath('userData'), 'analisis');
  fs.mkdirSync(dir, { recursive: true });
  const cache = path.join(dir, key + '.musica.json');
  try { return JSON.parse(await fsp.readFile(cache, 'utf8')); } catch {}
  const res = await analyzeMusic(ff.FFMPEG, file);
  await fsp.writeFile(cache, JSON.stringify(res));
  return res;
}
ipcMain.handle('music:analyze', (_e, file) => analyzeMusicCached(file));

// Análisis de vídeo para highlights (se guarda en caché junto a los proxies)
async function analyzeVideoCached(file, duration) {
  const st = await fsp.stat(file);
  const key = crypto.createHash('sha1').update(`${path.resolve(file).toLowerCase()}|${st.size}|${st.mtimeMs}|a1`).digest('hex').slice(0, 20);
  const dir = path.join(app.getPath('userData'), 'analisis');
  fs.mkdirSync(dir, { recursive: true });
  const cache = path.join(dir, key + '.json');
  try { return JSON.parse(await fsp.readFile(cache, 'utf8')); } catch {}
  const res = await ff.analyze(file, duration);
  if (res.motion || res.audio) await fsp.writeFile(cache, JSON.stringify(res));
  return res;
}
ipcMain.handle('media:analyze', (_e, file, duration) => analyzeVideoCached(file, duration));
async function audioLevelsCached(file) {
  const st = await fsp.stat(file);
  const key = crypto.createHash('sha1').update(`${path.resolve(file).toLowerCase()}|${st.size}|${st.mtimeMs}|s1`).digest('hex').slice(0, 20);
  const dir = path.join(app.getPath('userData'), 'analisis');
  fs.mkdirSync(dir, { recursive: true });
  const cache = path.join(dir, key + '.sonido.json');
  try { return JSON.parse(await fsp.readFile(cache, 'utf8')); } catch {}
  const res = await ff.audioLevels(file);
  if (res) await fsp.writeFile(cache, JSON.stringify(res));
  return res;
}
ipcMain.handle('media:audioLevels', (_e, file) => audioLevelsCached(file));

// --- Tablet: servidor en la red local ---------------------------------------
const { createTabletServer, lanAddresses, newToken } = require('./tabletServer.cjs');
// la clave y el puerto se guardan: la dirección de la tablet no cambia de una vez a otra
const tabletCfgPath = () => path.join(app.getPath('userData'), 'tablet.json');
function tabletCfg() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(tabletCfgPath(), 'utf8')); } catch {}
  if (!c.token) { c.token = newToken(); saveTabletCfg(c); }
  return { port: 8765, autoStart: false, ...c };
}
function saveTabletCfg(c) {
  try { fs.mkdirSync(path.dirname(tabletCfgPath()), { recursive: true }); fs.writeFileSync(tabletCfgPath(), JSON.stringify(c, null, 1)); } catch {}
}
let tablet = null;
let tabletInfo = null;
let tabletTelemetry = null;
let commandSeq = 0;
const pendingCommands = new Map();
ipcMain.on('tablet:commandDone', (_e, r) => {
  const p = pendingCommands.get(r.id);
  if (!p) return;
  pendingCommands.delete(r.id);
  clearTimeout(p.timer);
  if (r.ok) p.resolve(r.result); else p.reject(new Error(r.error || 'Error en el PC'));
});
const projectsDir = () => path.join(app.getPath('documents'), 'Editor Video Ace');
ipcMain.handle('project:pathFor', async (_e, name) => {
  const dir = projectsDir();
  await fsp.mkdir(dir, { recursive: true });
  const safe = String(name || 'Proyecto').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'Proyecto';
  let p = path.join(dir, safe + '.evproj');
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${safe} (${i}).evproj`);
  return p;
});
async function startTablet() {
  if (tablet) return tabletInfo;
  const cfg = tabletCfg();
  const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };
  tablet = createTabletServer({
    token: cfg.token,
    distDir: path.join(__dirname, '..', 'dist'),
    iconPath: path.join(__dirname, '..', 'build', 'icon.png'),
    isAllowed: (p) => !!p && (isAllowed(p) || (tabletTelemetry && path.resolve(p).toLowerCase() === path.resolve(tabletTelemetry).toLowerCase())),
    onApply: (edits) => send('tablet:apply', edits),
    onExport: (o) => send('tablet:export', o),
    onCancelExport: () => { if (currentExport) currentExport.cancel(); },
    onCommand: (c) => new Promise((resolve, reject) => {
      if (!win || win.isDestroyed()) return reject(new Error('El editor del PC no está abierto'));
      const id = ++commandSeq;
      const timer = setTimeout(() => { pendingCommands.delete(id); reject(new Error('El PC no respondió')); }, 30 * 60 * 1000);
      pendingCommands.set(id, { resolve, reject, timer });
      win.webContents.send('tablet:command', { id, cmd: c });
    }),
    shortcuts: () => {
      const s = [
        { name: 'Vídeos exportados', path: app.getPath('videos'), icon: '🎬' },
        { name: 'Recibido de la tablet', path: path.join(app.getPath('videos'), 'Editor Video Ace', 'Desde la tablet'), icon: '📥' },
        { name: 'Proyectos', path: projectsDir(), icon: '📁' }
      ];
      for (const [k, n] of [['downloads', 'Descargas'], ['desktop', 'Escritorio'], ['documents', 'Documentos'], ['music', 'Música']]) {
        try { s.push({ name: n, path: app.getPath(k) }); } catch {}
      }
      return s;
    },
    onTransfer: (t) => send('tablet:transfer', t),
    uploadDir: (kind) => path.join(app.getPath('videos'), 'Editor Video Ace', 'Desde la tablet', { video: 'Vídeos', telemetry: 'Actividades', music: 'Música', project: 'Proyectos' }[kind] || 'Otros'),
    analyzeVideo: analyzeVideoCached,
    audioLevels: audioLevelsCached,
    analyzeMusic: analyzeMusicCached
  });
  let port;
  try { port = await tablet.listen(cfg.port); } catch (e) { tablet = null; throw e; }
  const ips = lanAddresses();
  tabletInfo = { port, token: tablet.token, ips, urls: ips.map((ip) => `http://${ip}:${port}/?k=${tablet.token}`), autoStart: !!cfg.autoStart, portChanged: port !== cfg.port };
  send('tablet:started', tabletInfo); // la interfaz empieza a mandar el proyecto
  return tabletInfo;
}
function stopTablet() {
  if (tablet) tablet.close();
  tablet = null;
  tabletInfo = null;
}
ipcMain.handle('tablet:start', () => startTablet());
ipcMain.handle('tablet:setAutoStart', (_e, v) => {
  const c = tabletCfg();
  c.autoStart = !!v;
  saveTabletCfg(c);
  if (tabletInfo) tabletInfo.autoStart = !!v;
  return true;
});
/** Clave nueva: la dirección antigua deja de valer (por si alguien la tiene). */
ipcMain.handle('tablet:newKey', async () => {
  const c = tabletCfg();
  c.token = newToken();
  saveTabletCfg(c);
  const was = !!tablet;
  stopTablet();
  return was ? startTablet() : null;
});
ipcMain.handle('tablet:stop', () => {
  stopTablet();
  return true;
});
ipcMain.handle('tablet:info', () => tabletInfo);
ipcMain.handle('tablet:clients', () => (tablet ? { clients: tablet.clients(), hasState: tablet.hasState() } : null));
ipcMain.on('tablet:state', (_e, s) => {
  if (!tablet) return;
  tabletTelemetry = s && s.telemetryPath;
  tablet.setState(s);
});
ipcMain.handle('export:defaultPath', async (_e, name) => {
  const dir = app.getPath('videos');
  const base = (name || 'resumen').replace(/[\\/:*?"<>|]/g, '_');
  let p = path.join(dir, base + '.mp4');
  for (let n = 2; fs.existsSync(p); n++) p = path.join(dir, `${base} (${n}).mp4`);
  return p;
});

let currentExport = null;
let lastExport = null;
ipcMain.handle('export:start', async (e, job) => {
  if (currentExport) throw new Error('Ya hay una exportación en curso');
  const enc = await ff.detectEncoders();
  const r = ff.runExport(job, enc, app.getPath('temp'), (p) => {
    if (!e.sender.isDestroyed()) e.sender.send('export:progress', p);
  });
  currentExport = r;
  lastExport = r;
  r.done.catch(() => {}).finally(() => { if (currentExport === r) currentExport = null; });
  return { gpu: r.gpu };
});

// Espera a que termine la exportación en curso
ipcMain.handle('export:finish', async () => {
  const r = currentExport || lastExport;
  if (!r) throw new Error('No hay exportación en curso');
  return r.done;
});

// Fotogramas del overlay (datos sobre el vídeo)
ipcMain.handle('export:frame', async (_e, data) => {
  if (!currentExport) return false;
  return currentExport.writeFrame(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
});
ipcMain.handle('export:framesEnd', () => {
  if (currentExport) currentExport.endFrames();
  return true;
});

ipcMain.handle('export:cancel', () => {
  if (currentExport) currentExport.cancel();
  return true;
});

// --- Arranque ---------------------------------------------------------------
// Agrupa la ventana con su propio icono en la barra de tareas de Windows
if (process.platform === 'win32') app.setAppUserModelId('local.editorvideo.ace');

// Una sola copia del editor: si ya está abierto, se trae al frente (y avisa de cómo cargar las novedades).
const singleLock = process.env.EV_MULTI ? true : app.requestSingleInstanceLock();
if (!singleLock) app.quit();
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'Editor Video Ace',
    message: 'El editor ya estaba abierto.',
    detail: 'Para cargar las novedades, ciérralo y vuelve a abrirlo desde el icono.'
  }).catch(() => {});
});

app.whenReady().then(() => {
  if (!singleLock) return;
  registerMediaProtocol();
  // OpenStreetMap exige identificar la aplicación en las peticiones de teselas.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://*.tile.openstreetmap.org/*'] },
    (details, cb) => {
      details.requestHeaders['Referer'] = 'https://github.com/editor-video-ace';
      details.requestHeaders['User-Agent'] = 'EditorVideoAce/0.1 (uso personal)';
      cb({ requestHeaders: details.requestHeaders });
    }
  );
  createWindow();
  ff.detectEncoders().catch(() => {});
  // compartir con la tablet desde que se abre el editor (si está activado)
  if (tabletCfg().autoStart) startTablet().catch((e) => console.error('No se pudo compartir con la tablet:', e.message));
});

app.on('window-all-closed', () => app.quit());
// Que ningún FFmpeg siga trabajando (ni bloqueando archivos) después de cerrar
app.on('will-quit', () => { ff.killAll(); if (tablet) tablet.close(); });
process.on('exit', () => ff.killAll());
