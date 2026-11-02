// App de la tablet: revisar y retocar el proyecto que está abierto en el PC.
import { KEY, command, nextState, postCancelExport, postEdits, postExport } from './tabletApi';
import { dirOf, downloadToTablet, openTransfer, pickFiles } from './tabletFiles';
import './styles.css';
import './tablet.css';
import { store } from './store';
import { parseFit, parseGpx } from './telemetry';
import { TimelinePlayer } from './player';
import { paintOverlay } from './overlayView';
import { openDataEditor, dataEditing } from './tabletData';
import { openHighlightsDialog } from './highlightsDialog';
import { openMusicDialog } from './musicDialog';
import { openTransitionsDialog, TRANSITIONS } from './transitionsDialog';
import { clipColor, mountSyncView } from './syncView';
import type { ExportStatus, Segment, TabletState } from './types';
import { $, basename, clamp, fmtTime, h, toast, uid } from './util';

store.autosave = false;
(window as unknown as { __tabletStarted: boolean }).__tabletStarted = true;
function hello(body: Record<string, unknown>) {
  fetch(`/api/hello?k=${encodeURIComponent(KEY)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}
hello({ stage: 'app cargada' });
window.addEventListener('error', (e) => { hello({ error: String(e.message).slice(0, 200) }); showProblem('Error en la app: ' + e.message); });
window.addEventListener('unhandledrejection', (e) => { hello({ error: String((e.reason && e.reason.message) || e.reason).slice(0, 200) }); });
function showProblem(msg: string) {
  const el = document.getElementById('t-empty');
  if (el) { el.style.display = ''; el.textContent = msg; }
}
const MIN_SEG = 0.3;

const app = $('#app');
app.innerHTML = `
  <header class="t-top">
    <div class="brand">Editor <b>Ace</b> <span class="muted">· tablet</span></div>
    <button class="t-title" id="t-name" title="Proyecto">Conectando…</button>
    <span class="t-conn" id="t-conn" title="Conexión con el PC">●</span>
    <span class="t-busy" id="t-busy" hidden></span>
    <span class="spacer"></span>
    <button id="t-proj">📁 Proyecto</button>
    <button id="t-clips">🎞 Clips</button>
    <button id="t-sync" title="Sincronizar con el mapa">🗺 Sincro</button>
    <button id="t-files">⇅ Archivos</button>
    <button id="t-hl" class="accent">✨ Highlights</button>
    <button id="t-mus">🎵 Música</button>
    <button id="t-tr" title="Transiciones">⧉ Transic.</button>
    <button id="t-data">📊 Datos</button>
    <button id="t-exp" class="primary" title="Exportar en el PC">⇪ Exportar</button>
    <button id="t-fs" class="t-fs" title="Pantalla completa">⛶</button>
  </header>
  <main class="t-main">
    <div class="video-box big" id="t-box">
      <video id="t-video" playsinline preload="auto"></video>
      <canvas id="t-canvas" class="ov-canvas"></canvas>
      <div class="nodata" id="t-empty">Conectando con el PC…</div>
      <div class="t-vfs-bar"><button id="t-vfs-play" class="t-btn big">▶</button><button id="t-vfs-exit" class="t-btn">⤡ Salir</button></div>
    </div>
    <div class="t-transport">
      <button id="t-start" class="t-btn">⏮</button>
      <button id="t-play" class="t-btn big">▶</button>
      <span id="t-time" class="mono">0:00 / 0:00</span>
      <input type="range" id="t-scrub" min="0" max="1000" value="0" class="grow">
      <button id="t-vfs" class="t-btn" title="Ver solo el vídeo a pantalla completa">⤢</button>
    </div>
  </main>
  <section class="t-tl">
    <div class="t-tools">
      <button id="t-left" class="t-btn" title="Mover a la izquierda">◀</button>
      <button id="t-right" class="t-btn" title="Mover a la derecha">▶</button>
      <button id="t-in" class="t-btn">⟦ Inicio aquí</button>
      <button id="t-out" class="t-btn">Fin aquí ⟧</button>
      <button id="t-split" class="t-btn">✂ Dividir</button>
      <button id="t-del" class="t-btn danger">🗑</button>
      <span class="spacer"></span>
      <button id="t-undo" class="t-btn">↶</button>
      <button id="t-redo" class="t-btn">↷</button>
      <button id="t-zout" class="t-btn">−</button>
      <button id="t-zin" class="t-btn">＋</button>
    </div>
    <div class="t-scroll" id="t-scroll">
      <div class="t-inner" id="t-inner">
        <div class="t-track" id="t-track"></div>
        <div class="t-music" id="t-music"></div>
        <div class="t-head" id="t-head"></div>
      </div>
    </div>
    <div class="t-info muted" id="t-info"></div>
  </section>
`;

const video = $<HTMLVideoElement>('#t-video');
const canvas = $<HTMLCanvasElement>('#t-canvas');
const player = new TimelinePlayer(video);
const audio = new Audio();
let selected: string | null = null;
let zoom = 1;

// ------------------------------------------------------------ sincronización con el PC
let version = -1;
let applying = false;
let pushTimer: number | null = null;
let pushing = false;
let telemetryLoaded: string | null = null;
let lastStatus: ExportStatus | null = null;
let name = '';
let remote: TabletState | null = null;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function applyRemote(s: TabletState) {
  applying = true;
  try {
    if (!s || !Array.isArray(s.clips)) throw new Error('datos del PC incompletos');
    name = s.name;
    remote = s;
    $('#t-name').textContent = s.name;
    const b = $('#t-busy');
    b.hidden = !s.busy;
    b.textContent = s.busy ? '⏳ ' + s.busy : '';
    // se actualizan los clips que ya había (la vista de sincronización guarda referencias a ellos)
    const old = new Map(store.clips.map((c) => [c.id, c]));
    store.clips = s.clips.map((c) => Object.assign(old.get(c.id) ?? {}, c, { proxyPct: c.proxy ? 1 : (c as { proxyPct?: number }).proxyPct ?? 0 }));
    store.globalOffsetMs = s.globalOffsetMs;
    store.stampIsEnd = s.stampIsEnd;
    store.syncLocked = !!s.syncLocked;
    store.mapSynced = !!s.mapSynced;
    store.encoders = s.encoders;
    // solo se toca lo que ha cambiado (así no se pierde el deshacer de la tablet con el "eco" del PC)
    if (!same(store.timeline, s.timeline)) { store.timeline = s.timeline; store.resetTimelineHistory(); }
    // mientras se arrastra un dato en el editor de datos, no se pisa
    if (!dataEditing.dragging && !same(store.overlay, s.overlay)) store.overlay = s.overlay;
    store.overlayEnabled = s.overlayEnabled;
    if (!same(store.songs, s.songs)) store.songs = s.songs;
    store.musicSettings = s.musicSettings;
    store.transitions = s.transitions;
    if (!s.telemetryPath && telemetryLoaded) { telemetryLoaded = null; store.telemetry = null; store.telemetryPath = null; }
    if (s.telemetryPath && s.telemetryPath !== telemetryLoaded) {
      telemetryLoaded = s.telemetryPath;
      try {
        const nm = basename(s.telemetryPath);
        store.telemetry = /\.fit$/i.test(nm)
          ? parseFit(await window.api.readFile(s.telemetryPath), nm)
          : parseGpx(await window.api.readText(s.telemetryPath), nm);
        store.telemetryPath = s.telemetryPath;
      } catch { toast('No se pudo leer la actividad del PC', 'error'); }
    }
    showExport(s.exportStatus);
    $('#t-empty').textContent = '';
    store.emit('all', false);
    showOffers(s.offers || []);
    window.dispatchEvent(new Event('tablet-state'));
    if (clipsRefresh) clipsRefresh();
    hello({ stage: `datos recibidos: ${s.clips.length} clips, ${s.timeline.length} momentos` });
  } catch (e) {
    hello({ error: 'al aplicar los datos: ' + (e as Error).message });
    showProblem('No se pudieron mostrar los datos del PC: ' + (e as Error).message);
  } finally {
    applying = false;
  }
}

async function poll() {
  for (;;) {
    try {
      const r = await fetch(`/api/state?k=${encodeURIComponent(KEY)}&since=${version}`);
      if (r.status === 401) {
        setConn(false, 'Falta la clave: vuelve a escanear el código QR del PC');
        return;
      }
      const j = await r.json();
      setConn(true);
      if (j.state && j.version !== version) {
        version = j.version;
        // si hay un cambio de la tablet pendiente de llegar al PC, no se pisa: el PC enseguida manda el estado nuevo
        if (pushTimer == null && !pushing) await applyRemote(j.state);
      } else if (!j.state) {
        showProblem('Conectado con el PC, pero el editor aún no ha enviado el proyecto. Abre un proyecto en el PC.');
        await new Promise((res) => setTimeout(res, 1500));
      }
    } catch {
      setConn(false, 'Sin conexión con el PC. ¿Está encendido, con el editor abierto y en la misma wifi?');
      await new Promise((res) => setTimeout(res, 2500));
    }
  }
}

function setConn(ok: boolean, msg?: string) {
  const c = $('#t-conn');
  c.classList.toggle('ok', ok);
  c.title = ok ? 'Conectado con el PC' : msg || 'Sin conexión';
  if (!ok && msg) $('#t-empty').textContent = msg;
}

/** Cambios hechos en la tablet → al PC (agrupados). */
function schedulePush() {
  if (pushTimer != null) clearTimeout(pushTimer);
  pushTimer = window.setTimeout(async () => {
    pushTimer = null;
    pushing = true;
    try {
      await postEdits({
        sync: {
          globalOffsetMs: store.globalOffsetMs,
          stampIsEnd: store.stampIsEnd,
          syncLocked: store.syncLocked,
          mapSynced: store.mapSynced,
          clipOffsets: Object.fromEntries(store.clips.map((c) => [c.id, c.offsetMs]))
        },
        timeline: store.timeline,
        overlay: store.overlay,
        overlayEnabled: store.overlayEnabled,
        songs: store.songs.map((s) => ({ id: s.id, enabled: s.enabled, start: s.start, end: s.end })),
        musicSettings: store.musicSettings,
        transitions: store.transitions
      });
    } catch (e) {
      toast('No se pudo enviar el cambio al PC: ' + (e as Error).message, 'error');
    } finally {
      pushing = false;
    }
  }, 300);
}

store.on((what) => {
  if (!applying && ['timeline', 'overlay', 'transitions', 'music', 'sync', 'lock'].includes(what)) schedulePush();
  if (['timeline', 'all', 'music', 'transitions', 'clips'].includes(what)) { renderTimeline(); if (!player.playing) player.seek(player.T); }
  if (['overlay', 'sync', 'telemetry', 'all'].includes(what)) paint();
});

// ------------------------------------------------------------ vista previa
function syncMusic() {
  const songs = store.activeSongs();
  const st = store.musicSettings;
  video.volume = songs.length ? clamp(st.origVolume, 0, 1) : 1;
  const at = songs.length ? store.songAt(player.T) : null;
  if (!at) { if (!audio.paused) audio.pause(); return; }
  const src = window.api.mediaUrl(at.song.path);
  const switched = audio.dataset.src !== src;
  if (switched) { audio.src = src; audio.dataset.src = src; }
  const end = Math.min(store.timelineDuration(), store.musicLength());
  const fade = st.fadeOut > 0 ? clamp((end - player.T) / st.fadeOut, 0, 1) : 1;
  audio.volume = clamp(st.volume * fade, 0, 1);
  if (!player.playing) { if (!audio.paused) audio.pause(); return; }
  if (audio.paused || switched) { audio.currentTime = at.songTime; audio.play().catch(() => {}); }
  else if (Math.abs(audio.currentTime - at.songTime) > 0.3) audio.currentTime = at.songTime;
}

function paint() {
  const empty = $('#t-empty');
  empty.style.display = store.timeline.length ? 'none' : '';
  if (version >= 0 && !store.timeline.length)
    empty.textContent = store.clips.length
      ? 'El montaje está vacío. Pulsa 🎞 Clips para poner vídeos en la línea de tiempo, o ✨ Highlights para que se haga solo.'
      : 'Proyecto sin vídeos. Pulsa 🎞 Clips para añadirlos y 📁 Proyecto para cargar la actividad (FIT/GPX).';
  if (store.overlayEnabled) paintOverlay(canvas, player.current());
  else canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  const total = store.timelineDuration();
  $('#t-time').textContent = `${fmtTime(player.T)} / ${fmtTime(total)}`;
  const scrub = $<HTMLInputElement>('#t-scrub');
  if (!scrubbing && total) scrub.value = String((player.T / total) * 1000);
  $('#t-play').textContent = player.playing ? '❚❚' : '▶';
  $('#t-vfs-play').textContent = player.playing ? '❚❚' : '▶';
  $('#t-head').style.left = `${player.T * pps()}px`;
  if (player.playing) {
    const sc = $('#t-scroll');
    const x = player.T * pps();
    if (x > sc.scrollLeft + sc.clientWidth - 60 || x < sc.scrollLeft) sc.scrollLeft = x - 60;
  }
}
player.onUpdate = () => { paint(); syncMusic(); };
let lastW = 0;
new ResizeObserver(() => {
  paint();
  // solo si cambia el ancho (si no, cambiar un texto podría provocar redibujados sin fin)
  const w = $('#t-scroll').clientWidth;
  if (w !== lastW) { lastW = w; renderTimeline(); }
}).observe($('#t-box'));

let scrubbing = false;
const scrub = $<HTMLInputElement>('#t-scrub');
scrub.addEventListener('pointerdown', () => (scrubbing = true));
scrub.addEventListener('pointerup', () => (scrubbing = false));
scrub.oninput = () => { player.pause(); player.seek((Number(scrub.value) / 1000) * store.timelineDuration()); };
$('#t-play').onclick = () => player.toggle();
video.onclick = () => player.toggle();
$('#t-start').onclick = () => { player.pause(); player.seek(0); $('#t-scroll').scrollLeft = 0; };

// ------------------------------------------------------------ línea de tiempo táctil
const pps = () => {
  const total = Math.max(1, store.timelineDuration());
  return Math.max(2, (($('#t-scroll').clientWidth - 24) / total) * zoom);
};
const starts = () => { const r: number[] = []; let a = 0; for (const s of store.timeline) { r.push(a); a += s.out - s.in; } return r; };

function renderTimeline() {
  const k = pps();
  const track = $('#t-track');
  track.innerHTML = '';
  const total = store.timelineDuration();
  $('#t-inner').style.width = `${Math.max($('#t-scroll').clientWidth, total * k + 40)}px`;
  store.timeline.forEach((s) => {
    const c = store.clip(s.clipId);
    if (!c) return;
    const w = (s.out - s.in) * k;
    const el = h('div', { class: 't-seg' + (s.id === selected ? ' sel' : ''), style: `width:${w}px;--c:${clipColor(c)}` },
      h('span', {}, w > 50 ? fmtTime(s.out - s.in, true) : ''));
    el.onclick = (e) => {
      e.stopPropagation();
      selected = s.id;
      const i = store.timeline.indexOf(s);
      player.pause();
      // toque: selecciona y lleva el cabezal al punto tocado del momento
      const rect = el.getBoundingClientRect();
      const frac = clamp((e.clientX - rect.left) / rect.width, 0, 0.999);
      player.seek(starts()[i] + frac * (s.out - s.in));
      renderTimeline();
    };
    track.append(el);
  });
  // transiciones
  if (store.transitions.type !== 'none') {
    let acc = 0;
    store.timeline.forEach((s, i) => { acc += s.out - s.in; if (i < store.timeline.length - 1) track.append(h('div', { class: 'tr-mark', style: `left:${acc * k}px` }, '◆')); });
  }
  // música
  const lane = $('#t-music');
  lane.innerHTML = '';
  let off = 0;
  for (const s of store.activeSongs()) {
    const len = s.end - s.start;
    lane.append(h('div', { class: 't-song', style: `left:${off * k}px;width:${len * k}px` }, `🎵 ${s.name}`));
    off += len;
  }
  const sel = store.timeline.find((x) => x.id === selected);
  document.querySelectorAll<HTMLButtonElement>('#t-left, #t-right, #t-in, #t-out, #t-del').forEach((b) => (b.disabled = !sel));
  $<HTMLButtonElement>('#t-undo').disabled = !store.canUndoTimeline;
  $<HTMLButtonElement>('#t-redo').disabled = !store.canRedoTimeline;
  $('#t-info').textContent = `${store.timeline.length} momentos · ${fmtTime(total)}` +
    (store.activeSongs().length ? ` · 🎵 ${fmtTime(store.musicLength())}` : '') +
    (store.transitions.type !== 'none' ? ` · ⧉ ${(TRANSITIONS.find((t) => t[0] === store.transitions.type)?.[1] ?? '').split(' (')[0]}` : '') +
    (sel ? ' · toca los botones de arriba para editar el momento seleccionado' : ' · toca un momento para seleccionarlo');
  paint();
}

$('#t-scroll').addEventListener('click', (e) => {
  const rect = $('#t-inner').getBoundingClientRect();
  player.pause();
  player.seek((e.clientX - rect.left) / pps());
});

function current() {
  const loc = store.locate(player.T);
  return loc ? { ...loc, local: player.T - loc.segStart } : null;
}
const edit = (fn: () => void) => { fn(); store.emit('timeline'); };
$('#t-left').onclick = () => edit(() => {
  const i = store.timeline.findIndex((s) => s.id === selected);
  if (i > 0) [store.timeline[i - 1], store.timeline[i]] = [store.timeline[i], store.timeline[i - 1]];
});
$('#t-right').onclick = () => edit(() => {
  const i = store.timeline.findIndex((s) => s.id === selected);
  if (i >= 0 && i < store.timeline.length - 1) [store.timeline[i + 1], store.timeline[i]] = [store.timeline[i], store.timeline[i + 1]];
});
$('#t-split').onclick = () => {
  const cur = current();
  if (!cur) return;
  const at = cur.seg.in + cur.local;
  if (at - cur.seg.in < MIN_SEG || cur.seg.out - at < MIN_SEG) return;
  edit(() => {
    const right: Segment = { id: uid(), clipId: cur.seg.clipId, in: at, out: cur.seg.out };
    cur.seg.out = at;
    store.timeline.splice(cur.idx + 1, 0, right);
    selected = right.id;
  });
};
$('#t-in').onclick = () => {
  const cur = current();
  if (!cur || cur.seg.out - (cur.seg.in + cur.local) < MIN_SEG) return;
  edit(() => { cur.seg.in += cur.local; selected = cur.seg.id; });
  player.seek(starts()[cur.idx]);
};
$('#t-out').onclick = () => {
  const cur = current();
  if (!cur || cur.local < MIN_SEG) return;
  edit(() => { cur.seg.out = cur.seg.in + cur.local; selected = cur.seg.id; });
};
$('#t-del').onclick = () => {
  if (!selected) return;
  edit(() => { store.timeline = store.timeline.filter((s) => s.id !== selected); selected = null; });
};
$('#t-undo').onclick = () => store.undoTimeline();
$('#t-redo').onclick = () => store.redoTimeline();
$('#t-zin').onclick = () => { zoom = Math.min(40, zoom * 1.6); renderTimeline(); };
$('#t-zout').onclick = () => { zoom = Math.max(1, zoom / 1.6); renderTimeline(); };

// ------------------------------------------------------------ menús
$('#t-hl').onclick = () => { player.pause(); openHighlightsDialog(); };
$('#t-mus').onclick = () => { player.pause(); openMusicDialog(); };
$('#t-tr').onclick = () => { player.pause(); openTransitionsDialog(); };

$('#t-data').onclick = () => { player.pause(); openDataEditor(() => paint()); };

// ------------------------------------------------------------ proyecto y archivos (los hace el PC)
/** Ejecuta una orden en el PC y espera a que llegue el estado nuevo. */
async function run<T>(c: Parameters<typeof command>[0], wait = true): Promise<T | null> {
  try {
    const next = nextState();
    const r = await command<T>(c);
    if (wait) await next;
    return r;
  } catch (e) {
    toast((e as Error).message, 'error', 8000);
    return null;
  }
}
const clipRoots = () => {
  const dirs = [...new Set(store.clips.map((c) => dirOf(c.path)))];
  return dirs.slice(0, 4).map((d) => ({ name: 'Carpeta de los clips: ' + d, path: d }));
};
const askName = (title: string, def: string) => {
  const v = window.prompt(title, def);
  return v && v.trim() ? v.trim() : null;
};
const today = () => new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-');

/** Carga una actividad del PC (y espera a tenerla aquí también para el mapa y los datos). */
async function loadActivity(path: string) {
  const r = await run<{ name: string; km: string; sync: string }>({ cmd: 'loadTelemetry', path });
  if (!r) return false;
  for (let i = 0; i < 20 && !store.telemetry; i++) await new Promise((res) => setTimeout(res, 250));
  toast(`🗺 ${r.name} · ${r.km} km${r.sync ? ' · ' + r.sync : ''}`, 'ok', 7000);
  return true;
}

/** Elegir entre varias actividades (FIT/GPX) encontradas en la carpeta. */
function chooseActivity(paths: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const dlg = h('div', { class: 'modal-back' });
    dlg.innerHTML = `<div class="modal"><h2>🗺 ¿Cuál es la actividad de esta salida?</h2>
      <p class="muted small">En la carpeta hay ${paths.length} actividades.</p><div class="pm-list"></div>
      <div class="modal-actions"><span class="spacer"></span><button id="ca-none">Ninguna</button></div></div>`;
    const box = $('.pm-list', dlg);
    for (const p of paths) {
      const b = h('button', { class: 'pm-row' }, h('b', {}, basename(p)), h('small', { class: 'muted' }, dirOf(p)));
      b.onclick = () => { dlg.remove(); resolve(p); };
      box.append(b);
    }
    $('#ca-none', dlg).onclick = () => { dlg.remove(); resolve(null); };
    document.body.append(dlg);
  });
}

const cameraFolder = (n: string) => /^(camera\d*|dcim|\d+[a-z]*|[a-z]:\\?|)$/i.test(n);

function openProjectMenu() {
  player.pause();
  const dlg = h('div', { class: 'modal-back' });
  const render = () => {
    const recents = (remote?.recents ?? []).filter((p) => p.toLowerCase() !== (remote?.projectPath ?? '').toLowerCase()).slice(0, 6);
    dlg.innerHTML = `
    <div class="modal wide">
      <h2>📁 Proyecto</h2>
      <div class="pm-card">
        <div class="pm-name">${name || '—'}</div>
        <div class="muted small mono">${remote?.projectPath || 'Sin guardar todavía'}</div>
        <div class="small">${store.clips.length} vídeos · ${store.timeline.length} momentos · ${fmtTime(store.timelineDuration())}</div>
      </div>
      <div class="pm-grid">
        <button id="pm-open">📂 Abrir otro proyecto…</button>
        <button id="pm-ren">✎ Guardar con otro nombre</button>
      </div>
      <h3>＋ Proyecto nuevo</h3>
      <div class="pm-new">
        <button id="pm-folder" class="pm-big"><span>📁</span><b>Desde una carpeta del PC</b><small>Todos sus vídeos y, si lo hay, el FIT/GPX (p. ej. la tarjeta)</small></button>
        <button id="pm-vids" class="pm-big"><span>🎞</span><b>Elegir vídeos</b><small>Del PC o subidos desde la tablet</small></button>
        <button id="pm-new" class="pm-big"><span>＋</span><b>Vacío</b><small>Añades los vídeos después</small></button>
      </div>
      ${recents.length ? '<h3>🕘 Recientes</h3><div class="pm-list" id="pm-rec"></div>' : ''}
      <h3>🗺 Actividad (FIT / GPX)</h3>
      <div class="pm-card small">${store.telemetry ? `<b>${store.telemetry.name}</b> · ${((store.telemetry.points[store.telemetry.points.length - 1].dist ?? 0) / 1000).toFixed(1)} km` : '<span class="muted">Sin actividad: los datos y el mapa no se pueden mostrar.</span>'}</div>
      <div class="pm-grid"><button id="pm-tel">${store.telemetry ? '↻ Cambiar actividad' : '＋ Cargar actividad'}</button></div>
      <p class="muted small">La sincronización se hace sola con la hora de la cámara. Para afinarla con el mapa, pulsa 🗺 Sincronizar.</p>
      <div class="modal-actions"><span class="spacer"></span><button id="pm-ok" class="primary">Listo</button></div>
    </div>`;
    $('#pm-ok', dlg).onclick = () => dlg.remove();
    const rec = dlg.querySelector('#pm-rec');
    for (const p of recents) {
      const b = h('button', { class: 'pm-row' }, h('b', {}, basename(p).replace(/\.evproj$/i, '')), h('small', { class: 'muted' }, dirOf(p)));
      b.onclick = () => openProj(p);
      rec?.append(b);
    }
    const openProj = async (p: string) => {
      const t = toast('Abriendo en el PC…', 'info', 600000);
      const ok = await run({ cmd: 'openProject', path: p });
      t.remove();
      if (ok) { toast(`Proyecto abierto: ${basename(p).replace(/\.evproj$/i, '')}`, 'ok', 2500); dlg.remove(); }
    };
    $('#pm-new', dlg).onclick = async () => {
      const n = askName('Nombre del proyecto nuevo:', `Ruta ${today()}`);
      if (!n) return;
      if (await run({ cmd: 'newProject', name: n })) { toast(`Proyecto «${n}» creado. Ahora añade los vídeos.`, 'ok', 4000); dlg.remove(); openClips(); }
    };
    /** Crea el proyecto en el PC desde una carpeta o unos vídeos. */
    const newFrom = async (src: { folder?: string; videos?: string[] }, suggested: string) => {
      const n = window.prompt('Nombre del proyecto (si lo dejas vacío: «Ruta» y la fecha de la grabación):', suggested);
      if (n === null) return;
      const t = toast(src.folder ? 'Creando el proyecto con los vídeos de la carpeta…' : 'Creando el proyecto…', 'info', 600000);
      const r = await run<{ path: string; clips: number; activity: string | null; activities: string[] }>({ cmd: 'newFrom', name: n.trim() || null, ...src });
      t.remove();
      if (!r) return;
      let act = r.activity;
      if (!act && r.activities.length) {
        const pick = await chooseActivity(r.activities);
        if (pick && (await loadActivity(pick))) act = pick;
      }
      for (let i = 0; i < 20 && act && !store.telemetry; i++) await new Promise((res) => setTimeout(res, 250));
      const pname = basename(r.path).replace(/\.evproj$/i, '');
      toast(`Proyecto «${pname}» creado: ${r.clips} vídeo${r.clips === 1 ? '' : 's'}${act ? ' · actividad ' + basename(act) : ''}`, 'ok', 6000);
      if (!act) {
        toast('No se encontró la actividad: cárgala con «＋ Cargar actividad».', 'info', 7000);
        render();
      } else dlg.remove();
    };
    $('#pm-folder', dlg).onclick = async () => {
      const p = await pickFiles({ kind: 'video', folder: true, title: '📁 Elige la carpeta de la salida', extraRoots: clipRoots() });
      if (!p) return;
      const folderName = basename(p[0]);
      await newFrom({ folder: p[0] }, cameraFolder(folderName) ? '' : folderName);
    };
    $('#pm-vids', dlg).onclick = async () => {
      const p = await pickFiles({ kind: 'video', multi: true, title: '🎞 Vídeos del proyecto nuevo', extraRoots: clipRoots() });
      if (!p?.length) return;
      await newFrom({ videos: p }, '');
    };
    $('#pm-open', dlg).onclick = async () => {
      const p = await pickFiles({ kind: 'project', title: '📂 Abrir proyecto' });
      if (p) await openProj(p[0]);
    };
    $('#pm-ren', dlg).onclick = async () => {
      const n = askName('Nombre del proyecto:', name);
      if (n && (await run({ cmd: 'rename', name: n }))) render();
    };
    $('#pm-tel', dlg).onclick = async () => {
      const p = await pickFiles({ kind: 'telemetry', title: '🗺 Elegir la actividad (FIT o GPX)', extraRoots: clipRoots() });
      if (p && (await loadActivity(p[0]))) render();
    };
  };
  render();
  document.body.append(dlg);
}
$('#t-proj').onclick = openProjectMenu;
$('#t-name').onclick = openProjectMenu;

let clipsRefresh: (() => void) | null = null;
function openClips() {
  player.pause();
  const dlg = h('div', { class: 'modal-back' });
  dlg.innerHTML = `
  <div class="modal wide">
    <h2>🎞 Clips del proyecto</h2>
    <div class="cl-list" id="cl-list"></div>
    <div class="row gap mt">
      <button id="cl-add" class="primary">＋ Añadir vídeos</button>
      <button id="cl-all">⇥ Poner todos en la línea de tiempo</button>
    </div>
    <p class="muted small">Los vídeos se eligen de las carpetas del PC (por ejemplo la tarjeta de la cámara) o se suben desde la tablet. Las vistas fluidas se preparan en el PC.</p>
    <div class="modal-actions"><span class="spacer"></span><button id="cl-ok" class="primary">Listo</button></div>
  </div>`;
  document.body.append(dlg);
  const close = () => { clipsRefresh = null; dlg.remove(); };
  $('#cl-ok', dlg).onclick = close;
  const used = () => new Set(store.timeline.map((s) => s.clipId));
  const draw = () => {
    const box = $('#cl-list', dlg);
    box.innerHTML = '';
    if (!store.clips.length) box.append(h('div', { class: 'muted fp-empty' }, 'Todavía no hay vídeos en el proyecto.'));
    const u = used();
    for (const c of store.clips) {
      const when = c.cameraStamp ? new Date(c.cameraStamp).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '';
      const prox = c.proxy ? '' : c.proxyPct > 0 ? ` · preparando vista ${Math.round(c.proxyPct * 100)} %` : ' · vista pendiente';
      const add = h('button', { class: 't-btn' }, '＋ Al montaje');
      add.onclick = () => { store.addToTimeline(c.id); store.emit('timeline'); toast(`${c.name} añadido al final`, 'ok', 1500); draw(); };
      const del = h('button', { class: 't-btn danger', title: 'Quitar del proyecto' }, '🗑');
      del.onclick = async () => {
        if (!window.confirm(`¿Quitar ${c.name} del proyecto?${u.has(c.id) ? ' También se quitan sus momentos de la línea de tiempo.' : ''} (El archivo no se borra.)`)) return;
        await run({ cmd: 'removeClip', id: c.id });
        draw();
      };
      box.append(h('div', { class: 'cl-row' },
        h('span', { class: 'cl-dot', style: `background:${clipColor(c)}` }),
        h('div', { class: 'cl-name' }, h('div', {}, c.name), h('div', { class: 'muted small' }, `${when} · ${fmtTime(c.probe.duration)}${prox}${u.has(c.id) ? ' · en el montaje' : ''}`)),
        add, del));
    }
    $<HTMLButtonElement>('#cl-all', dlg).disabled = !store.clips.length;
  };
  clipsRefresh = draw;
  $('#cl-all', dlg).onclick = () => {
    const u = used();
    const todo = store.clips.filter((c) => !u.has(c.id));
    if (!todo.length) { toast('Todos los vídeos ya están en la línea de tiempo', 'info', 2500); return; }
    for (const c of todo) store.addToTimeline(c.id);
    store.timeline.sort((a, b) => (store.clip(a.clipId)?.cameraStamp ?? 0) - (store.clip(b.clipId)?.cameraStamp ?? 0) || a.in - b.in);
    store.emit('timeline');
    toast(`${todo.length} vídeos puestos en orden de grabación`, 'ok', 2500);
    draw();
  };
  $('#cl-add', dlg).onclick = async () => {
    const opt = h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'fp-tl' }), ' Ponerlos también en la línea de tiempo');
    const cb = opt.querySelector('input') as HTMLInputElement;
    cb.checked = !store.timeline.length;
    const paths = await pickFiles({ kind: 'video', title: '＋ Añadir vídeos', multi: true, extraRoots: clipRoots(), footer: opt });
    if (!paths || !paths.length) return;
    const t = toast(`El PC está abriendo ${paths.length} vídeo${paths.length === 1 ? '' : 's'}…`, 'info', 600000);
    const r = await run<{ added: number; skipped: number }>({ cmd: 'addClips', paths, toTimeline: cb.checked });
    t.remove();
    if (r) toast(`🎞 ${r.added} añadido${r.added === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} ya estaban)` : ''}`, 'ok', 3500);
    draw();
  };
  draw();
}
$('#t-clips').onclick = openClips;

// ------------------------------------------------------------ sincronizar (la misma vista que en el PC)
let syncView: ReturnType<typeof mountSyncView> | null = null;
const syncPanel = h('div', { class: 't-syncpanel', hidden: '' });
syncPanel.innerHTML = `
  <div class="t-sync-top">
    <button id="ts-back" class="primary">← Volver al montaje</button>
    <span class="muted small">🎯 Ajustar: pon el vídeo en un punto reconocible y toca ese punto de la ruta · 🧭 Navegar: toca la ruta para ir a ese fotograma</span>
  </div>
  <div class="t-sync-body" id="ts-body"></div>`;
document.body.append(syncPanel);
$('#t-sync').onclick = () => {
  player.pause();
  if (!store.clips.length) { toast('Primero añade vídeos (🎞 Clips)', 'info', 3000); return; }
  if (!store.telemetry) { toast('Primero carga la actividad (📁 Proyecto → Cargar actividad)', 'info', 4000); return; }
  if (!syncView) {
    syncView = mountSyncView($('#ts-body', syncPanel));
    store.emit('all', false);
  }
  syncPanel.hidden = false;
  syncView.show();
};
$('#ts-back', syncPanel).onclick = () => {
  syncView?.hide();
  syncPanel.hidden = true;
  // los datos sobre el vídeo del montaje con la sincronización nueva
  paint();
};

// ------------------------------------------------------------ archivos entre el PC y la tablet
$('#t-files').onclick = () => { player.pause(); openTransfer(); };
const offersBox = h('div', { class: 't-offers' });
document.body.append(offersBox);
const seenOffers = (() => { try { return new Set<string>(JSON.parse(localStorage.getItem('ofertasVistas') || '[]')); } catch { return new Set<string>(); } })();
const saveSeen = () => { try { localStorage.setItem('ofertasVistas', JSON.stringify([...seenOffers].slice(-100))); } catch {} };
function showOffers(list: NonNullable<TabletState['offers']>) {
  offersBox.innerHTML = '';
  for (const o of list.filter((x) => x.id && !seenOffers.has(x.id)).slice(0, 3)) {
    const dismiss = () => { seenOffers.add(o.id!); saveSeen(); showOffers(list); };
    const go = h('button', { class: 'primary' }, '⬇ Descargar');
    go.onclick = () => { downloadToTablet(o.path); toast(`Descargando ${o.name}: lo verás en las descargas de Chrome`, 'ok', 5000); dismiss(); };
    const no = h('button', {}, '✕');
    no.onclick = dismiss;
    offersBox.append(h('div', { class: 't-offer' },
      h('div', { class: 'grow' }, h('div', {}, '📤 El PC te envía ' + o.name), h('div', { class: 'muted small' }, o.size ? `${(o.size / 1e6).toFixed(o.size > 1e8 ? 0 : 1)} MB` : 'Vídeo exportado')),
      go, no));
  }
}

// ------------------------------------------------------------ exportar (en el PC)
let expDlg: HTMLElement | null = null;
function showExport(st: ExportStatus) {
  const was = lastStatus;
  lastStatus = st;
  const btn = $('#t-exp');
  btn.textContent = st.running ? `⇪ ${Math.round(st.pct * 100)} %` : '⇪ Exportar';
  if (was?.running && !st.running) {
    if (st.error) toast(st.error, /cancelad/i.test(st.error) ? 'info' : 'error', 8000);
    else toast(`✅ Vídeo exportado en el PC: ${basename(st.output || '')}`, 'ok', 9000);
  }
  if (expDlg) {
    const bar = expDlg.querySelector<HTMLElement>('#e-bar');
    const txt = expDlg.querySelector<HTMLElement>('#e-txt');
    if (bar) bar.style.width = `${(st.pct * 100).toFixed(1)}%`;
    if (txt) txt.textContent = st.running ? `${(st.pct * 100).toFixed(1)} %${st.eta != null ? ` · quedan ~${fmtTime(st.eta)}` : ''}` : st.error ? st.error : st.output ? `Guardado en el PC: ${st.output}` : '';
    expDlg.querySelector<HTMLElement>('#e-prog')!.hidden = !(st.running || st.output || st.error);
    expDlg.querySelector<HTMLButtonElement>('#e-go')!.disabled = st.running;
    expDlg.querySelector<HTMLButtonElement>('#e-cancel')!.hidden = !st.running;
    const dl = expDlg.querySelector<HTMLButtonElement>('#e-dl')!;
    dl.hidden = !(st.output && !st.running && !st.error);
    dl.onclick = () => { if (st.output) { downloadToTablet(st.output); toast('Descargando el vídeo: lo verás en las descargas de Chrome', 'ok', 5000); } };
  }
}

$('#t-exp').onclick = () => {
  if (!store.timeline.length) { toast('La línea de tiempo está vacía', 'error'); return; }
  const first = store.clip(store.timeline[0].clipId);
  const dlg = h('div', { class: 'modal-back' });
  expDlg = dlg;
  dlg.innerHTML = `
  <div class="modal">
    <h2>⇪ Exportar en el PC</h2>
    <p class="muted small">El vídeo se hace en el PC con los archivos originales y se guarda en su carpeta Vídeos («${name}_tablet.mp4» o similar).</p>
    <div class="form">
      <label>Resolución
        <select id="e-res">
          <option value="source">Original${first ? ` (${first.probe.width}×${first.probe.height})` : ''}</option>
          <option value="3840x2160">4K (3840×2160)</option>
          <option value="2560x1440">1440p</option>
          <option value="1920x1080">1080p</option>
        </select>
      </label>
      <label>Formato
        <select id="e-codec"><option value="hevc">H.265 (menos peso)</option><option value="h264">H.264 (máxima compatibilidad)</option></select>
      </label>
      <label>Calidad
        <select id="e-q"><option value="high">Alta</option><option value="max">Máxima</option></select>
      </label>
      <label class="check"><input type="checkbox" id="e-ov" ${store.overlayEnabled && store.telemetry ? 'checked' : ''} ${store.telemetry ? '' : 'disabled'}> Grabar los datos</label>
      <label class="check"><input type="checkbox" id="e-mus" ${store.activeSongs().length ? 'checked' : 'disabled'}> Incluir la música</label>
    </div>
    <div class="progress" id="e-prog" hidden><div class="bar big"><div id="e-bar"></div></div><div id="e-txt" class="mono"></div></div>
    <div class="modal-actions">
      <button id="e-cancel" class="danger" hidden>Cancelar exportación</button>
      <span class="spacer"></span>
      <button id="e-dl" hidden>⬇ Bajar a la tablet</button>
      <button id="e-close">Cerrar</button>
      <button id="e-go" class="primary">Exportar</button>
    </div>
  </div>`;
  document.body.append(dlg);
  $('#e-close', dlg).onclick = () => { dlg.remove(); expDlg = null; };
  $('#e-cancel', dlg).onclick = () => postCancelExport().catch(() => {});
  $('#e-go', dlg).onclick = async () => {
    try {
      await postExport({
        res: $<HTMLSelectElement>('#e-res', dlg).value,
        codec: $<HTMLSelectElement>('#e-codec', dlg).value,
        quality: $<HTMLSelectElement>('#e-q', dlg).value,
        overlay: $<HTMLInputElement>('#e-ov', dlg).checked,
        music: $<HTMLInputElement>('#e-mus', dlg).checked
      });
      $<HTMLButtonElement>('#e-go', dlg).disabled = true;
      $('#e-prog', dlg).hidden = false;
      $('#e-txt', dlg).textContent = 'Enviado al PC…';
    } catch (e) {
      toast('No se pudo pedir la exportación: ' + (e as Error).message, 'error');
    }
  };
  if (lastStatus) showExport(lastStatus);
};

// ------------------------------------------------------------ pantalla completa
type FsDoc = Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => Promise<void> };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
const fsElement = () => document.fullscreenElement || (document as FsDoc).webkitFullscreenElement || null;
async function enterFs(el: HTMLElement = document.documentElement) {
  try {
    const e = el as FsEl;
    await (e.requestFullscreen ? e.requestFullscreen({ navigationUI: 'hide' }) : e.webkitRequestFullscreen?.());
    // en pantalla completa se puede fijar la orientación horizontal
    (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })?.lock?.('landscape').catch(() => {});
  } catch {
    toast('Este navegador no permite la pantalla completa aquí', 'error', 3000);
  }
}
async function exitFs() {
  try { await (document.exitFullscreen ? document.exitFullscreen() : (document as FsDoc).webkitExitFullscreen?.()); } catch {}
}
const wantFs = () => { try { return localStorage.getItem('pantallaCompleta') === '1'; } catch { return false; } };
const setWantFs = (v: boolean) => { try { localStorage.setItem('pantallaCompleta', v ? '1' : '0'); } catch {} };
const waitFs = () => new Promise((r) => setTimeout(r, 150));
$('#t-fs').onclick = async () => {
  if (fsElement()) {
    setWantFs(false);
    // salir del todo (puede haber el vídeo encima de la app)
    for (let i = 0; i < 4 && fsElement(); i++) { await exitFs(); await waitFs(); }
  } else { setWantFs(true); await enterFs(); }
};
// solo el vídeo con los datos (el recuadro de la vista previa) encima de lo que haya; al salir se vuelve a donde estabas
$('#t-vfs').onclick = async () => {
  if (fsElement() === $('#t-box')) await exitFs();
  else await enterFs($('#t-box'));
};
$('#t-vfs-exit').onclick = (e) => { e.stopPropagation(); $('#t-vfs').click(); };
$('#t-vfs-play').onclick = (e) => { e.stopPropagation(); player.toggle(); };
const fsUi = () => {
  const el = fsElement();
  $('#t-fs').textContent = el === document.documentElement ? '🗗' : '⛶';
  $('#t-fs').title = el === document.documentElement ? 'Salir de pantalla completa' : 'Pantalla completa';
  $('#t-vfs').textContent = el === $('#t-box') ? '⤡' : '⤢';
  document.body.classList.toggle('fs-video', el === $('#t-box'));
  setTimeout(() => { paint(); renderTimeline(); }, 120);
};
document.addEventListener('fullscreenchange', fsUi);
document.addEventListener('webkitfullscreenchange', fsUi);
// si la dejaste en pantalla completa, vuelve a ella con el primer toque (el navegador exige un toque)
const autoFs = () => { if (wantFs() && !fsElement()) enterFs(); };
document.addEventListener('pointerup', autoFs, { capture: true });
if (!(document.fullscreenEnabled || (document as Document & { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled)) {
  $('#t-fs').hidden = true;
  $('#t-vfs').hidden = true;
}

// ------------------------------------------------------------ arranque
if (!KEY) setConn(false, 'Abre esta página escaneando el código QR del PC (botón «📱 Tablet»).');
else poll();
renderTimeline();
