// Tablet: editor de los datos sobre el vídeo, dato a dato y con el dedo.
// Tocar = elegir · arrastrar = mover · esquina naranja o dos dedos = tamaño.
import { store } from './store';
import { TimelinePlayer } from './player';
import { paintOverlay } from './overlayView';
import {
  METRICS, WIDGET_TYPES, builtinTemplates, cloneWidgets, newWidget, widgetRect,
  type Metric, type Widget, type WidgetType
} from './overlay';
import { $, clamp, fmtTime, h, toast, uid } from './util';

/** true mientras se arrastra un dato: el estado que llega del PC no debe pisarlo. */
export const dataEditing = { dragging: false };

const SAFE = 0.035;
const HANDLE = 30; // px de la esquina para cambiar el tamaño (dedo)
const ICONS: Record<WidgetType, string> = { value: '123', gauge: '◔', bar: '▬', graph: '〰', elevation: '⛰', map: '🗺', clock: '🕒' };
const SWATCHES = ['#ffffff', '#ffd43b', '#ff7a1a', '#ff4d5e', '#7bd88f', '#2fb7ff', '#c792ea', '#111316'];
const short = (t: WidgetType) => WIDGET_TYPES[t].label.split(' (')[0];

export function openDataEditor(onClose?: () => void) {
  const dlg = h('div', { class: 'de-full' });
  dlg.innerHTML = `
  <div class="de-main">
    <div class="video-box big de-box" id="de-box">
      <video id="de-video" playsinline preload="auto" muted></video>
      <canvas id="de-canvas" class="ov-canvas"></canvas>
      <div class="nodata" id="de-empty">Monta primero la línea de tiempo para ver los datos sobre el vídeo.</div>
    </div>
    <div class="t-transport">
      <button id="de-play" class="t-btn big">▶</button>
      <span id="de-time" class="mono">0:00</span>
      <input type="range" id="de-scrub" min="0" max="1000" value="0" class="grow">
    </div>
    <p class="muted small de-hint">Toca un dato para elegirlo · arrástralo para moverlo · tamaño: la esquina naranja o pellizca con dos dedos.</p>
  </div>
  <aside class="de-side">
    <div class="de-head">
      <h2>📊 Datos</h2>
      <span class="spacer"></span>
      <button id="de-undo" class="t-btn" title="Deshacer">↶</button>
      <button id="de-redo" class="t-btn" title="Rehacer">↷</button>
      <button id="de-ok" class="primary">Listo</button>
    </div>
    <label class="check big-check"><input type="checkbox" id="de-on"> Mostrar y grabar los datos</label>
    <div id="de-body"></div>
  </aside>`;
  document.body.append(dlg);

  const video = $<HTMLVideoElement>('#de-video', dlg);
  const canvas = $<HTMLCanvasElement>('#de-canvas', dlg);
  const player = new TimelinePlayer(video);
  let selected: string | null = null;
  let tab: 'list' | 'add' | 'tpl' = 'list';
  let frame = { x: 0, y: 0, w: 1, h: 1 };
  let guides: { vx: number[]; hy: number[] } = { vx: [], hy: [] };

  // deshacer / rehacer (solo de lo hecho en este editor)
  const past: string[] = [];
  const future: string[] = [];
  let lastSnap = JSON.stringify(store.overlay);
  const sel = () => store.overlay.find((w) => w.id === selected) ?? null;
  /** Guarda el cambio, lo manda al PC y redibuja. */
  const commit = (rerender = true) => {
    const now = JSON.stringify(store.overlay);
    if (now !== lastSnap) { past.push(lastSnap); if (past.length > 60) past.shift(); future.length = 0; lastSnap = now; }
    store.emit('overlay');
    if (rerender) renderSide();
    paint();
  };
  const restore = (json: string) => {
    store.overlay = JSON.parse(json);
    lastSnap = json;
    if (!sel()) selected = null;
    store.emit('overlay');
    renderSide();
    paint();
  };
  $('#de-undo', dlg).onclick = () => { const p = past.pop(); if (p != null) { future.push(lastSnap); restore(p); } };
  $('#de-redo', dlg).onclick = () => { const f = future.pop(); if (f != null) { past.push(lastSnap); restore(f); } };

  // ------------------------------------------------------------ dibujo
  function paint() {
    $('#de-empty', dlg).style.display = store.timeline.length ? 'none' : '';
    frame = paintOverlay(canvas, player.current(), (ctx, fr) => {
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(fr.x + fr.w * SAFE, fr.y + fr.h * SAFE, fr.w * (1 - 2 * SAFE), fr.h * (1 - 2 * SAFE));
      ctx.setLineDash([]);
      ctx.strokeStyle = '#2fb7ff';
      for (const gx of guides.vx) { ctx.beginPath(); ctx.moveTo(fr.x + gx * fr.w, fr.y); ctx.lineTo(fr.x + gx * fr.w, fr.y + fr.h); ctx.stroke(); }
      for (const gy of guides.hy) { ctx.beginPath(); ctx.moveTo(fr.x, fr.y + gy * fr.h); ctx.lineTo(fr.x + fr.w, fr.y + gy * fr.h); ctx.stroke(); }
      // contorno suave de todos (para encontrarlos con el dedo) y el elegido en naranja
      for (const w of store.overlay) {
        const r = widgetRect(w, fr.w, fr.h);
        if (w.id === selected) continue;
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.strokeRect(fr.x + r.x, fr.y + r.y, r.w, r.h);
      }
      const w = sel();
      if (w) {
        const r = widgetRect(w, fr.w, fr.h);
        ctx.strokeStyle = '#ff7a1a';
        ctx.lineWidth = 2.5;
        ctx.strokeRect(fr.x + r.x, fr.y + r.y, r.w, r.h);
        ctx.fillStyle = '#ff7a1a';
        ctx.beginPath();
        ctx.arc(fr.x + r.x + r.w, fr.y + r.y + r.h, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#111';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⤡', fr.x + r.x + r.w, fr.y + r.y + r.h + 1);
      }
      ctx.restore();
    });
    const total = store.timelineDuration();
    $('#de-time', dlg).textContent = `${fmtTime(player.T)} / ${fmtTime(total)}`;
    const scrub = $<HTMLInputElement>('#de-scrub', dlg);
    if (document.activeElement !== scrub && total) scrub.value = String((player.T / total) * 1000);
    $('#de-play', dlg).textContent = player.playing ? '❚❚' : '▶';
  }
  player.onUpdate = paint;
  const ro = new ResizeObserver(() => paint());
  ro.observe($('#de-box', dlg));

  // ------------------------------------------------------------ dedos sobre el vídeo
  const pts = new Map<number, { x: number; y: number }>();
  type Drag = { id: string; mode: 'move' | 'resize' | 'pinch'; fx0: number; fy0: number; w0: Widget; d0?: number };
  let drag: Drag | null = null;
  const toFrac = (x: number, y: number) => {
    const b = canvas.getBoundingClientRect();
    return { fx: (x - b.left - frame.x) / frame.w, fy: (y - b.top - frame.y) / frame.h };
  };
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  const hitTest = (fx: number, fy: number) => {
    // margen extra para dedos en datos pequeños
    const px = 10 / frame.w, py = 10 / frame.h;
    for (let i = store.overlay.length - 1; i >= 0; i--) {
      const w = store.overlay[i];
      if (fx >= w.x - px && fx <= w.x + w.w + px && fy >= w.y - py && fy <= w.y + w.h + py) return w;
    }
    return null;
  };
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    player.pause();
    const { fx, fy } = toFrac(e.clientX, e.clientY);
    if (pts.size === 2) {
      // dos dedos: tamaño del elegido
      const w = sel();
      if (w) drag = { id: w.id, mode: 'pinch', fx0: fx, fy0: fy, w0: { ...w }, d0: dist() };
      dataEditing.dragging = !!w;
      return;
    }
    if (pts.size > 2) return;
    const cur = sel();
    const nearHandle = cur && Math.hypot((cur.x + cur.w - fx) * frame.w, (cur.y + cur.h - fy) * frame.h) < HANDLE;
    const hit = nearHandle ? cur : hitTest(fx, fy);
    if (hit?.id !== selected) { selected = hit?.id ?? null; renderSide(); }
    if (hit) {
      drag = { id: hit.id, mode: nearHandle ? 'resize' : 'move', fx0: fx, fy0: fy, w0: { ...hit } };
      dataEditing.dragging = true;
    }
    paint();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!drag) return;
    const w = store.overlay.find((x) => x.id === drag!.id);
    if (!w) return;
    guides = { vx: [], hy: [] };
    if (drag.mode === 'pinch') {
      if (pts.size < 2) return;
      const k = clamp(dist() / (drag.d0 || 1), 0.2, 6);
      const cx = drag.w0.x + drag.w0.w / 2, cy = drag.w0.y + drag.w0.h / 2;
      const nw = clamp(drag.w0.w * k, 0.03, 1), nh = clamp(drag.w0.h * k, 0.03, 1);
      w.w = nw; w.h = nh;
      w.x = clamp(cx - nw / 2, 0, 1 - nw);
      w.y = clamp(cy - nh / 2, 0, 1 - nh);
      paint();
      return;
    }
    const { fx, fy } = toFrac(e.clientX, e.clientY);
    const dx = fx - drag.fx0, dy = fy - drag.fy0;
    if (drag.mode === 'move') {
      let nx = clamp(drag.w0.x + dx, 0, 1 - w.w);
      let ny = clamp(drag.w0.y + dy, 0, 1 - w.h);
      const tol = 0.012;
      const xs = [SAFE, 1 - SAFE, 0.5], ys = [SAFE, 1 - SAFE, 0.5];
      for (const o of store.overlay) if (o.id !== w.id) { xs.push(o.x, o.x + o.w); ys.push(o.y, o.y + o.h); }
      for (const tx of xs) {
        if (Math.abs(nx - tx) < tol) { nx = tx; guides.vx.push(tx); break; }
        if (Math.abs(nx + w.w - tx) < tol) { nx = tx - w.w; guides.vx.push(tx); break; }
        if (tx === 0.5 && Math.abs(nx + w.w / 2 - 0.5) < tol) { nx = 0.5 - w.w / 2; guides.vx.push(0.5); break; }
      }
      for (const ty of ys) {
        if (Math.abs(ny - ty) < tol) { ny = ty; guides.hy.push(ty); break; }
        if (Math.abs(ny + w.h - ty) < tol) { ny = ty - w.h; guides.hy.push(ty); break; }
      }
      w.x = nx; w.y = ny;
    } else {
      // esquina: mantiene la proporción (lo normal en números e indicadores)
      const ratio = drag.w0.h / drag.w0.w;
      const nw = clamp(drag.w0.w + dx, 0.03, 1 - w.x);
      w.w = nw;
      w.h = clamp(nw * ratio, 0.03, 1 - w.y);
    }
    paint();
  });
  const up = (e: PointerEvent) => {
    pts.delete(e.pointerId);
    if (drag && (pts.size === 0 || drag.mode === 'pinch')) {
      drag = null;
      dataEditing.dragging = false;
      guides = { vx: [], hy: [] };
      commit(false);
      renderSize();
    }
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  // ------------------------------------------------------------ panel lateral
  const body = $('#de-body', dlg);
  const on = $<HTMLInputElement>('#de-on', dlg);
  on.onchange = () => { store.overlayEnabled = on.checked; commit(false); };

  function renderSide() {
    on.checked = store.overlayEnabled;
    $<HTMLButtonElement>('#de-undo', dlg).disabled = !past.length;
    $<HTMLButtonElement>('#de-redo', dlg).disabled = !future.length;
    body.innerHTML = '';
    const w = sel();
    if (w) return renderProps(w);
    const tabs = h('div', { class: 'de-tabs' });
    for (const [k, l] of [['list', `En el vídeo (${store.overlay.length})`], ['add', '＋ Añadir'], ['tpl', 'Plantillas']] as const) {
      const b = h('button', { class: 'chip' + (tab === k ? ' on' : '') }, l);
      b.onclick = () => { tab = k; renderSide(); };
      tabs.append(b);
    }
    body.append(tabs);
    if (tab === 'list') {
      if (!store.overlay.length) body.append(h('p', { class: 'muted' }, 'No hay datos. Pulsa «＋ Añadir» o elige una plantilla.'));
      for (const x of store.overlay) {
        const row = h('button', { class: 'de-item' },
          h('i', { style: `background:${x.style.accent}` }),
          h('span', {}, `${short(x.type)} · ${METRICS[x.metric].label}`), h('span', { class: 'muted' }, '›'));
        row.onclick = () => { selected = x.id; renderSide(); paint(); };
        body.append(row);
      }
      if (store.overlay.length) body.append(h('p', { class: 'muted small' }, 'Toca uno aquí o directamente en el vídeo para cambiarlo.'));
    } else if (tab === 'add') {
      const grid = h('div', { class: 'de-add' });
      (Object.keys(WIDGET_TYPES) as WidgetType[]).forEach((t) => {
        const b = h('button', {}, h('span', { class: 'ico' }, ICONS[t]), short(t));
        b.onclick = () => {
          const nw = newWidget(t, undefined, { x: 0.4, y: 0.4 });
          store.overlay.push(nw);
          selected = nw.id;
          commit();
          toast(`${short(t)} añadido en el centro: arrástralo a su sitio`, 'ok', 2500);
        };
        grid.append(b);
      });
      body.append(grid);
      if (!store.telemetry) body.append(h('p', { class: 'muted small' }, 'Sin actividad cargada los datos salen vacíos («--»). Cárgala en 📁 Proyecto.'));
    } else {
      body.append(h('p', { class: 'muted small' }, 'Sustituye todos los datos por los de la plantilla (se puede deshacer con ↶).'));
      const grid = h('div', { class: 'tpl-grid' });
      for (const t of builtinTemplates()) {
        const b = h('button', { class: 'tpl-btn' }, t.name);
        b.onclick = () => {
          store.overlay = cloneWidgets(t.widgets);
          store.overlayEnabled = true;
          selected = null;
          tab = 'list';
          commit();
          toast(`Plantilla «${t.name}»`, 'ok', 1500);
        };
        grid.append(b);
      }
      body.append(grid);
    }
  }

  function renderSize() {
    const w = sel();
    const r = dlg.querySelector<HTMLInputElement>('#de-size');
    if (w && r && document.activeElement !== r) r.value = String(Math.round(w.w * 100));
  }

  function renderProps(w: Widget) {
    const st = w.style;
    const set = (fn: () => void, rerender = true) => { fn(); commit(rerender); };
    const back = h('button', { class: 'chip' }, '‹ Todos los datos');
    back.onclick = () => { selected = null; renderSide(); paint(); };
    body.append(h('div', { class: 'de-selhead' }, back, h('b', {}, `${short(w.type)} · ${METRICS[w.metric].label}`)));

    const group = (label: string, ...kids: HTMLElement[]) => h('div', { class: 'de-group' }, h('div', { class: 'de-label' }, label), ...kids);
    const chips = <T extends string>(val: T, opts: [T, string][], onPick: (v: T) => void) => {
      const box = h('div', { class: 'de-chips' });
      for (const [v, l] of opts) {
        const b = h('button', { class: 'chip' + (v === val ? ' on' : '') }, l);
        b.onclick = () => onPick(v);
        box.append(b);
      }
      return box;
    };

    body.append(group('Tipo', chips<WidgetType>(w.type, (Object.keys(WIDGET_TYPES) as WidgetType[]).map((t) => [t, `${ICONS[t]} ${short(t)}`]), (v) => set(() => {
      w.type = v;
      if (!WIDGET_TYPES[v].metrics.includes(w.metric)) { w.metric = WIDGET_TYPES[v].metrics[0]; st.accent = METRICS[w.metric].accent; }
    }))));
    if (WIDGET_TYPES[w.type].metrics.length > 1)
      body.append(group('Dato', chips<Metric>(w.metric, WIDGET_TYPES[w.type].metrics.map((m) => [m, METRICS[m].label]), (v) => set(() => { w.metric = v; st.accent = METRICS[v].accent; st.min = null; st.max = null; }))));

    // tamaño: deslizador (mantiene la proporción) y empujar con flechas
    const size = h('input', { type: 'range', id: 'de-size', min: '3', max: '100', value: String(Math.round(w.w * 100)) }) as HTMLInputElement;
    size.oninput = () => {
      const ratio = w.h / w.w;
      const cx = w.x + w.w / 2, cy = w.y + w.h / 2;
      w.w = clamp(Number(size.value) / 100, 0.03, 1);
      w.h = clamp(w.w * ratio, 0.03, 1);
      w.x = clamp(cx - w.w / 2, 0, 1 - w.w);
      w.y = clamp(cy - w.h / 2, 0, 1 - w.h);
      paint();
    };
    size.onchange = () => commit(false);
    const nudge = h('div', { class: 'de-nudge' });
    for (const [l, dx, dy] of [['◀', -1, 0], ['▲', 0, -1], ['▼', 0, 1], ['▶', 1, 0]] as const) {
      const b = h('button', { class: 't-btn' }, l);
      b.onclick = () => set(() => { w.x = clamp(w.x + dx * 0.01, 0, 1 - w.w); w.y = clamp(w.y + dy * 0.01, 0, 1 - w.h); }, false);
      nudge.append(b);
    }
    const centre = h('button', { class: 't-btn', title: 'Centrar en horizontal' }, '↔ Centro');
    centre.onclick = () => set(() => { w.x = 0.5 - w.w / 2; }, false);
    nudge.append(centre);
    body.append(group('Tamaño y posición', size, nudge));

    body.append(group('Fondo', chips(st.bg, [['none', 'Sin fondo'], ['card', 'Tarjeta oscura'], ['glass', 'Cristal']], (v) => set(() => (st.bg = v)))));
    body.append(group('Letra', chips(st.font, [['sport', 'Deportiva'], ['clean', 'Limpia'], ['heavy', 'Gruesa'], ['mono', 'Mono']], (v) => set(() => (st.font = v)))));

    const colors = (val: string, onPick: (v: string) => void) => {
      const box = h('div', { class: 'de-sw' });
      for (const c of SWATCHES) {
        const b = h('button', { class: 'sw' + (c.toLowerCase() === val.toLowerCase() ? ' on' : ''), style: `background:${c}`, title: c });
        b.onclick = () => set(() => onPick(c));
        box.append(b);
      }
      const custom = h('input', { type: 'color', value: val, title: 'Otro color' }) as HTMLInputElement;
      custom.oninput = () => { onPick(custom.value); paint(); };
      custom.onchange = () => commit();
      box.append(custom);
      return box;
    };
    body.append(group('Color del texto', colors(st.color, (v) => (st.color = v))));
    body.append(group('Color de acento', colors(st.accent, (v) => (st.accent = v))));

    const tog = (label: string, val: boolean, onSet: (v: boolean) => void) => {
      const b = h('button', { class: 'chip' + (val ? ' on' : '') }, (val ? '✓ ' : '') + label);
      b.onclick = () => set(() => onSet(!val));
      return b;
    };
    body.append(group('Mostrar', h('div', { class: 'de-chips' }, tog('Etiqueta', st.label, (v) => (st.label = v)), tog('Unidad', st.unit, (v) => (st.unit = v)))));
    const op = h('input', { type: 'range', min: '20', max: '100', value: String(Math.round(st.opacity * 100)) }) as HTMLInputElement;
    op.oninput = () => { st.opacity = Number(op.value) / 100; paint(); };
    op.onchange = () => commit(false);
    body.append(group('Opacidad', op));
    if (w.type === 'graph')
      body.append(group('Segundos que muestra', chips(String(st.window), [['30', '30 s'], ['60', '1 min'], ['120', '2 min'], ['300', '5 min']], (v) => set(() => (st.window = Number(v))))));

    const dup = h('button', {}, '⧉ Duplicar');
    dup.onclick = () => {
      const c = { ...w, id: uid(), x: clamp(w.x + 0.03, 0, 1 - w.w), y: clamp(w.y + 0.03, 0, 1 - w.h), style: { ...w.style } };
      store.overlay.push(c); selected = c.id; commit();
    };
    const front = h('button', {}, '⬆ Al frente');
    front.onclick = () => set(() => { store.overlay = [...store.overlay.filter((x) => x.id !== w.id), w]; }, false);
    const del = h('button', { class: 'danger' }, '🗑 Quitar');
    del.onclick = () => { store.overlay = store.overlay.filter((x) => x.id !== w.id); selected = null; commit(); toast('Dato quitado (↶ para deshacer)', 'info', 2500); };
    body.append(h('div', { class: 'de-actions' }, dup, front, del));
  }

  // ------------------------------------------------------------ reproducción y cierre
  $('#de-play', dlg).onclick = () => player.toggle();
  $<HTMLInputElement>('#de-scrub', dlg).oninput = (e) => {
    const t = (Number((e.target as HTMLInputElement).value) / 1000) * store.timelineDuration();
    player.pause();
    player.seek(t);
  };
  // lo que llega del PC (u otra parte) se refleja aquí
  const off = store.on((what) => {
    if (!document.body.contains(dlg)) return;
    if (what === 'all' || what === 'overlay') {
      if (dataEditing.dragging) return;
      const now = JSON.stringify(store.overlay);
      if (now !== lastSnap) { lastSnap = now; if (!sel()) selected = null; renderSide(); }
      paint();
    }
    if (['timeline', 'clips'].includes(what)) player.seek(player.T);
  });
  $('#de-ok', dlg).onclick = () => {
    player.destroy();
    video.removeAttribute('src');
    video.load();
    ro.disconnect();
    off();
    dlg.remove();
    onClose?.();
  };

  renderSide();
  player.seek(Math.min(store.timelineDuration() * 0.25, 30));
}
