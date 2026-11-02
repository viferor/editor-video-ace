// Enlace con la app de la tablet (lado del PC): comparte el estado del proyecto y aplica los cambios que llegan.
import QRCode from 'qrcode';
import { store, recentProjects } from './store';
import { buildProject, folderProjectName, mediaFor } from './projectDialog';
import { exportProject, exportStatus } from './exportDialog';
import type { FileOffer, TabletCommand, TabletEdits, TabletExportOptions, TabletInfo, TabletState } from './types';
import { $, basename, fmtTime, h, toast } from './util';

let info: TabletInfo | null = null;
let busy: string | null = null;
/** Archivos que el PC ofrece a la tablet (los vídeos exportados y los que envías tú). */
let offers: FileOffer[] = [];
let lastOutput: string | null = null;
export function offerToTablet(f: FileOffer) {
  offers = [{ ...f, id: f.id ?? Math.random().toString(36).slice(2, 10), at: Date.now() }, ...offers.filter((o) => o.path !== f.path)].slice(0, 20);
  schedulePush(30);
}
let pushTimer: number | null = null;
/** Recientes que existen (se comprueba aparte porque mirar el disco es asíncrono). */
let recents: string[] = [];
async function refreshRecents() {
  const out: string[] = [];
  for (const p of recentProjects()) if (await window.api.exists(p)) out.push(p);
  if (out.join('|') !== recents.join('|')) { recents = out; schedulePush(30); }
}

export function tabletSnapshot(): TabletState {
  return {
    name: store.projectPath ? basename(store.projectPath).replace(/\.evproj$/i, '') : 'Proyecto sin nombre',
    clips: store.clips.map((c) => ({ id: c.id, path: c.path, name: c.name, probe: c.probe, cameraStamp: c.cameraStamp, offsetMs: c.offsetMs, proxy: c.proxy, proxyPct: c.proxyPct })),
    globalOffsetMs: store.globalOffsetMs,
    stampIsEnd: store.stampIsEnd,
    timeline: store.timeline,
    overlay: store.overlay,
    overlayEnabled: store.overlayEnabled,
    songs: store.songs,
    musicSettings: store.musicSettings,
    transitions: store.transitions,
    telemetryPath: store.telemetryPath,
    exportStatus: { ...exportStatus },
    encoders: store.encoders,
    projectPath: store.projectPath,
    telemetryName: store.telemetry?.name ?? null,
    busy,
    syncLocked: store.syncLocked,
    mapSynced: store.mapSynced,
    offers,
    recents
  };
}

let pushError: string | null = null;
function push() {
  try {
    // copia "plana" (JSON) para que siempre se pueda enviar al proceso principal
    window.api.tabletPush(JSON.parse(JSON.stringify(tabletSnapshot())));
    pushError = null;
  } catch (e) {
    pushError = (e as Error).message;
    console.error('No se pudo enviar el estado a la tablet', e);
  }
}
function schedulePush(delay = 250) {
  if (!info) return;
  if (pushTimer != null) clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => { pushTimer = null; push(); }, delay);
}

/** Aplica en el PC lo que se ha cambiado en la tablet. */
function applyEdits(e: TabletEdits) {
  if (e.timeline) {
    const ids = new Set(store.clips.map((c) => c.id));
    store.timeline = e.timeline.filter((s) => ids.has(s.clipId));
    store.emit('timeline');
  }
  if (e.overlay) { store.overlay = e.overlay; store.emit('overlay'); }
  if (e.overlayEnabled !== undefined) { store.overlayEnabled = e.overlayEnabled; store.emit('overlay'); }
  if (e.transitions) { store.transitions = e.transitions; store.emit('transitions'); }
  if (e.sync) {
    const s = e.sync;
    const changed = s.globalOffsetMs !== store.globalOffsetMs || s.stampIsEnd !== store.stampIsEnd ||
      store.clips.some((c) => c.id in s.clipOffsets && (s.clipOffsets[c.id] ?? null) !== c.offsetMs);
    if (changed) {
      store.pushSync('tablet'); // se puede deshacer también en el PC
      store.globalOffsetMs = s.globalOffsetMs;
      store.stampIsEnd = s.stampIsEnd;
      for (const c of store.clips) if (c.id in s.clipOffsets) c.offsetMs = s.clipOffsets[c.id] ?? null;
      store.emit('sync');
    }
    if (s.mapSynced) store.mapSynced = true;
    if (s.syncLocked !== store.syncLocked) store.setSyncLocked(s.syncLocked);
  }
  if (e.songs || e.musicSettings) {
    if (e.songs) {
      const byId = new Map(store.songs.map((s) => [s.id, s]));
      const ordered = e.songs.map((x) => {
        const s = byId.get(x.id);
        if (s) { s.enabled = x.enabled; s.start = x.start; s.end = x.end; byId.delete(x.id); }
        return s;
      }).filter((s): s is NonNullable<typeof s> => !!s);
      store.songs = [...ordered, ...byId.values()];
    }
    if (e.musicSettings) store.musicSettings = e.musicSettings;
    store.emit('music');
  }
}

async function exportFromTablet(o: TabletExportOptions) {
  if (!store.timeline.length) return;
  const first = store.clip(store.timeline[0].clipId)!;
  const [w, hgt] = o.res === 'source' ? [first.probe.width, first.probe.height] : o.res.split('x').map(Number);
  const output = await window.api.exportDefaultPath((store.telemetry?.name.replace(/\.\w+$/, '') || 'resumen') + '_tablet');
  toast('📱 Exportación iniciada desde la tablet', 'info', 4000);
  try {
    const r = await exportProject({ output, width: w, height: hgt, fps: first.probe.fps, codec: o.codec, quality: o.quality, overlay: o.overlay, music: o.music, from: 'tablet' });
    toast(`📱 Exportado desde la tablet en ${fmtTime(r.seconds)}: ${basename(r.output)}`, 'ok', 8000);
  } catch (e) {
    toast('📱 La exportación pedida desde la tablet falló: ' + (e as Error).message.slice(0, 200), 'error', 9000);
  }
}

function setBusy(msg: string | null) {
  busy = msg;
  schedulePush(30);
}

/** Antes de cambiar de proyecto desde la tablet: lo que no tenga nombre se guarda solo (no se pierde nada). */
async function keepCurrent() {
  if (store.projectPath) { await store.flushAutosave(); return; }
  if (!store.clips.length && !store.timeline.length) return;
  const d = new Date();
  const p = await window.api.projectPathFor(`Sin nombre ${d.toLocaleDateString('es-ES').replace(/\//g, '-')} ${d.getHours()}h${String(d.getMinutes()).padStart(2, '0')}`);
  await store.saveTo(p, false);
  toast('El proyecto sin nombre se ha guardado en Documentos\\Editor Video Ace', 'info', 5000);
}

async function runCommand(c: TabletCommand): Promise<unknown> {
  try {
    switch (c.cmd) {
      case 'newProject': {
        setBusy('Creando el proyecto…');
        await keepCurrent();
        store.reset();
        const p = await window.api.projectPathFor(c.name);
        await store.saveTo(p, false);
        toast(`📱 Proyecto nuevo desde la tablet: ${basename(p)}`, 'ok', 4000);
        return { path: p };
      }
      case 'newFrom': {
        setBusy(c.folder ? 'Buscando los vídeos de la carpeta…' : 'Abriendo los vídeos…');
        const m = await mediaFor({ folder: c.folder, videos: c.videos });
        if (c.folder && !m.videos.length) throw new Error(`No hay vídeos MP4/MOV en «${basename(c.folder)}» ni en sus subcarpetas`);
        await keepCurrent();
        setBusy(`Abriendo ${m.videos.length} vídeo${m.videos.length === 1 ? '' : 's'}…`);
        const p = await buildProject({ name: c.name || (c.folder ? folderProjectName(c.folder) : null), videos: m.videos });
        let activity: string | null = null;
        if (m.activities.length === 1) {
          setBusy('Leyendo la actividad…');
          activity = m.activities[0];
          try {
            await store.loadTelemetry(activity);
            if (store.clips.length) store.autoSync(true);
            store.setSyncLocked(false);
          } catch { activity = null; }
        }
        toast(`📱 Proyecto nuevo desde la tablet: ${basename(p)} (${store.clips.length} vídeos${activity ? ' · ' + basename(activity) : ''})`, 'ok', 5000);
        // con varias actividades, la tablet pregunta cuál
        return { path: p, clips: store.clips.length, activity, activities: activity ? [] : m.activities };
      }
      case 'openProject': {
        setBusy('Abriendo el proyecto…');
        if (store.projectPath && store.projectPath.toLowerCase() === c.path.toLowerCase()) return { path: c.path };
        await keepCurrent();
        await store.load(c.path);
        return { path: c.path };
      }
      case 'rename': {
        const p = await window.api.projectPathFor(c.name);
        await store.saveTo(p, false);
        return { path: p };
      }
      case 'addClips': {
        setBusy(`Abriendo ${c.paths.length} vídeo${c.paths.length === 1 ? '' : 's'}…`);
        const added = await store.addClips(c.paths);
        if (c.toTimeline) {
          for (const k of added) store.addToTimeline(k.id);
          store.emit('timeline');
        }
        if (!store.projectPath && added.length) {
          // para que se guarde solo desde el principio
          await store.saveTo(await window.api.projectPathFor(store.telemetry?.name.replace(/\.\w+$/, '') || 'Proyecto tablet'), false);
        }
        return { added: added.length, skipped: c.paths.length - added.length };
      }
      case 'removeClip':
        store.removeClip(c.id);
        return true;
      case 'loadTelemetry': {
        setBusy('Leyendo la actividad…');
        const tel = await store.loadTelemetry(c.path);
        let sync = '';
        if (store.clips.length) sync = store.autoSync(true);
        store.setSyncLocked(false);
        const km = ((tel.points[tel.points.length - 1].dist ?? 0) / 1000).toFixed(1);
        return { name: tel.name, km, points: tel.points.length, sync };
      }
      case 'addSongs': {
        setBusy('Analizando el ritmo de las canciones…');
        const added = await store.addSongs(c.paths, (m) => setBusy(m));
        return { added: added.length };
      }
    }
    throw new Error('Orden desconocida');
  } finally {
    setBusy(null);
  }
}

// avisos en el PC de lo que sube o baja la tablet
const transferToasts = new Map<string, HTMLElement>();
function onTransfer(t: { id: string; dir: 'up' | 'down'; name: string; size?: number; done?: number; finished?: boolean; error?: string; path?: string }) {
  if (t.dir === 'down') { toast(`📱 La tablet está descargando ${t.name}`, 'info', 4000); return; }
  let el = transferToasts.get(t.id);
  if (t.finished) {
    el?.remove();
    transferToasts.delete(t.id);
    if (t.error) toast(`📱 Falló la subida de ${t.name}: ${t.error}`, 'error', 6000);
    else toast(`📥 Recibido de la tablet: ${t.path}`, 'ok', 6000);
    return;
  }
  if (!el) { el = toast('', 'info', 24 * 3600 * 1000); transferToasts.set(t.id, el); }
  const pct = t.size ? Math.round(((t.done ?? 0) / t.size) * 100) : 0;
  el.textContent = `📥 Recibiendo de la tablet: ${t.name} · ${pct} %`;
}

export function initTabletLink() {
  // si el editor ya comparte al arrancar (opción «siempre»), enganchar
  const attach = (i: TabletInfo | null) => { if (i) { info = i; updateTabletButton(); push(); } };
  window.api.onTabletStarted(attach);
  window.api.tabletInfo().then(attach).catch(() => {});
  window.api.onTabletTransfer(onTransfer);
  window.api.onTabletCommand(runCommand);
  window.api.onTabletApply(applyEdits);
  window.api.onTabletExport(exportFromTablet);
  store.on((what) => {
    // un vídeo recién exportado se ofrece para bajarlo a la tablet
    if (what === 'export' && !exportStatus.running && !exportStatus.error && exportStatus.output && exportStatus.output !== lastOutput) {
      lastOutput = exportStatus.output;
      const out = exportStatus.output;
      window.api.exists(out).then((ok) => { if (ok) offerToTablet({ path: out, name: basename(out), size: 0 }); });
    }
    // el avance de las vistas fluidas, como mucho cada 2 s
    if (what === 'proxy-progress') { if (pushTimer == null) schedulePush(2000); return; }
    if (what === 'saved' || what === 'all') refreshRecents();
    schedulePush(what === 'export' ? 50 : 250);
  });
  refreshRecents();
}

export async function openTabletDialog() {
  const dlg = h('div', { class: 'modal-back' });
  dlg.innerHTML = `
  <div class="modal">
    <h2>📱 Revisar y retocar en la tablet</h2>
    <div id="tb-body" class="muted">Arrancando…</div>
    <div class="modal-actions">
      <button id="tb-stop" class="danger">Dejar de compartir</button>
      <button id="tb-send">📤 Enviar archivos a la tablet…</button>
      <span class="spacer"></span>
      <button id="tb-ok" class="primary">Listo</button>
    </div>
  </div>`;
  document.body.append(dlg);
  $('#tb-ok', dlg).onclick = () => dlg.remove();
  $('#tb-send', dlg).onclick = async () => {
    const fs = await window.api.openAny('Archivos para enviar a la tablet');
    for (const f of fs) offerToTablet(f);
    if (fs.length) toast(`📤 ${fs.length === 1 ? fs[0].name : fs.length + ' archivos'}: en la tablet aparece el aviso para descargarlo`, 'ok', 5000);
  };
  $('#tb-stop', dlg).onclick = async () => {
    await window.api.tabletStop();
    info = null;
    updateTabletButton();
    dlg.remove();
    toast('La tablet ya no puede conectarse hasta que vuelvas a compartir (la dirección sigue siendo la misma)', 'info', 4500);
  };
  try {
    info = await window.api.tabletStart();
    updateTabletButton();
    push();
    const body = $('#tb-body', dlg);
    if (!info.urls.length) {
      body.innerHTML = 'No se encontró ninguna red. Conecta el PC a la misma wifi que la tablet.';
      return;
    }
    const url = info.urls[0];
    const qr = await QRCode.toDataURL(url, { width: 260, margin: 1, color: { dark: '#111316', light: '#ffffff' } });
    body.innerHTML = '';
    body.append(
      h('div', { class: 'tb-wrap' },
        h('img', { src: qr, class: 'tb-qr', alt: 'Código QR' }),
        h('div', {},
          h('ol', { class: 'tb-steps' },
            h('li', {}, 'Conecta la tablet a la ', h('b', {}, 'misma wifi'), ' que este PC.'),
            h('li', {}, 'Escanea el código con la cámara de la tablet (o escribe la dirección en Chrome).'),
            h('li', {}, 'Opcional: en el menú de Chrome, «Añadir a pantalla de inicio» para tenerla como una app.')),
          h('div', { class: 'tb-url mono' }, url),
          info.urls.length > 1 ? h('div', { class: 'small' }, 'Otras direcciones: ', ...info.urls.slice(1).map((u) => h('div', { class: 'mono' }, u))) : null,
          h('div', { class: 'tb-status', id: 'tb-status' }, 'Comprobando…'),
          h('p', { class: 'small' }, '✔ Esta dirección ', h('b', {}, 'no cambia'), ': guárdala en la tablet (Chrome → ⋮ → «Añadir a pantalla de inicio») y ábrela cuando quieras.',
            info.portChanged ? h('span', { class: 'warn-text' }, ` ⚠ Hoy usa el puerto ${info.port} porque el 8765 estaba ocupado.`) : null),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'tb-auto' }), ' Compartir con la tablet siempre al abrir el editor'),
          h('div', { class: 'row gap' }, h('button', { id: 'tb-key', class: 'chip', title: 'La dirección antigua deja de funcionar' }, '🔑 Cambiar la clave')),
          h('p', { class: 'small' }, 'Si Windows pregunta por el firewall, permite el acceso en redes privadas. ',
            'Los cambios que hagas en la tablet aparecen aquí al momento y se guardan en el proyecto. El PC tiene que seguir encendido con el editor abierto.')))
    );
    const auto = dlg.querySelector<HTMLInputElement>('#tb-auto')!;
    auto.checked = !!info.autoStart;
    auto.onchange = () => { window.api.tabletSetAutoStart(auto.checked); toast(auto.checked ? 'Se compartirá solo cada vez que abras el editor' : 'Ya no se comparte solo al abrir el editor', 'ok', 3000); };
    dlg.querySelector<HTMLButtonElement>('#tb-key')!.onclick = async () => {
      if ((await window.api.confirm('¿Cambiar la clave? La dirección guardada en la tablet dejará de funcionar y tendrás que escanear el código nuevo.', ['Cambiar', 'Cancelar'])) !== 0) return;
      info = await window.api.tabletNewKey();
      dlg.remove();
      openTabletDialog();
    };
    // estado de la conexión, en directo
    const tick = async () => {
      if (!document.body.contains(dlg)) return;
      const st = await window.api.tabletClients().catch(() => null);
      const el = dlg.querySelector<HTMLElement>('#tb-status');
      if (el && st) {
        const recent = st.clients.filter((c) => c.ago < 30);
        const browser = (ua: string) => (/Chrome\/(\d+)/.exec(ua)?.[0] || /Firefox\/(\d+)/.exec(ua)?.[0] || /Version\/[\d.]+.*Safari/.exec(ua)?.[0] || 'navegador').replace('/', ' ');
        el.className = 'tb-status ' + (recent.some((c) => c.stage === 'conectada') ? 'ok' : recent.length ? 'warn' : '');
        el.innerHTML = '';
        if (pushError) el.append(h('div', {}, '⚠ El PC no pudo preparar los datos: ' + pushError));
        else if (!st.hasState) el.append(h('div', {}, '⚠ El PC aún no ha enviado el proyecto.'));
        if (!recent.length) el.append(h('div', {}, '○ Todavía no se ha conectado ninguna tablet.'));
        for (const c of recent) {
          el.append(h('div', {}, `${c.stage === 'conectada' ? (c.got ? '● Conectada y con el proyecto' : '◐ Conectada, esperando el proyecto') : '◐ ' + (c.stage || 'abriendo')}: ${browser(c.ua)} · ${c.ip}` + (c.error ? ` · error: ${c.error}` : '')));
        }
      }
      setTimeout(tick, 2000);
    };
    tick();
  } catch (e) {
    $('#tb-body', dlg).textContent = 'No se pudo compartir: ' + (e as Error).message;
  }
}

export function updateTabletButton() {
  const b = document.getElementById('b-tablet');
  if (b) { b.classList.toggle('on', !!info); b.textContent = info ? '📱 Tablet ●' : '📱 Tablet'; }
}
