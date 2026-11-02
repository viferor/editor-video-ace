import { store } from './store';
import { TimelinePlayer } from './player';
import {
  METRICS, WIDGET_TYPES, builtinTemplates, cloneWidgets, containRect, drawData, drawOverlay, newWidget, widgetRect,
  type Metric, type Template, type Widget, type WidgetType
} from './overlay';
import { $, clamp, fmtTime, h, toast } from './util';

const SAFE = 0.035; // margen de seguridad (fracción del fotograma)
const TPL_KEY = 'plantillasDatos';

function userTemplates(): Template[] {
  try { return JSON.parse(localStorage.getItem(TPL_KEY) || '[]'); } catch { return []; }
}
function saveUserTemplates(t: Template[]) {
  try { localStorage.setItem(TPL_KEY, JSON.stringify(t)); } catch {}
}

/** Lienzo del overlay encima de un <video>: dibuja los widgets en el área real de la imagen. */
export function frameAspect() {
  const loc = store.locate(0);
  const c = loc?.clip ?? store.clips[0];
  return c ? c.probe.width / c.probe.height : 16 / 9;
}

export function paintOverlay(canvas: HTMLCanvasElement, clipInfo: { clip: import('./types').Clip; clipTime: number } | null, extra?: (ctx: CanvasRenderingContext2D, fr: { x: number; y: number; w: number; h: number }) => void) {
  const box = canvas.parentElement!;
  const dpr = window.devicePixelRatio || 1;
  const bw = box.clientWidth, bh = box.clientHeight;
  if (canvas.width !== Math.round(bw * dpr) || canvas.height !== Math.round(bh * dpr)) {
    canvas.width = Math.round(bw * dpr);
    canvas.height = Math.round(bh * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(dpr, dpr);
  const fr = containRect(bw, bh, clipInfo ? clipInfo.clip.probe.width / clipInfo.clip.probe.height : frameAspect());
  ctx.save();
  ctx.translate(fr.x, fr.y);
  const t = clipInfo ? store.teleTime(clipInfo.clip, clipInfo.clipTime) : null;
  drawOverlay(ctx, fr.w, fr.h, store.overlay, drawData(store.telemetry, t));
  ctx.restore();
  extra?.(ctx, fr);
  return fr;
}

export function mountOverlayView(root: HTMLElement) {
  root.innerHTML = `
  <div class="ovl">
    <aside class="ovl-left">
      <div class="panel-title">Plantilla</div>
      <div class="row"><select id="ov-tpl"></select><button id="ov-apply">Aplicar</button></div>
      <div class="row gap"><input type="text" id="ov-tplname" placeholder="Nombre de tu plantilla"><button id="ov-tplsave">Guardar</button></div>
      <button id="ov-tpldel" class="danger small-btn">Borrar plantilla seleccionada</button>
      <div class="panel-title mt">Añadir dato</div>
      <div class="add-grid" id="ov-add"></div>
      <div class="panel-title mt">En el vídeo <span class="muted small" id="ov-count"></span></div>
      <div id="ov-list" class="ov-list"></div>
      <label class="check mt"><input type="checkbox" id="ov-enabled"> Incluir los datos al exportar</label>
    </aside>
    <section class="ovl-center">
      <div class="video-box big" id="ov-box">
        <video id="ov-video" preload="auto" muted></video>
        <canvas id="ov-canvas" class="ov-canvas"></canvas>
        <div class="nodata" id="ov-empty">Monta primero la línea de tiempo (pestaña Editar)</div>
      </div>
      <div class="row transport">
        <button id="ov-play" class="icon" title="Reproducir / pausa (Espacio)">▶</button>
        <span id="ov-time" class="mono">0:00</span>
        <input type="range" id="ov-scrub" class="scrub grow" min="0" max="1000" value="0">
      </div>
      <p class="hint small">Arrastra los datos para moverlos y la esquina inferior derecha para cambiar el tamaño.
        Supr borra, flechas mueven (Mayús: más rápido). La línea discontinua marca el margen de seguridad.</p>
    </section>
    <aside class="ovl-right" id="ov-props"></aside>
  </div>`;

  const video = $<HTMLVideoElement>('#ov-video', root);
  const canvas = $<HTMLCanvasElement>('#ov-canvas', root);
  const player = new TimelinePlayer(video);
  let selected: string | null = null;
  let frame = { x: 0, y: 0, w: 1, h: 1 };
  let dragging: null | { id: string; mode: 'move' | 'resize'; x0: number; y0: number; w0: Widget } = null;
  let guides: { vx: number[]; hy: number[] } = { vx: [], hy: [] };
  let visible = false;

  const sel = () => store.overlay.find((w) => w.id === selected) ?? null;
  const changed = (what = 'overlay') => store.emit(what);

  // ------------------------------------------------------------ dibujo
  function paint() {
    $('#ov-empty', root).style.display = store.timeline.length ? 'none' : '';
    frame = paintOverlay(canvas, player.current(), (ctx, fr) => {
      // margen de seguridad
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(fr.x + fr.w * SAFE, fr.y + fr.h * SAFE, fr.w * (1 - 2 * SAFE), fr.h * (1 - 2 * SAFE));
      ctx.restore();
      // guías de alineación
      ctx.save();
      ctx.strokeStyle = '#2fb7ff';
      ctx.lineWidth = 1;
      for (const gx of guides.vx) { ctx.beginPath(); ctx.moveTo(fr.x + gx * fr.w, fr.y); ctx.lineTo(fr.x + gx * fr.w, fr.y + fr.h); ctx.stroke(); }
      for (const gy of guides.hy) { ctx.beginPath(); ctx.moveTo(fr.x, fr.y + gy * fr.h); ctx.lineTo(fr.x + fr.w, fr.y + gy * fr.h); ctx.stroke(); }
      ctx.restore();
      // selección
      const w = sel();
      if (w) {
        const r = widgetRect(w, fr.w, fr.h);
        ctx.save();
        ctx.strokeStyle = '#ff7a1a';
        ctx.lineWidth = 2;
        ctx.strokeRect(fr.x + r.x, fr.y + r.y, r.w, r.h);
        ctx.fillStyle = '#ff7a1a';
        ctx.fillRect(fr.x + r.x + r.w - 7, fr.y + r.y + r.h - 7, 12, 12);
        ctx.restore();
      }
    });
    const total = store.timelineDuration();
    $('#ov-time', root).textContent = `${fmtTime(player.T)} / ${fmtTime(total)}`;
    const scrub = $<HTMLInputElement>('#ov-scrub', root);
    if (document.activeElement !== scrub && total) scrub.value = String((player.T / total) * 1000);
    $('#ov-play', root).textContent = player.playing ? '❚❚' : '▶';
  }
  player.onUpdate = paint;
  new ResizeObserver(() => paint()).observe($('#ov-box', root));

  // ------------------------------------------------------------ ratón sobre el lienzo
  const toFrac = (e: PointerEvent) => {
    const b = canvas.getBoundingClientRect();
    return { fx: (e.clientX - b.left - frame.x) / frame.w, fy: (e.clientY - b.top - frame.y) / frame.h };
  };
  canvas.addEventListener('pointerdown', (e) => {
    const { fx, fy } = toFrac(e);
    let hit: Widget | null = null;
    for (let i = store.overlay.length - 1; i >= 0; i--) {
      const w = store.overlay[i];
      if (fx >= w.x && fx <= w.x + w.w && fy >= w.y && fy <= w.y + w.h) { hit = w; break; }
    }
    selected = hit?.id ?? null;
    renderList();
    renderProps();
    if (hit) {
      const nearCorner = (hit.x + hit.w - fx) * frame.w < 16 && (hit.y + hit.h - fy) * frame.h < 16;
      dragging = { id: hit.id, mode: nearCorner ? 'resize' : 'move', x0: fx, y0: fy, w0: { ...hit } };
      canvas.setPointerCapture(e.pointerId);
    }
    paint();
  });
  canvas.addEventListener('pointermove', (e) => {
    const { fx, fy } = toFrac(e);
    if (!dragging) {
      const w = sel();
      canvas.style.cursor = w && (w.x + w.w - fx) * frame.w < 16 && (w.y + w.h - fy) * frame.h < 16 && fx <= w.x + w.w && fy <= w.y + w.h ? 'nwse-resize' : 'default';
      return;
    }
    const w = store.overlay.find((x) => x.id === dragging!.id);
    if (!w) return;
    const dx = fx - dragging.x0, dy = fy - dragging.y0;
    guides = { vx: [], hy: [] };
    const snapTol = 0.008;
    if (dragging.mode === 'move') {
      let nx = clamp(dragging.w0.x + dx, 0, 1 - w.w);
      let ny = clamp(dragging.w0.y + dy, 0, 1 - w.h);
      // imanes: márgenes de seguridad, centro y bordes de los otros datos
      const xs = [SAFE, 1 - SAFE, 0.5], ys = [SAFE, 1 - SAFE, 0.5];
      for (const o of store.overlay) if (o.id !== w.id) { xs.push(o.x, o.x + o.w); ys.push(o.y, o.y + o.h); }
      for (const tx of xs) {
        if (Math.abs(nx - tx) < snapTol) { nx = tx; guides.vx.push(tx); break; }
        if (Math.abs(nx + w.w - tx) < snapTol) { nx = tx - w.w; guides.vx.push(tx); break; }
        if (tx === 0.5 && Math.abs(nx + w.w / 2 - 0.5) < snapTol) { nx = 0.5 - w.w / 2; guides.vx.push(0.5); break; }
      }
      for (const ty of ys) {
        if (Math.abs(ny - ty) < snapTol) { ny = ty; guides.hy.push(ty); break; }
        if (Math.abs(ny + w.h - ty) < snapTol) { ny = ty - w.h; guides.hy.push(ty); break; }
      }
      w.x = nx; w.y = ny;
    } else {
      w.w = clamp(dragging.w0.w + dx, 0.03, 1 - w.x);
      w.h = clamp(dragging.w0.h + dy, 0.03, 1 - w.y);
      if (e.shiftKey) w.h = clamp(w.w * (dragging.w0.h / dragging.w0.w), 0.03, 1 - w.y); // Mayús = mantener proporción
    }
    paint();
    renderPos();
  });
  const endDrag = () => {
    if (dragging) { dragging = null; guides = { vx: [], hy: [] }; changed(); paint(); }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // ------------------------------------------------------------ plantillas
  function fillTemplates() {
    const s = $<HTMLSelectElement>('#ov-tpl', root);
    const cur = s.value;
    s.innerHTML = '';
    const og1 = h('optgroup', { label: 'Incluidas' });
    builtinTemplates().forEach((t) => og1.append(h('option', { value: 'b:' + t.name }, t.name)));
    s.append(og1);
    const ut = userTemplates();
    if (ut.length) {
      const og2 = h('optgroup', { label: 'Mis plantillas' });
      ut.forEach((t) => og2.append(h('option', { value: 'u:' + t.name }, t.name)));
      s.append(og2);
    }
    if (cur && [...s.options].some((o) => o.value === cur)) s.value = cur;
    $('#ov-tpldel', root).style.display = s.value.startsWith('u:') ? '' : 'none';
  }
  $<HTMLSelectElement>('#ov-tpl', root).onchange = () => fillTemplates();
  $('#ov-apply', root).onclick = async () => {
    const v = $<HTMLSelectElement>('#ov-tpl', root).value;
    const t = v.startsWith('b:') ? builtinTemplates().find((x) => 'b:' + x.name === v) : userTemplates().find((x) => 'u:' + x.name === v);
    if (!t) return;
    if (store.overlay.length && (await window.api.confirm(`¿Sustituir los datos actuales por la plantilla «${t.name}»?`, ['Sustituir', 'Cancelar'])) !== 0) return;
    store.overlay = cloneWidgets(t.widgets);
    selected = null;
    changed();
  };
  $('#ov-tplsave', root).onclick = () => {
    const inp = $<HTMLInputElement>('#ov-tplname', root);
    const name = inp.value.trim();
    if (!name) { inp.focus(); toast('Escribe un nombre para la plantilla', 'info', 2000); return; }
    const ut = userTemplates().filter((t) => t.name !== name);
    ut.push({ name, widgets: JSON.parse(JSON.stringify(store.overlay)) });
    saveUserTemplates(ut);
    inp.value = '';
    fillTemplates();
    $<HTMLSelectElement>('#ov-tpl', root).value = 'u:' + name;
    fillTemplates();
    toast(`Plantilla «${name}» guardada`, 'ok', 2500);
  };
  $('#ov-tpldel', root).onclick = async () => {
    const v = $<HTMLSelectElement>('#ov-tpl', root).value;
    if (!v.startsWith('u:')) return;
    const name = v.slice(2);
    if ((await window.api.confirm(`¿Borrar la plantilla «${name}»?`, ['Borrar', 'Cancelar'])) !== 0) return;
    saveUserTemplates(userTemplates().filter((t) => t.name !== name));
    $<HTMLSelectElement>('#ov-tpl', root).value = 'b:Completo';
    fillTemplates();
  };

  // ------------------------------------------------------------ añadir
  const addBox = $('#ov-add', root);
  const ICONS: Record<WidgetType, string> = { value: '123', gauge: '◔', bar: '▬', graph: '〰', elevation: '⛰', map: '🗺', clock: '🕒' };
  (Object.keys(WIDGET_TYPES) as WidgetType[]).forEach((t) => {
    const b = h('button', { class: 'add-btn', title: WIDGET_TYPES[t].label }, h('span', { class: 'ico' }, ICONS[t]), WIDGET_TYPES[t].label.split(' (')[0]);
    b.onclick = () => {
      const w = newWidget(t, undefined, { x: 0.4, y: 0.4 });
      store.overlay.push(w);
      selected = w.id;
      changed();
    };
    addBox.append(b);
  });

  // ------------------------------------------------------------ lista
  function renderList() {
    const list = $('#ov-list', root);
    list.innerHTML = '';
    $('#ov-count', root).textContent = `(${store.overlay.length})`;
    store.overlay.forEach((w) => {
      const item = h('div', { class: 'ov-item' + (w.id === selected ? ' sel' : '') },
        h('i', { style: `background:${w.style.accent}` }),
        h('span', {}, `${WIDGET_TYPES[w.type].label.split(' (')[0]} · ${METRICS[w.metric].label}`),
        h('button', { class: 'x', title: 'Quitar' }, '×'));
      item.onclick = () => { selected = w.id; renderList(); renderProps(); paint(); };
      (item.querySelector('.x') as HTMLButtonElement).onclick = (e) => { e.stopPropagation(); remove(w.id); };
      list.append(item);
    });
    $<HTMLInputElement>('#ov-enabled', root).checked = store.overlayEnabled;
  }
  $<HTMLInputElement>('#ov-enabled', root).onchange = (e) => {
    store.overlayEnabled = (e.target as HTMLInputElement).checked;
    changed();
  };
  function remove(id: string) {
    store.overlay = store.overlay.filter((w) => w.id !== id);
    if (selected === id) selected = null;
    changed();
  }

  // ------------------------------------------------------------ propiedades
  function field(label: string, input: HTMLElement) {
    return h('label', { class: 'prop' }, h('span', {}, label), input);
  }
  function select<T extends string>(value: T, options: [T, string][], on: (v: T) => void) {
    const s = h('select', {});
    for (const [v, l] of options) s.append(h('option', { value: v }, l));
    s.value = value;
    s.onchange = () => on(s.value as T);
    return s;
  }
  function renderPos() {
    const w = sel();
    if (!w) return;
    for (const k of ['x', 'y', 'w', 'h'] as const) {
      const inp = root.querySelector<HTMLInputElement>(`#ov-pos-${k}`);
      if (inp && document.activeElement !== inp) inp.value = (w[k] * 100).toFixed(1);
    }
  }
  function renderProps() {
    const box = $('#ov-props', root);
    box.innerHTML = '';
    const w = sel();
    if (!w) {
      box.append(h('div', { class: 'muted pad' }, 'Selecciona un dato en el vídeo o en la lista para cambiar su aspecto.'));
      return;
    }
    const st = w.style;
    const set = (fn: () => void, rerender = false) => { fn(); changed(); if (rerender) renderProps(); };
    box.append(h('div', { class: 'panel-title' }, 'Dato seleccionado'));
    box.append(field('Tipo', select<WidgetType>(w.type, (Object.keys(WIDGET_TYPES) as WidgetType[]).map((t) => [t, WIDGET_TYPES[t].label]), (v) => set(() => {
      w.type = v;
      if (!WIDGET_TYPES[v].metrics.includes(w.metric)) { w.metric = WIDGET_TYPES[v].metrics[0]; st.accent = METRICS[w.metric].accent; }
    }, true))));
    if (WIDGET_TYPES[w.type].metrics.length > 1)
      box.append(field('Dato', select<Metric>(w.metric, WIDGET_TYPES[w.type].metrics.map((m) => [m, METRICS[m].label]), (v) => set(() => { w.metric = v; st.accent = METRICS[v].accent; st.min = null; st.max = null; }, true))));
    box.append(field('Fondo', select(st.bg, [['none', 'Sin fondo (con sombra)'], ['card', 'Tarjeta oscura'], ['glass', 'Cristal claro']], (v) => set(() => (st.bg = v)))));
    box.append(field('Letra', select(st.font, [['sport', 'Deportiva'], ['clean', 'Limpia'], ['heavy', 'Gruesa'], ['mono', 'Monoespaciada']], (v) => set(() => (st.font = v)))));
    const color = (val: string, on: (v: string) => void) => {
      const i = h('input', { type: 'color', value: val });
      i.oninput = () => { on(i.value); paint(); };
      i.onchange = () => changed();
      return i;
    };
    box.append(h('div', { class: 'prop-row' },
      field('Texto', color(st.color, (v) => (st.color = v))),
      field('Acento', color(st.accent, (v) => (st.accent = v)))));
    const chk = (label: string, val: boolean, on: (v: boolean) => void) => {
      const i = h('input', { type: 'checkbox' }) as HTMLInputElement;
      i.checked = val;
      i.onchange = () => set(() => on(i.checked));
      return h('label', { class: 'check' }, i, label);
    };
    box.append(h('div', { class: 'prop-row' }, chk('Etiqueta', st.label, (v) => (st.label = v)), chk('Unidad', st.unit, (v) => (st.unit = v))));
    const op = h('input', { type: 'range', min: '20', max: '100', value: String(Math.round(st.opacity * 100)) }) as HTMLInputElement;
    op.oninput = () => { st.opacity = Number(op.value) / 100; paint(); };
    op.onchange = () => changed();
    box.append(field('Opacidad', op));
    if (w.type === 'gauge' || w.type === 'bar' || w.type === 'graph') {
      const num = (val: number | null, on: (v: number | null) => void) => {
        const i = h('input', { type: 'number', value: val == null ? '' : String(val), placeholder: 'auto', class: 'num' }) as HTMLInputElement;
        i.onchange = () => set(() => on(i.value === '' ? null : Number(i.value)));
        return i;
      };
      box.append(h('div', { class: 'prop-row' }, field('Mínimo', num(st.min, (v) => (st.min = v))), field('Máximo', num(st.max, (v) => (st.max = v)))));
    }
    if (w.type === 'graph') {
      box.append(field('Segundos que muestra', select(String(st.window), [['30', '30 s'], ['60', '1 min'], ['120', '2 min'], ['300', '5 min']], (v) => set(() => (st.window = Number(v))))));
    }
    const pos = h('div', { class: 'prop-row four' });
    for (const [k, label] of [['x', 'X %'], ['y', 'Y %'], ['w', 'Ancho %'], ['h', 'Alto %']] as const) {
      const i = h('input', { type: 'number', step: '0.5', id: `ov-pos-${k}`, class: 'num', value: (w[k] * 100).toFixed(1) }) as HTMLInputElement;
      i.onchange = () => set(() => { w[k] = clamp(Number(i.value) / 100, k === 'w' || k === 'h' ? 0.02 : 0, 1); });
      pos.append(field(label, i));
    }
    box.append(pos);
    const actions = h('div', { class: 'row gap' });
    const dup = h('button', {}, 'Duplicar');
    dup.onclick = () => {
      const c = { ...w, id: Math.random().toString(36).slice(2, 10), x: clamp(w.x + 0.02, 0, 1 - w.w), y: clamp(w.y + 0.02, 0, 1 - w.h), style: { ...w.style } };
      store.overlay.push(c); selected = c.id; changed();
    };
    const front = h('button', {}, 'Al frente');
    front.onclick = () => { store.overlay = [...store.overlay.filter((x) => x !== w), w]; changed(); };
    const del = h('button', { class: 'danger' }, 'Quitar');
    del.onclick = () => remove(w.id);
    actions.append(dup, front, del);
    box.append(actions);
  }

  // ------------------------------------------------------------ reproducción
  $('#ov-play', root).onclick = () => player.toggle();
  video.onclick = () => player.toggle();
  $<HTMLInputElement>('#ov-scrub', root).oninput = (e) => {
    const t = (Number((e.target as HTMLInputElement).value) / 1000) * store.timelineDuration();
    player.playing = false;
    video.pause();
    player.seek(t);
  };

  store.on((what) => {
    if (!visible) return;
    if (['overlay', 'all'].includes(what)) { renderList(); if (what === 'all') selected = null; renderProps(); paint(); }
    if (['timeline', 'clips', 'all'].includes(what)) player.seek(player.T);
    if (['sync', 'telemetry'].includes(what)) paint();
  });

  fillTemplates();

  return {
    show() {
      visible = true;
      fillTemplates();
      renderList();
      renderProps();
      player.seek(player.T);
    },
    hide() {
      visible = false;
      player.pause();
    },
    key(e: KeyboardEvent) {
      if (e.ctrlKey) return false;
      if (e.code === 'Space') { player.toggle(); return true; }
      const w = sel();
      if (w && (e.key === 'Delete' || e.key === 'Backspace')) { remove(w.id); return true; }
      if (w && e.key.startsWith('Arrow')) {
        const d = e.shiftKey ? 0.02 : 0.005;
        if (e.key === 'ArrowLeft') w.x = clamp(w.x - d, 0, 1 - w.w);
        if (e.key === 'ArrowRight') w.x = clamp(w.x + d, 0, 1 - w.w);
        if (e.key === 'ArrowUp') w.y = clamp(w.y - d, 0, 1 - w.h);
        if (e.key === 'ArrowDown') w.y = clamp(w.y + d, 0, 1 - w.h);
        changed();
        return true;
      }
      if (e.key === 'Escape') { selected = null; renderList(); renderProps(); paint(); return true; }
      return false;
    }
  };
}
