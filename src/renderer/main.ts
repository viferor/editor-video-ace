import './styles.css';
import './types';
import { store, lastProjectPath } from './store';
import { mountSyncView } from './syncView';
import { mountEditView } from './editView';
import { mountOverlayView } from './overlayView';
import { openExportDialog } from './exportDialog';
import { initTabletLink, openTabletDialog } from './tabletLink';
import { initProjectDialog, openNewProjectDialog, openOpenDialog } from './projectDialog';
import { $, basename, isTyping, toast } from './util';

const app = $('#app');
app.innerHTML = `
  <header class="top">
    <div class="brand">Editor <b>Ace</b></div>
    <div class="group">
      <button id="b-new" title="Proyecto nuevo: desde vídeos, una carpeta o vacío (Ctrl+N)">Nuevo</button>
      <button id="b-open" title="Abrir un proyecto, vídeos o una carpeta (Ctrl+O)">Abrir</button>
      <button id="b-save" title="Guardar proyecto (Ctrl+S)">Guardar</button>
      <button id="b-saveas" title="Guardar una copia con otro nombre o en otro sitio (Ctrl+Mayús+S)">Guardar como…</button>
    </div>
    <div class="group">
      <button id="b-clips" class="accent">＋ Añadir clips</button>
      <button id="b-tel">📈 Cargar FIT / GPX</button>
    </div>
    <nav class="tabs">
      <button data-tab="sync" class="tab">1 · Sincronizar</button>
      <button data-tab="edit" class="tab">2 · Editar</button>
      <button data-tab="overlay" class="tab">3 · Datos</button>
    </nav>
    <span class="spacer"></span>
    <button id="b-tablet" title="Revisar y retocar el proyecto desde la tablet">📱 Tablet</button>
    <button id="b-export" class="primary">Exportar ⇪</button>
  </header>
  <main>
    <div id="view-sync" class="view"></div>
    <div id="view-edit" class="view"></div>
    <div id="view-overlay" class="view"></div>
  </main>
  <footer class="status">
    <span id="st-project">Proyecto sin guardar</span>
    <span id="st-tel">Sin actividad</span>
    <span class="spacer"></span>
    <span id="st-enc">Detectando GPU…</span>
  </footer>
  <div id="drop-hint">Suelta los vídeos en la biblioteca para añadirlos, o en la línea de tiempo para insertarlos en esa posición. El FIT/GPX, en cualquier sitio.</div>
`;

const views = {
  sync: mountSyncView($('#view-sync')),
  edit: mountEditView($('#view-edit')),
  overlay: mountOverlayView($('#view-overlay'))
};
type Tab = keyof typeof views;
let tab: Tab = 'edit';

function setTab(t: Tab) {
  views[tab].hide();
  tab = t;
  document.querySelectorAll<HTMLElement>('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll<HTMLElement>('.view').forEach((v) => v.classList.toggle('on', v.id === `view-${t}`));
  views[t].show();
}
document.querySelectorAll<HTMLElement>('.tab').forEach((b) => (b.onclick = () => setTab(b.dataset.tab as Tab)));

async function loadTelemetry(path: string) {
  try {
    const tel = await store.loadTelemetry(path);
    const km = ((tel.points[tel.points.length - 1].dist ?? 0) / 1000).toFixed(1);
    toast(`Actividad cargada: ${tel.name} · ${km} km · ${tel.points.length} puntos`, 'ok');
    if (store.clips.length) store.autoSync();
    store.setSyncLocked(false); // actividad nueva: toca ajustar la sincronización
    setTab('sync');
  } catch (e) {
    toast('No se pudo leer la actividad: ' + (e as Error).message, 'error', 8000);
  }
}

/** Antes de Nuevo/Abrir: un proyecto con archivo ya está guardado; uno sin archivo se ofrece guardar. */
async function confirmDiscard() {
  if (store.projectPath) {
    await store.flushAutosave();
    return true;
  }
  if (!store.clips.length && !store.timeline.length) return true;
  const r = await window.api.confirm('Este proyecto aún no tiene nombre. ¿Guardarlo antes?', ['Guardar', 'No guardar', 'Cancelar']);
  if (r === 0) return store.save();
  return r === 1;
}

$('#b-clips').onclick = async () => {
  const paths = await window.api.openVideos();
  if (paths.length) await store.addClips(paths);
};
$('#b-tel').onclick = async () => {
  const p = await window.api.openTelemetry();
  if (p) loadTelemetry(p);
};
async function openProjectFile(p: string) {
  if (!(await confirmDiscard())) return;
  try {
    await store.load(p);
    toast(`Proyecto abierto: ${basename(p)}`, 'ok', 2500);
  } catch (e) {
    toast('No se pudo abrir: ' + (e as Error).message, 'error');
  }
}
initProjectDialog({ confirmDiscard, loadTelemetry, openProjectFile });
const openProject = () => openOpenDialog();
$('#b-new').onclick = () => openNewProjectDialog();
$('#b-open').onclick = openProject;
$('#b-save').onclick = () => store.save();
$('#b-saveas').onclick = () => store.save(true);
$('#b-export').onclick = () => openExportDialog();
$('#b-tablet').onclick = () => openTabletDialog();
initTabletLink();

// --- estado
function updateStatus() {
  const hhmm = (t: number) => new Date(t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  $('#st-project').textContent = store.projectPath
    ? `${basename(store.projectPath)} · ${store.dirty ? 'guardando…' : store.lastAutosave ? 'guardado ' + hhmm(store.lastAutosave) : 'guardado'}`
    : store.clips.length || store.telemetry
      ? 'Proyecto sin nombre (se conserva al cerrar · Ctrl+S para guardarlo)'
      : 'Proyecto nuevo';
  const t = store.telemetry;
  $('#st-tel').textContent = t
    ? `${t.source.toUpperCase()}: ${t.name} · ${new Date(t.start).toLocaleString('es-ES')}${t.tzOffsetMin != null ? ` · zona UTC${t.tzOffsetMin >= 0 ? '+' : ''}${t.tzOffsetMin / 60}` : ''}`
    : 'Sin actividad';
  document.title = `Editor Video Ace${store.projectPath ? ' — ' + basename(store.projectPath) : ''}`;
}
store.on(updateStatus);
updateStatus();

window.api.encoders().then((enc) => {
  store.encoders = enc;
  $('#st-enc').textContent =
    enc.hevcNvenc || enc.h264Nvenc ? `GPU NVIDIA lista (${[enc.hevcNvenc && 'H.265', enc.h264Nvenc && 'H.264'].filter(Boolean).join(' / ')})` : 'Sin NVENC: se usará la CPU';
});

// --- arrastrar y soltar archivos
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (e.dataTransfer?.types.includes('Files')) {
    dragDepth++;
    document.body.classList.add('dropping');
  }
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  dragDepth = 0;
  document.body.classList.remove('dropping');
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (!files.length) return;
  e.preventDefault();
  const paths = files.map((f) => window.api.pathForFile(f)).filter(Boolean);
  const vids = (e as DragEvent & { videosHandled?: boolean }).videosHandled
    ? []
    : paths.filter((p) => /\.(mp4|mov|m4v|mkv)$/i.test(p));
  const tel = paths.find((p) => /\.(fit|gpx)$/i.test(p));
  if (/\.evproj$/i.test(paths[0] ?? '')) {
    if (await confirmDiscard()) await store.load(paths[0]);
    return;
  }
  if (vids.length) {
    await store.addClips(vids);
    if (tab === 'sync') setTab('edit');
  }
  if (tel) await loadTelemetry(tel);
  if (!vids.length && !tel && !(e as DragEvent & { videosHandled?: boolean }).videosHandled)
    toast('Formato no reconocido. Usa vídeos MP4/MOV y actividades FIT/GPX.', 'error');
});

// --- teclado
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); store.save(e.shiftKey); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); openProject(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); openNewProjectDialog(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'e') { e.preventDefault(); openExportDialog(); return; }
  if (isTyping(e) || document.querySelector('.modal-back')) return;
  if (e.key === '1' && !e.ctrlKey) { setTab('sync'); return; }
  if (e.key === '2' && !e.ctrlKey) { setTab('edit'); return; }
  if (e.key === '3' && !e.ctrlKey) { setTab('overlay'); return; }
  if (views[tab].key(e)) e.preventDefault();
});

// Al cerrar no se pregunta nada: el proyecto (o la sesión sin guardar) se guarda solo.
window.api.onBeforeClose(async () => {
  await store.flushAutosave();
  window.api.closeConfirmed();
});

setTab('edit');

// Al arrancar: reabrir el último proyecto o, si no tenía nombre, la sesión anterior
(async () => {
  try {
    const last = lastProjectPath();
    if (last && (await window.api.exists(last))) {
      await store.load(last);
      toast(`Abierto el último proyecto: ${basename(last)}`, 'ok', 3000);
      return;
    }
    const rec = await window.api.recoveryPath();
    if (await window.api.exists(rec)) {
      await store.load(rec, { recovered: true });
      if (store.clips.length || store.telemetry)
        toast('Recuperada la sesión anterior. Guárdala con Ctrl+S para darle nombre.', 'info', 6000);
    }
  } catch (e) {
    console.warn('No se pudo restaurar la sesión', e);
  }
})();
