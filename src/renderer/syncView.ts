import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { store, previewUrl, prioritizeProxy, previewState, retryProxy } from './store';
import { passesNear, posPoints, rangeIdx, sampleAt, hasPos } from './telemetry';
import type { Clip, TPoint } from './types';
import { drawSyncChart, estimateClip, fmtLag, type SyncEstimate } from './syncCheck';
import { $, clamp, fmtClock, fmtOffset, fmtTime, h, toast } from './util';

export const CLIP_COLORS = ['#ff7a1a', '#2fb7ff', '#b6ff3b', '#ff4fa3', '#ffd43b', '#9b7bff', '#3bffc8', '#ff5c5c'];
export const clipColor = (c: Clip) => CLIP_COLORS[store.clips.indexOf(c) % CLIP_COLORS.length];

export function liveDataHtml(p: TPoint | null): string {
  if (!p) return '<span class="muted">Fuera del horario de la actividad</span>';
  const cell = (label: string, v: string | null) =>
    v == null ? '' : `<div class="ld"><span>${label}</span><b>${v}</b></div>`;
  return [
    cell('Velocidad', p.speed != null ? (p.speed * 3.6).toFixed(1) + ' km/h' : null),
    cell('Pulso', p.hr != null ? Math.round(p.hr) + ' ppm' : null),
    cell('Potencia', p.power != null ? Math.round(p.power) + ' W' : null),
    cell('Cadencia', p.cad != null ? Math.round(p.cad) + ' rpm' : null),
    cell('Altitud', p.alt != null ? Math.round(p.alt) + ' m' : null),
    cell('Distancia', p.dist != null ? (p.dist / 1000).toFixed(2) + ' km' : null),
    cell('Temp.', p.temp != null ? Math.round(p.temp) + ' °C' : null),
    cell('Hora', fmtClock(p.t))
  ].join('');
}

export function mountSyncView(root: HTMLElement) {
  root.innerHTML = `
  <div class="sync">
    <div class="sync-left">
      <div class="row">
        <label>Clip</label>
        <select id="sv-clip"></select>
      </div>
      <div class="video-box"><video id="sv-video" preload="auto"></video><div class="nodata" id="sv-novideo">Añade clips para empezar</div>
        <div id="sv-src" class="src-badge"></div></div>
      <input type="range" id="sv-scrub" min="0" max="1000" value="0" step="1" class="scrub">
      <div class="row transport">
        <button id="sv-play" class="icon" title="Reproducir / pausa (Espacio)">▶</button>
        <button id="sv-fb" title="Fotograma anterior (,)">◀|</button>
        <button id="sv-ff" title="Fotograma siguiente (.)">|▶</button>
        <span id="sv-time" class="mono">0:00.0</span>
      </div>
      <div class="panel">
        <div class="panel-title">¿Está bien sincronizado?</div>
        <canvas id="sv-chart" class="sv-chart"></canvas>
        <div class="chart-leg small"><span class="c-sp">━ velocidad (actividad)</span> <span class="c-au">━ sonido del vídeo (viento)</span></div>
        <div id="sv-check" class="small muted">Si las subidas y bajadas de las dos líneas coinciden, el clip está bien sincronizado.</div>
        <div class="row gap mt"><button id="sv-check-all">🔍 Comprobar todos los clips</button><button id="sv-check-one" class="chip">Comprobar este</button></div>
      </div>
      <div class="panel">
        <div class="panel-title">Desfase cámara → actividad</div>
        <div class="offset-row">
          <button data-d="-1000">−1 s</button>
          <button data-d="-100">−0,1 s</button>
          <div id="sv-offset" class="offset mono">+0.0 s</div>
          <button data-d="100">+0,1 s</button>
          <button data-d="1000">+1 s</button>
        </div>
        <div class="row gap">
          <label class="check"><input type="checkbox" id="sv-own"> Solo este clip</label>
          <button id="sv-auto">Auto-sincronizar</button>
          <button id="sv-reset-clip" title="Volver al desfase común">Usar desfase común</button>
        </div>
        <div class="row gap">
          <button id="sv-undo" title="Deshacer el último cambio de sincronización (Ctrl+Z)">↶ Deshacer</button>
          <button id="sv-redo" title="Rehacer (Ctrl+Y)">↷ Rehacer</button>
          <span class="spacer"></span>
          <button id="sv-clear" class="danger" title="Quitar toda la sincronización y volver a la hora de la cámara">Quitar sincronización</button>
        </div>
        <p class="hint">En modo <b>🎯 Ajustar</b>: busca un fotograma reconocible (cruce, curva, puente…) y haz clic en ese punto del mapa.
          Después el mapa pasa a <b>🧭 Navegar</b>: un clic en la ruta te lleva al fotograma de ese punto para revisar.
          Con la ruta sincronizada en un clip, el resto usa el mismo desfase. También ayuda parar el vídeo justo cuando te detienes: la velocidad debe marcar 0.</p>
      </div>
      <div class="panel">
        <div class="panel-title">Datos en este instante</div>
        <div id="sv-live" class="live"></div>
      </div>
    </div>
    <div class="sync-right">
      <div id="sv-map"></div>
      <div class="map-mode" id="sv-mode">
        <button data-mode="nav" title="Clic en la ruta = ir al fotograma de ese punto">🧭 Navegar</button>
        <button data-mode="sync" title="Clic en la ruta = el fotograma actual está aquí (ajusta la sincronización)">🎯 Ajustar sincronización</button>
      </div>
      <div class="map-tools">
        <label class="check"><input type="checkbox" id="sv-follow" checked> Seguir posición</label>
        <div id="sv-legend" class="legend"></div>
      </div>
      <div class="nodata map-empty" id="sv-notel">Carga el FIT o GPX de la ruta</div>
    </div>
  </div>`;

  const video = $<HTMLVideoElement>('#sv-video', root);
  const sel = $<HTMLSelectElement>('#sv-clip', root);
  const scrub = $<HTMLInputElement>('#sv-scrub', root);
  const own = $<HTMLInputElement>('#sv-own', root);
  const follow = $<HTMLInputElement>('#sv-follow', root);
  let current: Clip | null = null;
  /** resultado de la comprobación por clip (se invalida si cambia su sincronización) */
  const checks = new Map<string, { est: SyncEstimate; off: number }>();
  const checkOf = (c: Clip) => { const k = checks.get(c.id); return k && k.off === store.offsetOf(c) ? k.est : null; };

  // ---- mapa
  const map = L.map($('#sv-map', root), { zoomControl: true, preferCanvas: true }).setView([40.4, -3.7], 6);
  ($('#sv-map', root) as HTMLElement & { _map?: L.Map })._map = map; // (para las pruebas)
  const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  });
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Imágenes © Esri'
  });
  sat.addTo(map);
  L.control.layers({ Satélite: sat, Mapa: street }, {}, { position: 'topright' }).addTo(map);
  const trackLayer = L.layerGroup().addTo(map);
  const clipsLayer = L.layerGroup().addTo(map);
  const marker = L.circleMarker([0, 0], { radius: 8, color: '#fff', weight: 3, fillColor: '#ff7a1a', fillOpacity: 1 });
  const pickMarker = L.circleMarker([0, 0], { radius: 6, color: '#000', weight: 2, fillColor: '#fff', fillOpacity: 1 });

  let trackBounds: L.LatLngBounds | null = null;
  let needFit = false;
  let visible = false;
  function fitTrack() {
    if (!trackBounds) return;
    if (!visible) { needFit = true; return; }
    map.invalidateSize();
    map.fitBounds(trackBounds, { padding: [30, 30] });
    needFit = false;
  }

  let drawnTel: unknown = undefined;
  function drawTrack(fit = true) {
    const tel = store.telemetry;
    // solo se redibuja (y se encuadra) si cambia la actividad: así no se pierde el zoom al recibir cambios
    if (tel === drawnTel) return;
    drawnTel = tel;
    trackLayer.clearLayers();
    $('#sv-notel', root).style.display = tel ? 'none' : '';
    if (!tel) return;
    const ll = posPoints(tel).map((p) => [p.lat!, p.lon!] as L.LatLngTuple);
    if (!ll.length) {
      toast('La actividad no tiene coordenadas GPS', 'error');
      return;
    }
    L.polyline(ll, { color: '#000', weight: 7, opacity: 0.45 }).addTo(trackLayer);
    L.polyline(ll, { color: '#e8e8e8', weight: 3, opacity: 0.9 }).addTo(trackLayer);
    trackBounds = L.latLngBounds(ll);
    if (fit) fitTrack();
  }

  function badge(c: Clip) {
    const e = checkOf(c);
    if (!e || e.level === 'baja') return '';
    return Math.abs(e.lag) >= 1 ? `⚠ parece desfasado ${fmtLag(e.lag)}` : '✓ cuadra';
  }

  function drawClips() {
    clipsLayer.clearLayers();
    const legend = $('#sv-legend', root);
    legend.innerHTML = '';
    const tel = store.telemetry;
    if (!tel) return;
    for (const c of store.clips) {
      const t0 = store.teleTime(c, 0);
      const t1 = store.teleTime(c, c.probe.duration);
      const color = clipColor(c);
      let state = 'sin hora';
      if (t0 != null && t1 != null) {
        const inside = Math.min(t1, tel.end) - Math.max(t0, tel.start);
        state = inside <= 0 ? 'fuera de la ruta' : inside < (t1 - t0) * 0.95 ? 'parcial' : 'ok';
        if (inside > 0) {
          const [i0, i1] = rangeIdx(tel, t0, t1);
          const ll = tel.points.slice(i0, i1).filter(hasPos).map((p) => [p.lat!, p.lon!] as L.LatLngTuple);
          if (ll.length > 1)
            L.polyline(ll, { color, weight: c === current ? 7 : 5, opacity: c === current ? 1 : 0.75 })
              .addTo(clipsLayer);
        }
      }
      legend.append(
        h('div', { class: 'leg' + (state === 'ok' ? '' : ' warn') + (c === current ? ' cur' : '') },
          h('i', { style: `background:${color}` }), `${c.name} `, h('small', {}, [state === 'ok' ? '' : `(${state})`, c.offsetMs != null ? `· ajuste propio ${fmtOffset(c.offsetMs)}` : '', badge(c)].filter(Boolean).join(' ')))
      );
    }
  }

  function updateSrcBadge() {
    const b = $('#sv-src', root);
    if (!current) { b.style.display = 'none'; return; }
    const st = previewState(current);
    b.style.display = '';
    b.className = 'src-badge ' + st.kind;
    b.innerHTML =
      st.kind === 'proxy' ? 'Vista previa fluida (proxy)'
      : st.kind === 'building' ? `Original 4K · preparando vista fluida ${Math.round(st.pct * 100)} %${current.proxyEta ? ' (~' + fmtTime(current.proxyEta) + ')' : ''}`
      : st.kind === 'queued' ? 'Original 4K · vista fluida en cola'
      : 'Original 4K (proxy falló) <button class="mini retry">Reintentar</button>';
    const r = b.querySelector('.retry') as HTMLButtonElement | null;
    if (r && current) { const c = current; r.onclick = () => retryProxy(c); }
  }

  let lastMarker = 0;
  function updateMarker(force = true) {
    const now = performance.now();
    if (!force && now - lastMarker < 100) return; // 10 actualizaciones/s bastan para el mapa
    lastMarker = now;
    const tel = store.telemetry;
    if (!current || !tel) return;
    const t = store.teleTime(current, video.currentTime || 0);
    const p = t == null ? null : sampleAt(tel, t);
    $('#sv-live', root).innerHTML = liveDataHtml(p);
    if (p && p.lat != null && p.lon != null) {
      marker.setLatLng([p.lat, p.lon]);
      marker.setStyle({ fillColor: clipColor(current) });
      if (!map.hasLayer(marker)) marker.addTo(map);
      if (follow.checked && !map.getBounds().pad(-0.2).contains(marker.getLatLng())) map.panTo(marker.getLatLng(), { animate: video.paused });
    } else if (map.hasLayer(marker)) marker.remove();
  }

  function updateOffsetUi() {
    if (!current) return;
    own.checked = current.offsetMs != null;
    $('#sv-offset', root).textContent = fmtOffset(store.offsetOf(current));
    $('#sv-reset-clip', root).style.display = current.offsetMs != null ? '' : 'none';
  }

  function updateUndoUi() {
    $<HTMLButtonElement>('#sv-undo', root).disabled = !store.canUndoSync;
    $<HTMLButtonElement>('#sv-redo', root).disabled = !store.canRedoSync;
  }

  function setOffset(ms: number, undoKey = '') {
    if (!current) return;
    store.pushSync(undoKey);
    if (own.checked) current.offsetMs = ms;
    else store.globalOffsetMs = ms;
    store.emit('sync');
  }

  // ---- clic en el mapa = este fotograma está aquí
  function updateModeUi() {
    const mode = store.syncLocked ? 'nav' : 'sync';
    root.querySelectorAll<HTMLButtonElement>('#sv-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    $('#sv-map', root).classList.toggle('nav', store.syncLocked);
  }
  root.querySelectorAll<HTMLButtonElement>('#sv-mode button').forEach((b) => {
    b.onclick = () => store.setSyncLocked(b.dataset.mode === 'nav');
  });

  function clickTolerance(lat: number) {
    const metersPerPx = (40075016 * Math.cos((lat * Math.PI) / 180)) / 2 ** (map.getZoom() + 8);
    return Math.max(25, metersPerPx * 25);
  }

  /** Navegar: busca qué clip grabó ese punto de la ruta y salta a ese fotograma. */
  function navigateTo(lat: number, lon: number) {
    const tel = store.telemetry!;
    const passes = passesNear(tel, lat, lon, clickTolerance(lat));
    if (!passes.length) { toast('Haz clic sobre la ruta', 'info', 2000); return; }
    const hits: { clip: Clip; t: number; pt: number }[] = [];
    for (const p of passes) {
      const pt = tel.points[p.idx];
      for (const c of store.clips) {
        const t0 = store.teleTime(c, 0);
        if (t0 == null) continue;
        const t = (pt.t - t0) / 1000;
        if (t >= 0 && t <= c.probe.duration) hits.push({ clip: c, t, pt: p.idx });
      }
    }
    if (!hits.length) { toast('No hay vídeo grabado en ese punto de la ruta', 'info', 2500); return; }
    // Si la ruta pasa varias veces, prioriza el clip actual y el paso más cercano a lo que estás viendo
    const nowT = current ? store.teleTime(current, video.currentTime) ?? 0 : 0;
    hits.sort((a, b) =>
      (a.clip === current ? 0 : 1) - (b.clip === current ? 0 : 1) ||
      Math.abs(tel.points[a.pt].t - nowT) - Math.abs(tel.points[b.pt].t - nowT));
    const hit = hits[0];
    video.pause();
    if (hit.clip !== current) selectClip(hit.clip.id);
    const seek = () => { video.currentTime = Math.min(hit.t, Math.max(0, (video.duration || hit.clip.probe.duration) - 0.05)); };
    if (video.readyState >= 1) seek();
    else video.addEventListener('loadedmetadata', seek, { once: true });
    const pt = tel.points[hit.pt];
    pickMarker.setLatLng([pt.lat!, pt.lon!]).addTo(map);
    setTimeout(() => pickMarker.remove(), 800);
    if (new Set(hits.map((h) => h.clip.id + Math.round(h.t))).size > 1)
      toast('Por aquí pasaste más de una vez: he ido al paso más cercano. Vuelve a hacer clic para el otro.', 'info', 4000);
  }

  map.on('click', (e: L.LeafletMouseEvent) => {
    const tel = store.telemetry;
    if (!tel || !current) return;
    if (store.syncLocked) { navigateTo(e.latlng.lat, e.latlng.lng); return; }
    const camStart = store.cameraStart(current);
    if (camStart == null) {
      toast('Este clip no tiene hora de grabación', 'error');
      return;
    }
    const passes = passesNear(tel, e.latlng.lat, e.latlng.lng, clickTolerance(e.latlng.lat));
    if (!passes.length) {
      toast('Haz clic sobre la ruta', 'info', 2000);
      return;
    }
    const nowT = store.teleTime(current, video.currentTime) ?? tel.start;
    passes.sort((a, b) => Math.abs(tel.points[a.idx].t - nowT) - Math.abs(tel.points[b.idx].t - nowT));
    const pt = tel.points[passes[0].idx];
    const newOffset = Math.round(pt.t - (camStart + video.currentTime * 1000));
    pickMarker.setLatLng([pt.lat!, pt.lon!]).addTo(map);
    setTimeout(() => pickMarker.remove(), 1200);
    // si ya habías sincronizado otro clip, cambiar el desfase común movería también ese: se pregunta
    const delta = newOffset - store.offsetOf(current);
    if (!own.checked && store.mapSynced && store.clips.length > 1 && Math.abs(delta) >= 300) {
      const clip = current;
      chooseScope(delta).then((r) => {
        if (!r || current !== clip) return;
        if (r === 'one') { own.checked = true; }
        setOffset(newOffset);
        store.mapSynced = true;
        store.setSyncLocked(true);
        toast(r === 'one'
          ? `Sincronizado solo ${clip.name} (los demás no cambian). El mapa pasa a 🧭 Navegar.`
          : 'Sincronizados todos los clips con este ajuste. El mapa pasa a 🧭 Navegar.', 'ok', 5000);
      });
      return;
    }
    setOffset(newOffset);
    store.mapSynced = true;
    store.setSyncLocked(true);
    toast(passes.length > 1
      ? `Sincronizado (la ruta pasa ${passes.length} veces por aquí: he usado el paso más cercano en el tiempo). El mapa pasa a modo Navegar para revisar.`
      : 'Sincronizado. El mapa pasa a modo 🧭 Navegar: haz clic en la ruta para ir a ese fotograma. Para volver a ajustar, pulsa 🎯.', 'ok', 6000);
  });

  /** ¿Aplicar el ajuste a todos los clips o solo a este? */
  function chooseScope(deltaMs: number): Promise<'one' | 'all' | null> {
    return new Promise((resolve) => {
      const d = h('div', { class: 'modal-back' });
      const s = (Math.abs(deltaMs) / 1000).toFixed(1).replace('.', ',');
      const own = store.clips.filter((c) => c.offsetMs != null && c !== current).length;
      d.innerHTML = `
      <div class="modal">
        <h2>¿A qué clips aplicar el ajuste?</h2>
        <p>Este punto cambia la sincronización <b>${s} s</b> ${deltaMs > 0 ? 'hacia delante' : 'hacia atrás'} respecto a la que tiene ahora este clip.</p>
        <p class="muted small">Si otro clip ya estaba bien sincronizado, elige «Solo este clip» para no moverlo.
          Si todos estaban igual de desfasados, «A todos».${own ? ` (${own} clip${own === 1 ? '' : 's'} con ajuste propio no cambian en ningún caso.)` : ''}</p>
        <div class="modal-actions">
          <button data-r="">Cancelar</button>
          <span class="spacer"></span>
          <button data-r="all">A todos los clips</button>
          <button data-r="one" class="primary">Solo este clip</button>
        </div>
      </div>`;
      d.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => { d.remove(); resolve((b.dataset.r as 'one' | 'all') || null); }));
      document.body.append(d);
    });
  }

  // ---- comprobar la sincronización (velocidad de la actividad frente al sonido del viento)
  const chart = $<HTMLCanvasElement>('#sv-chart', root);
  let chartT = -1;
  const redrawChart = () => { chartT = video.currentTime; if (visible) drawSyncChart(chart, current, video.currentTime); };
  function describe(c: Clip, e: SyncEstimate) {
    if (e.level === 'baja') return `No se puede saber${e.reason ? ': ' + e.reason : ''}.`;
    const q = e.level === 'alta' ? 'fiabilidad alta' : 'fiabilidad media';
    return Math.abs(e.lag) < 1
      ? `✓ Cuadra (diferencia ${fmtLag(e.lag)}, ${q}).`
      : `⚠ Parece desfasado ${fmtLag(e.lag)} (${q}): ${e.lag > 0 ? 'los datos van por detrás del vídeo' : 'los datos van por delante del vídeo'}.`;
  }
  function applyLag(c: Clip, lag: number) {
    store.pushSync();
    c.offsetMs = Math.round(store.offsetOf(c) + lag * 1000);
    store.mapSynced = true;
    store.emit('sync');
  }
  async function checkCurrent() {
    const c = current;
    if (!c) return;
    const box = $('#sv-check', root);
    box.textContent = 'Analizando el sonido del clip…';
    const est = await estimateClip(c);
    checks.set(c.id, { est, off: store.offsetOf(c) });
    if (c !== current) return;
    box.innerHTML = '';
    box.append(describe(c, est));
    if (est.level !== 'baja' && Math.abs(est.lag) >= 0.5) {
      const b = h('button', { class: 'chip' }, `Corregir este clip ${fmtLag(est.lag)}`);
      b.onclick = () => { applyLag(c, est.lag); toast(`${c.name}: sincronización corregida ${fmtLag(est.lag)} (solo este clip)`, 'ok', 4000); checkCurrent(); };
      box.append(' ', b);
    }
    drawClips();
  }
  $('#sv-check-one', root).onclick = checkCurrent;
  $('#sv-check-all', root).onclick = async () => {
    if (!store.telemetry || !store.clips.length) return;
    const d = h('div', { class: 'modal-back' });
    d.innerHTML = `<div class="modal wide"><h2>🔍 Comprobar la sincronización</h2>
      <p class="muted small">Se compara el ruido del viento de cada vídeo con la velocidad de la actividad. Funciona bien en clips con
      paradas, arrancadas o cambios de ritmo; con velocidad constante no se puede saber.</p>
      <div id="ck-list" class="ck-list"></div><div id="ck-sum" class="mt"></div>
      <div class="modal-actions"><span class="spacer"></span><button id="ck-ok" class="primary">Cerrar</button></div></div>`;
    document.body.append(d);
    $('#ck-ok', d).onclick = () => d.remove();
    const list = $('#ck-list', d);
    const results: { c: Clip; e: SyncEstimate }[] = [];
    for (const c of store.clips) {
      const row = h('div', { class: 'ck-row' }, h('i', { style: `background:${clipColor(c)}` }), h('span', { class: 'ck-name' }, c.name), h('span', { class: 'ck-res muted' }, 'analizando…'));
      list.append(row);
      const e = await estimateClip(c);
      if (!document.body.contains(d)) return;
      checks.set(c.id, { est: e, off: store.offsetOf(c) });
      results.push({ c, e });
      const res = row.querySelector('.ck-res')!;
      res.textContent = describe(c, e);
      res.className = 'ck-res ' + (e.level === 'baja' ? 'muted' : Math.abs(e.lag) >= 1 ? 'warn-text' : 'ok-text');
      if (e.level !== 'baja' && Math.abs(e.lag) >= 0.5) {
        const b = h('button', { class: 'chip' }, 'Corregir');
        b.onclick = () => { applyLag(c, e.lag); b.replaceWith(h('span', { class: 'ok-text' }, ' corregido')); };
        row.append(b);
      }
      drawClips();
    }
    // si casi todos se desvían lo mismo, el fallo es del desfase común
    const good = results.filter((x) => x.e.level !== 'baja').map((x) => x.e.lag).sort((a, b) => a - b);
    const sum = $('#ck-sum', d);
    if (!good.length) { sum.textContent = 'Ningún clip tiene cambios de velocidad suficientes para comprobarlo. Revísalos a ojo con el mapa en 🧭 Navegar.'; return; }
    const med = good[Math.floor(good.length / 2)];
    const near = good.filter((x) => Math.abs(x - med) < 1).length;
    if (good.length >= 3 && near >= good.length * 0.7 && Math.abs(med) >= 1) {
      sum.append(`La mayoría se desvía lo mismo (${fmtLag(med)}): es el desfase común. `);
      const b = h('button', { class: 'primary' }, `Corregir todos ${fmtLag(med)}`);
      b.onclick = () => {
        store.pushSync();
        store.globalOffsetMs = Math.round(store.globalOffsetMs + med * 1000);
        store.mapSynced = true;
        store.emit('sync');
        toast(`Desfase común corregido ${fmtLag(med)}`, 'ok', 4000);
        d.remove();
      };
      sum.append(b);
    } else {
      const bad = results.filter((x) => x.e.level !== 'baja' && Math.abs(x.e.lag) >= 1).length;
      sum.textContent = bad ? `${bad} clip${bad === 1 ? '' : 's'} parece${bad === 1 ? '' : 'n'} desfasado${bad === 1 ? '' : 's'} respecto a los demás: «Corregir» le pone un ajuste propio.` : '✓ Los clips que se pueden comprobar cuadran.';
    }
  };

  // ---- vídeo
  function selectClip(id: string) {
    const c = store.clip(id) ?? null;
    if (!c) return;
    const changed = c !== current;
    current = c;
    sel.value = c.id;
    prioritizeProxy(c);
    updateSrcBadge();
    if (changed || video.dataset.src !== previewUrl(c)) {
      const t = changed ? 0 : video.currentTime;
      video.src = previewUrl(c);
      video.dataset.src = previewUrl(c);
      video.currentTime = t;
    }
    updateOffsetUi();
    drawClips();
    updateMarker();
    const e = current ? checkOf(current) : null;
    $('#sv-check', root).textContent = e && current ? describe(current, e) : 'Si las subidas y bajadas de las dos líneas coinciden, el clip está bien sincronizado.';
    redrawChart();
  }

  function fillSelect() {
    sel.innerHTML = '';
    for (const c of store.clips) sel.append(h('option', { value: c.id }, c.name));
    $('#sv-novideo', root).style.display = store.clips.length ? 'none' : '';
    if (!store.clips.length) {
      current = null;
      video.removeAttribute('src');
      video.load();
      return;
    }
    if (!current || !store.clips.includes(current)) selectClip(store.clips[0].id);
    else sel.value = current.id;
  }

  sel.onchange = () => selectClip(sel.value);
  const togglePlay = () => (video.paused ? video.play() : video.pause());
  $('#sv-play', root).onclick = togglePlay;
  video.onclick = togglePlay;
  const step = (n: number) => {
    video.pause();
    const fps = current?.probe.fps || 30;
    video.currentTime = clamp(video.currentTime + n / fps, 0, video.duration || 0);
  };
  $('#sv-fb', root).onclick = () => step(-1);
  $('#sv-ff', root).onclick = () => step(1);
  video.onplay = () => ($('#sv-play', root).textContent = '❚❚');
  video.onpause = () => ($('#sv-play', root).textContent = '▶');
  scrub.oninput = () => {
    if (video.duration) video.currentTime = (Number(scrub.value) / 1000) * video.duration;
  };
  const onTime = () => {
    $('#sv-time', root).textContent = `${fmtTime(video.currentTime, true)} / ${fmtTime(video.duration || 0)}`;
    if (video.duration && document.activeElement !== scrub) scrub.value = String((video.currentTime / video.duration) * 1000);
    updateMarker(video.paused);
    if (Math.abs(video.currentTime - chartT) > 0.5) redrawChart();
  };
  video.ontimeupdate = () => onTime();
  video.onseeked = () => { $('#sv-time', root).textContent = `${fmtTime(video.currentTime, true)} / ${fmtTime(video.duration || 0)}`; updateMarker(true); };
  let raf = 0;
  const loop = () => {
    if (!video.paused) onTime();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  void raf;

  root.querySelectorAll<HTMLButtonElement>('.offset-row button').forEach((b) => {
    b.onclick = () => current && setOffset(store.offsetOf(current) + Number(b.dataset.d), 'nudge');
  });
  own.onchange = () => {
    if (!current) return;
    store.pushSync();
    current.offsetMs = own.checked ? store.globalOffsetMs : null;
    store.emit('sync');
  };
  $('#sv-reset-clip', root).onclick = () => {
    if (current) { store.pushSync(); current.offsetMs = null; store.emit('sync'); }
  };
  $('#sv-auto', root).onclick = () => { store.autoSync(); store.setSyncLocked(false); };
  const undo = () => { if (store.undoSync()) toast('Sincronización deshecha', 'info', 1500); };
  const redo = () => { if (store.redoSync()) toast('Sincronización rehecha', 'info', 1500); };
  $('#sv-undo', root).onclick = undo;
  $('#sv-redo', root).onclick = redo;
  $('#sv-clear', root).onclick = async () => {
    const r = await window.api.confirm(
      '¿Quitar la sincronización? Los clips volverán a la hora que guarda la cámara (puedes deshacerlo con Ctrl+Z).',
      ['Quitar', 'Cancelar']
    );
    if (r === 0) { store.clearSync(); store.setSyncLocked(false); toast('Sincronización quitada', 'info', 2500); }
  };

  store.on((what) => {
    if (what === 'clips' || what === 'all') fillSelect();
    if (what === 'telemetry' || what === 'all') drawTrack(true);
    if (what === 'proxy' || what === 'proxy-progress') updateSrcBadge();
    if (what === 'proxy' && current && current.proxy && video.dataset.src !== previewUrl(current)) {
      const t = video.currentTime;
      const playing = !video.paused;
      video.src = previewUrl(current);
      video.dataset.src = previewUrl(current);
      video.currentTime = t;
      if (playing) video.play();
    }
    if (['clips', 'telemetry', 'sync', 'all'].includes(what)) {
      updateOffsetUi();
      drawClips();
      updateMarker();
      redrawChart();
    }
    updateUndoUi();
    if (['lock', 'all'].includes(what)) updateModeUi();
  });
  updateUndoUi();
  updateModeUi();

  return {
    show() {
      visible = true;
      setTimeout(() => {
        map.invalidateSize();
        redrawChart();
        if (needFit) fitTrack();
      }, 0);
    },
    hide() {
      visible = false;
      video.pause();
    },
    key(e: KeyboardEvent) {
      if (e.ctrlKey && e.key.toLowerCase() === 'z' && !e.shiftKey) { undo(); return true; }
      if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { redo(); return true; }
      if (e.ctrlKey) return false;
      if (e.code === 'Space') { togglePlay(); return true; }
      if (e.key === ',') { step(-1); return true; }
      if (e.key === '.') { step(1); return true; }
      if (e.key === 'ArrowLeft' && e.shiftKey) { current && setOffset(store.offsetOf(current) - 1000, 'nudge'); return true; }
      if (e.key === 'ArrowRight' && e.shiftKey) { current && setOffset(store.offsetOf(current) + 1000, 'nudge'); return true; }
      if (e.key === 'ArrowLeft') { video.currentTime = Math.max(0, video.currentTime - 2); return true; }
      if (e.key === 'ArrowRight') { video.currentTime = Math.min(video.duration || 0, video.currentTime + 2); return true; }
      return false;
    }
  };
}
