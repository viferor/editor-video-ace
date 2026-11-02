// Ventanas «Proyecto nuevo» y «Abrir»: empezar desde vídeos, desde una carpeta, vacío, o abrir un proyecto guardado.
import { store, recentProjects } from './store';
import { $, basename, h, toast } from './util';

export interface ProjectDialogDeps {
  /** Pregunta si guardar el proyecto actual (si no tiene nombre). false = cancelar. */
  confirmDiscard(): Promise<boolean>;
  /** Carga un FIT/GPX (y sincroniza con los clips que haya). */
  loadTelemetry(path: string): Promise<void>;
  /** Abre un proyecto .evproj ya elegido. */
  openProjectFile(path: string): Promise<void>;
}
let deps: ProjectDialogDeps;
export function initProjectDialog(d: ProjectDialogDeps) { deps = d; }

const today = () => new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-');
export const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '');

function close() { document.querySelector('.modal-back.pd')?.remove(); }

/** Nombre por defecto: «Ruta» y la fecha de la grabación (o la de hoy). */
function defaultName() {
  const t = store.clips.find((c) => c.cameraStamp != null)?.cameraStamp;
  const d = t != null ? new Date(t).toLocaleDateString('es-ES', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-') : today();
  return `Ruta ${d}`;
}

/** Nombre de carpeta útil como nombre de proyecto (las de la cámara, no). */
export function folderProjectName(dir: string): string | null {
  const n = basename(dir);
  return /^(camera\d*|dcim|\d+[a-z]*|[a-z]:\\?|)$/i.test(n) ? null : n;
}

/**
 * Núcleo (PC y tablet): vacía, añade los vídeos y guarda ya con nombre en Documentos\Editor Video Ace.
 * No pregunta nada ni carga la actividad.
 */
export async function buildProject(o: { name: string | null; videos: string[] }): Promise<string> {
  store.reset();
  if (o.videos.length) await store.addClips(o.videos);
  const p = await window.api.projectPathFor(o.name?.trim() || defaultName());
  await store.saveTo(p, false);
  return p;
}

/** Vídeos y actividades de una carpeta, o los FIT/GPX que haya junto a unos vídeos elegidos. */
export async function mediaFor(o: { folder?: string; videos?: string[] }): Promise<{ videos: string[]; activities: string[] }> {
  if (o.folder) return window.api.scanMedia(o.folder);
  const v = o.videos ?? [];
  if (!v.length) return { videos: [], activities: [] };
  const d = dirOf(v[0]).toLowerCase();
  const { activities } = await window.api.scanMedia(dirOf(v[0]));
  return { videos: v, activities: activities.filter((a) => dirOf(a).toLowerCase() === d) };
}

/** PC: crea el proyecto (preguntando antes por el actual y, si hay varias, por la actividad). */
async function createFrom(o: { name: string | null; videos: string[]; activities?: string[]; folder?: string }) {
  if (!(await deps.confirmDiscard())) return false;
  close();
  if (o.videos.length) toast(`Abriendo ${o.videos.length} vídeo${o.videos.length === 1 ? '' : 's'}…`, 'info', 2500);
  const p = await buildProject({ name: o.name, videos: o.videos });
  // actividad de la carpeta
  const acts = o.activities ?? [];
  let act: string | null = null;
  if (acts.length === 1) act = acts[0];
  else if (acts.length > 1) {
    const shown = acts.slice(0, 4);
    const r = await window.api.confirm(
      `En la carpeta hay ${acts.length} actividades (FIT/GPX). ¿Cuál es la de esta salida?`,
      [...shown.map(basename), 'Ninguna']
    );
    if (r < shown.length) act = shown[r];
  }
  if (act) await deps.loadTelemetry(act);
  const parts = [`${store.clips.length} vídeo${store.clips.length === 1 ? '' : 's'}`];
  if (act) parts.push(`actividad ${basename(act)}`);
  const pname = basename(p).replace(/\.evproj$/i, '');
  if (o.videos.length) toast(`Proyecto «${pname}» creado (${parts.join(' · ')}). Se guarda solo en Documentos\\Editor Video Ace.`, 'ok', 6000);
  else toast(`Proyecto «${pname}» creado y guardado en Documentos\\Editor Video Ace. Añade los vídeos con «＋ Añadir clips».`, 'ok', 6000);
  if (o.videos.length && !act && o.folder) toast('No había ningún FIT/GPX en la carpeta: cárgalo con «📈 Cargar FIT / GPX».', 'info', 7000);
  return true;
}

async function pickVideos(name: string | null) {
  const v = await window.api.openVideos();
  if (!v.length) return;
  // si hay un FIT/GPX junto a los vídeos, se usa
  await createFrom({ name, ...(await mediaFor({ videos: v })) });
}

async function pickFolder(name: string | null) {
  const dir = await window.api.openFolder('Carpeta con los vídeos de la salida (y, si está, el FIT/GPX)');
  if (!dir) return;
  const { videos, activities } = await window.api.scanMedia(dir);
  if (!videos.length) {
    toast(`No hay vídeos MP4/MOV en «${basename(dir)}» ni en sus subcarpetas.`, 'error', 6000);
    return;
  }
  await createFrom({ name: name || folderProjectName(dir), videos, activities, folder: dir });
}

function sourceButtons() {
  return `
    <div class="pd-grid">
      <button class="pd-card" data-act="videos"><span class="pd-ico">🎞</span><b>Elegir vídeos…</b><small>Uno o varios clips de la cámara</small></button>
      <button class="pd-card" data-act="folder"><span class="pd-ico">📁</span><b>Elegir una carpeta…</b><small>Todos sus vídeos y, si lo hay, el FIT/GPX</small></button>
    </div>`;
}

/** Ventana «Proyecto nuevo». */
export function openNewProjectDialog() {
  close();
  const dlg = h('div', { class: 'modal-back pd' });
  dlg.innerHTML = `
  <div class="modal">
    <h2>Proyecto nuevo</h2>
    <div class="form">
      <label>Nombre <input id="pd-name" type="text" placeholder="Si lo dejas vacío: «Ruta» y la fecha de la grabación"></label>
    </div>
    <p class="muted small" style="margin:12px 0 8px">¿Con qué empiezas?</p>
    ${sourceButtons()}
    <div class="modal-actions">
      <button id="pd-empty" title="Proyecto sin vídeos; los añades después">Empezar vacío</button>
      <span class="spacer"></span>
      <button id="pd-cancel">Cancelar</button>
    </div>
  </div>`;
  document.body.append(dlg);
  const nameEl = $<HTMLInputElement>('#pd-name', dlg);
  nameEl.focus();
  const name = () => nameEl.value.trim() || null;
  wire(dlg, name);
  $('#pd-empty', dlg).onclick = () => createFrom({ name: name() || `Ruta ${today()}`, videos: [] });
}

/** Ventana «Abrir»: un proyecto guardado, vídeos o una carpeta. */
export async function openOpenDialog() {
  close();
  const recents: string[] = [];
  for (const p of recentProjects()) if (await window.api.exists(p)) recents.push(p);
  const dlg = h('div', { class: 'modal-back pd' });
  dlg.innerHTML = `
  <div class="modal">
    <h2>Abrir</h2>
    <div class="pd-grid three">
      <button class="pd-card" data-act="project"><span class="pd-ico">📄</span><b>Un proyecto…</b><small>Archivo .evproj guardado</small></button>
      <button class="pd-card" data-act="videos"><span class="pd-ico">🎞</span><b>Vídeos…</b><small>Crea un proyecto con ellos</small></button>
      <button class="pd-card" data-act="folder"><span class="pd-ico">📁</span><b>Una carpeta…</b><small>Sus vídeos y el FIT/GPX</small></button>
    </div>
    ${recents.length ? `<p class="muted small" style="margin:16px 0 6px">Recientes</p><div class="pd-recent"></div>` : ''}
    <div class="modal-actions"><button id="pd-cancel">Cancelar</button></div>
  </div>`;
  document.body.append(dlg);
  const list = dlg.querySelector('.pd-recent');
  for (const p of recents) {
    const b = h('button', { class: 'pd-row', title: p },
      h('b', { text: basename(p).replace(/\.evproj$/i, '') }),
      h('small', { text: dirOf(p) }));
    if (store.projectPath && store.projectPath.toLowerCase() === p.toLowerCase()) b.append(h('span', { class: 'pd-tag', text: 'abierto' }));
    b.onclick = async () => {
      if (store.projectPath && store.projectPath.toLowerCase() === p.toLowerCase()) { close(); return; }
      close();
      await deps.openProjectFile(p);
    };
    list?.append(b);
  }
  wire(dlg, () => null);
}

function wire(dlg: HTMLElement, name: () => string | null) {
  $('#pd-cancel', dlg).onclick = close;
  dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) close(); });
  dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  dlg.querySelectorAll<HTMLElement>('.pd-card').forEach((b) => {
    b.onclick = async () => {
      const act = b.dataset.act;
      if (act === 'videos') await pickVideos(name());
      else if (act === 'folder') await pickFolder(name());
      else if (act === 'project') {
        const p = await window.api.openProjectDialog();
        if (p) { close(); await deps.openProjectFile(p); }
      }
    };
  });
}
