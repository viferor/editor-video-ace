// Tablet: elegir archivos de las carpetas del PC o subirlos desde la propia tablet.
import { KEY } from './tabletApi';
import { $, h, toast } from './util';

export type FileKind = 'video' | 'telemetry' | 'music' | 'project';
interface Entry { name: string; path: string; type: 'dir' | 'file'; size?: number; mtime?: number; drive?: boolean; icon?: string }
interface Listing { dir: string; parent: string | null; entries: Entry[] }

const ACCEPT: Record<FileKind, string> = {
  video: 'video/*,.mp4,.mov,.m4v,.mkv,.insv',
  telemetry: '.fit,.gpx',
  music: 'audio/*,.mp3,.m4a,.aac,.wav,.flac,.ogg,.opus',
  project: '.evproj'
};
const WHAT: Record<FileKind, string> = { video: 'vídeos', telemetry: 'actividad', music: 'canciones', project: 'proyecto' };

const q = (o: Record<string, string>) => Object.entries({ k: KEY, ...o }).map(([a, b]) => `${a}=${encodeURIComponent(b)}`).join('&');
const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '');
const mb = (n = 0) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(0.1, n / 1e6).toFixed(1)} MB`);
const fmtDate = (t?: number) => (t ? new Date(t).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

function lastDir(kind: FileKind): string {
  try { return localStorage.getItem('carpeta-' + kind) || ''; } catch { return ''; }
}
function rememberDir(kind: FileKind, d: string) {
  try { localStorage.setItem('carpeta-' + kind, d); } catch {}
}

async function list(dir: string, kind: FileKind): Promise<Listing> {
  const r = await fetch(`/api/browse?${q({ dir, kind })}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}

/** Sube un archivo al PC con barra de progreso. Devuelve la ruta donde se guardó. */
function upload(file: File, kind: FileKind, onPct: (f: number) => void, dir = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api/upload?${q(dir ? { kind, name: file.name, dir } : { kind, name: file.name })}`);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onPct(e.loaded / e.total); };
    x.onload = () => {
      try {
        const j = JSON.parse(x.responseText);
        if (x.status === 200) resolve(j.path); else reject(new Error(j.error || `Error ${x.status}`));
      } catch { reject(new Error(`Error ${x.status}`)); }
    };
    x.onerror = () => reject(new Error('se cortó la conexión'));
    x.send(file);
  });
}

/**
 * Explorador de archivos. Devuelve las rutas elegidas (en el PC) o null si se cancela.
 * extraRoots: accesos rápidos añadidos arriba (p. ej. la carpeta de los clips del proyecto).
 */
export function pickFiles(opts: { kind: FileKind; title: string; multi?: boolean; folder?: boolean; extraRoots?: { name: string; path: string }[]; footer?: HTMLElement }): Promise<string[] | null> {
  const { kind, folder = false } = opts;
  const multi = !folder && !!opts.multi;
  return new Promise((resolve) => {
    const dlg = h('div', { class: 'modal-back' });
    dlg.innerHTML = `
    <div class="modal wide fp">
      <h2>${opts.title}</h2>
      <div class="fp-bar">
        <button id="fp-up" class="t-btn" title="Carpeta de arriba">⬑</button>
        <button id="fp-root" class="t-btn" title="Inicio">⌂</button>
        <div class="fp-path mono" id="fp-path"></div>
      </div>
      <div class="fp-list" id="fp-list"><div class="muted">Cargando…</div></div>
      <div id="fp-foot"></div>
      <div class="fp-upl" id="fp-upl" hidden></div>
      <div class="modal-actions">
        ${folder ? '' : `<label class="t-upload-btn"><input type="file" id="fp-file" accept="${ACCEPT[kind]}" ${multi ? 'multiple' : ''} hidden>⬆ Subir desde la tablet</label>`}
        <button id="fp-all" class="chip" ${multi ? '' : 'hidden'}>Marcar todos</button>
        <span class="spacer"></span>
        <button id="fp-cancel">Cancelar</button>
        <button id="fp-ok" class="primary" ${multi || folder ? '' : 'hidden'} disabled>${folder ? '✓ Usar esta carpeta' : 'Añadir'}</button>
      </div>
    </div>`;
    document.body.append(dlg);
    if (opts.footer) $('#fp-foot', dlg).append(opts.footer);
    if (folder) $('#fp-foot', dlg).append(h('p', { class: 'muted small' }, 'Entra en la carpeta y pulsa «✓ Usar esta carpeta». También se cogen los vídeos de sus subcarpetas (p. ej. DCIM\\Camera01) y el FIT/GPX que haya.'));
    const chosen = new Set<string>();
    let cur: Listing | null = null;
    let uploading = false;
    const done = (r: string[] | null) => { if (uploading && r === null) return; dlg.remove(); resolve(r); };
    const okBtn = $<HTMLButtonElement>('#fp-ok', dlg);
    const updateOk = () => {
      if (folder) {
        const n = cur?.entries.filter((e) => e.type === 'file').length ?? 0;
        okBtn.disabled = !cur?.dir;
        okBtn.textContent = cur?.dir ? `✓ Usar esta carpeta${n ? ` (${n} vídeo${n === 1 ? '' : 's'} aquí)` : ''}` : '✓ Usar esta carpeta';
        return;
      }
      okBtn.disabled = !chosen.size; okBtn.textContent = chosen.size ? `Añadir ${chosen.size}` : 'Añadir';
    };

    const open = async (dir: string) => {
      const box = $('#fp-list', dlg);
      try {
        cur = await list(dir, kind);
      } catch (e) {
        toast((e as Error).message, 'error');
        if (dir) return open('');
        box.textContent = (e as Error).message;
        return;
      }
      if (cur.dir) rememberDir(kind, cur.dir);
      $('#fp-path', dlg).textContent = cur.dir || 'Este PC';
      $<HTMLButtonElement>('#fp-up', dlg).disabled = cur.parent == null;
      box.innerHTML = '';
      let entries = cur.entries;
      if (!cur.dir && opts.extraRoots?.length) entries = [...opts.extraRoots.map((r) => ({ ...r, type: 'dir' as const, icon: '⭐' })), ...entries];
      const files = entries.filter((e) => e.type === 'file');
      if (!entries.length) box.append(h('div', { class: 'muted fp-empty' }, `No hay carpetas ni ${WHAT[kind]} aquí.`));
      for (const e of entries) {
        const row = h('div', { class: 'fp-row' + (e.type === 'dir' ? ' dir' : '') + (chosen.has(e.path) ? ' on' : '') },
          h('span', { class: 'fp-ico' }, e.type === 'dir' ? (e.icon || (e.drive ? '💽' : '📁')) : multi ? (chosen.has(e.path) ? '☑' : '☐') : '📄'),
          h('span', { class: 'fp-name' }, e.name),
          e.type === 'file' ? h('span', { class: 'fp-meta muted' }, `${fmtDate(e.mtime)} · ${mb(e.size)}`) : null);
        row.onclick = () => {
          if (e.type === 'dir') return open(e.path);
          if (folder) return;
          if (!multi) return done([e.path]);
          if (chosen.has(e.path)) chosen.delete(e.path); else chosen.add(e.path);
          row.classList.toggle('on');
          row.querySelector('.fp-ico')!.textContent = chosen.has(e.path) ? '☑' : '☐';
          updateOk();
        };
        box.append(row);
      }
      if (folder) updateOk();
      $<HTMLButtonElement>('#fp-all', dlg).hidden = !multi || !files.length;
      $('#fp-all', dlg).onclick = () => {
        const all = files.every((f) => chosen.has(f.path));
        for (const f of files) { if (all) chosen.delete(f.path); else chosen.add(f.path); }
        updateOk();
        open(cur!.dir);
      };
    };

    $('#fp-up', dlg).onclick = () => cur && cur.parent != null && open(cur.parent);
    $('#fp-root', dlg).onclick = () => open('');
    $('#fp-cancel', dlg).onclick = () => done(null);
    okBtn.onclick = () => done(folder ? (cur?.dir ? [cur.dir] : null) : [...chosen]);

    // subir desde la tablet: se guardan en el PC (Vídeos\Editor Video Ace\Desde la tablet) y se usan esas copias
    const input = $<HTMLInputElement>('#fp-file', dlg);
    if (input) input.onchange = async () => {
      const fs = [...(input.files || [])];
      if (!fs.length) return;
      uploading = true;
      dlg.classList.add('busy');
      const box = $('#fp-upl', dlg);
      box.hidden = false;
      const total = fs.reduce((a, f) => a + f.size, 0);
      let doneBytes = 0;
      const paths: string[] = [];
      const t0 = Date.now();
      for (let i = 0; i < fs.length; i++) {
        const f = fs[i];
        try {
          paths.push(await upload(f, kind, (p) => {
            const sent = doneBytes + p * f.size;
            const speed = sent / Math.max(1, (Date.now() - t0) / 1000);
            const left = speed > 0 ? (total - sent) / speed : 0;
            box.innerHTML = '';
            box.append(
              h('div', {}, `Subiendo ${i + 1} de ${fs.length}: ${f.name}`),
              h('div', { class: 'bar big' }, h('div', { style: `width:${((sent / total) * 100).toFixed(1)}%` })),
              h('div', { class: 'muted small mono' }, `${mb(sent)} de ${mb(total)} · ${(speed / 1e6).toFixed(1)} MB/s · quedan ~${Math.ceil(left / 60)} min`));
          }));
        } catch (e) {
          toast(`No se pudo subir ${f.name}: ${(e as Error).message}`, 'error', 8000);
        }
        doneBytes += f.size;
      }
      uploading = false;
      if (paths.length) {
        toast(`⬆ ${paths.length} archivo${paths.length === 1 ? '' : 's'} subido${paths.length === 1 ? '' : 's'} al PC`, 'ok', 4000);
        done(paths);
      } else {
        dlg.classList.remove('busy');
        box.hidden = true;
      }
    };

    // empezar en la última carpeta usada (o en la de los clips del proyecto)
    open(lastDir(kind) || (opts.extraRoots?.[0]?.path ?? ''));
  });
}

/** Descarga un archivo del PC a la tablet (lo guarda Chrome en Descargas). */
export function downloadToTablet(p: string) {
  const a = h('a', { href: `/api/download?${q({ p })}`, download: p.split(/[\\/]/).pop() || 'archivo' });
  document.body.append(a);
  a.click();
  a.remove();
}

/**
 * ⇅ Archivos: navegar por el PC para bajar cualquier archivo a la tablet,
 * o subir archivos de la tablet a la carpeta del PC que tengas abierta.
 */
export function openTransfer(start?: string) {
  const dlg = h('div', { class: 'modal-back' });
  dlg.innerHTML = `
  <div class="modal wide fp">
    <h2>⇅ Archivos entre el PC y la tablet</h2>
    <p class="muted small">⬇ Toca archivos del PC para marcarlos y bájalos a la tablet (se guardan en Descargas).
      ⬆ «Subir aquí» copia archivos de la tablet a la carpeta del PC que tienes abierta.</p>
    <div class="fp-bar">
      <button id="fp-up" class="t-btn" title="Carpeta de arriba">⬑</button>
      <button id="fp-root" class="t-btn" title="Inicio">⌂</button>
      <div class="fp-path mono" id="fp-path"></div>
    </div>
    <div class="fp-list" id="fp-list"><div class="muted">Cargando…</div></div>
    <div class="fp-upl" id="fp-upl" hidden></div>
    <div class="modal-actions">
      <label class="t-upload-btn" id="fp-upbtn"><input type="file" id="fp-file" multiple hidden>⬆ Subir aquí</label>
      <span class="spacer"></span>
      <button id="fp-close">Cerrar</button>
      <button id="fp-ok" class="primary" disabled>⬇ Bajar a la tablet</button>
    </div>
  </div>`;
  document.body.append(dlg);
  const chosen = new Map<string, number>();
  let cur: Listing | null = null;
  let uploading = false;
  const okBtn = $<HTMLButtonElement>('#fp-ok', dlg);
  const updateOk = () => {
    const size = [...chosen.values()].reduce((a, b) => a + b, 0);
    okBtn.disabled = !chosen.size;
    okBtn.textContent = chosen.size ? `⬇ Bajar ${chosen.size} a la tablet (${mb(size)})` : '⬇ Bajar a la tablet';
  };
  const upBtn = $('#fp-upbtn', dlg);
  const open = async (dir: string) => {
    const box = $('#fp-list', dlg);
    try {
      cur = await list(dir, 'any' as FileKind);
    } catch (e) {
      toast((e as Error).message, 'error');
      if (dir) return open('');
      return;
    }
    if (cur.dir) rememberDir('any' as FileKind, cur.dir);
    $('#fp-path', dlg).textContent = cur.dir || 'Este PC';
    $<HTMLButtonElement>('#fp-up', dlg).disabled = cur.parent == null;
    upBtn.classList.toggle('disabled', !cur.dir);
    upBtn.title = cur.dir ? `Se guardan en ${cur.dir}` : 'Abre antes una carpeta del PC';
    box.innerHTML = '';
    if (!cur.entries.length) box.append(h('div', { class: 'muted fp-empty' }, 'Carpeta vacía.'));
    // lo más nuevo primero en las carpetas con archivos (p. ej. Vídeos)
    const entries = [...cur.entries].sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.type === 'file' ? (b.mtime ?? 0) - (a.mtime ?? 0) : 0));
    for (const e of entries) {
      const row = h('div', { class: 'fp-row' + (e.type === 'dir' ? ' dir' : '') + (chosen.has(e.path) ? ' on' : '') },
        h('span', { class: 'fp-ico' }, e.type === 'dir' ? (e.icon || (e.drive ? '💽' : '📁')) : chosen.has(e.path) ? '☑' : '☐'),
        h('span', { class: 'fp-name' }, e.name),
        e.type === 'file' ? h('span', { class: 'fp-meta muted' }, `${fmtDate(e.mtime)} · ${mb(e.size)}`) : null);
      row.onclick = () => {
        if (e.type === 'dir') return open(e.path);
        if (chosen.has(e.path)) chosen.delete(e.path); else chosen.set(e.path, e.size ?? 0);
        row.classList.toggle('on');
        row.querySelector('.fp-ico')!.textContent = chosen.has(e.path) ? '☑' : '☐';
        updateOk();
      };
      box.append(row);
    }
  };
  $('#fp-up', dlg).onclick = () => cur && cur.parent != null && open(cur.parent);
  $('#fp-root', dlg).onclick = () => open('');
  $('#fp-close', dlg).onclick = () => { if (!uploading) dlg.remove(); };
  okBtn.onclick = async () => {
    const list = [...chosen.keys()];
    for (const p of list) { downloadToTablet(p); await new Promise((r) => setTimeout(r, 700)); }
    toast(`⬇ ${list.length === 1 ? 'Descargando' : `Descargando ${list.length} archivos`}: lo verás en las descargas de Chrome`, 'ok', 5000);
    chosen.clear();
    updateOk();
    if (cur) open(cur.dir);
  };
  const input = $<HTMLInputElement>('#fp-file', dlg);
  upBtn.addEventListener('click', (e) => { if (!cur?.dir) { e.preventDefault(); toast('Abre primero la carpeta del PC donde quieres guardarlos', 'info', 3500); } });
  input.onchange = async () => {
    const files = [...(input.files || [])];
    input.value = '';
    if (!files.length || !cur?.dir) return;
    const dest = cur.dir;
    uploading = true;
    dlg.classList.add('busy');
    const box = $('#fp-upl', dlg);
    box.hidden = false;
    const total = files.reduce((a, f) => a + f.size, 0);
    let doneBytes = 0;
    let ok = 0;
    const t0 = Date.now();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        await upload(f, 'any' as FileKind, (p) => {
          const sent = doneBytes + p * f.size;
          const speed = sent / Math.max(1, (Date.now() - t0) / 1000);
          box.innerHTML = '';
          box.append(
            h('div', {}, `Subiendo ${i + 1} de ${files.length}: ${f.name}`),
            h('div', { class: 'bar big' }, h('div', { style: `width:${((sent / Math.max(1, total)) * 100).toFixed(1)}%` })),
            h('div', { class: 'muted small mono' }, `${mb(sent)} de ${mb(total)} · ${(speed / 1e6).toFixed(1)} MB/s · quedan ~${Math.ceil((total - sent) / Math.max(1, speed) / 60)} min`));
        }, dest);
        ok++;
      } catch (e) {
        toast(`No se pudo subir ${f.name}: ${(e as Error).message}`, 'error', 8000);
      }
      doneBytes += f.size;
    }
    uploading = false;
    dlg.classList.remove('busy');
    box.hidden = true;
    if (ok) toast(`⬆ ${ok} archivo${ok === 1 ? '' : 's'} guardado${ok === 1 ? '' : 's'} en ${dest}`, 'ok', 5000);
    open(dest);
  };
  open(start ?? (lastDir('any' as FileKind) || ''));
}

export { dirOf };
