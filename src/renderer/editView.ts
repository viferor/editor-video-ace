import { store, previewUrl, retryProxy } from './store';
import { clipColor } from './syncView';
import type { Segment } from './types';
import { $, clamp, fmtTime, h, uid } from './util';
import { paintOverlay } from './overlayView';
import { openHighlightsDialog } from './highlightsDialog';
import { openMusicDialog } from './musicDialog';
import { openTransitionsDialog, TRANSITIONS } from './transitionsDialog';

const MIN_SEG = 0.2;

export function mountEditView(root: HTMLElement) {
  root.innerHTML = `
  <div class="edit">
    <aside class="bin">
      <div class="bin-head">
        <span>Clips</span>
        <button id="ev-addall" title="Poner todos los clips en la línea de tiempo">Todos a la línea ↓</button>
      </div>
      <div id="ev-bin" class="bin-list"></div>
      <div class="bin-drop">Suelta aquí para añadir a la biblioteca</div>
      <p class="hint small">Doble clic o arrastra un clip a la línea de tiempo. También puedes soltar archivos de vídeo y el FIT/GPX sobre la ventana.</p>
    </aside>
    <section class="preview">
      <div class="video-box big">
        <video id="ev-video" preload="auto"></video>
        <canvas id="ev-canvas" class="ov-canvas"></canvas>
        <div class="nodata" id="ev-empty">La línea de tiempo está vacía</div>
      </div>
      <div class="row transport">
        <button id="ev-start" title="Ir al inicio (Inicio)">⏮</button>
        <button id="ev-play" class="icon" title="Reproducir / pausa (Espacio)">▶</button>
        <span id="ev-time" class="mono">0:00.0 / 0:00</span>
        <span class="spacer"></span>
        <label class="check"><input type="checkbox" id="ev-showdata" checked> Datos</label>
      </div>
    </section>
    <section class="timeline-wrap">
      <div class="tl-tools">
        <button id="tl-split" title="Dividir en el cabezal (S)">✂ Dividir</button>
        <button id="tl-in" title="Recortar inicio hasta el cabezal (I)">[ Inicio aquí</button>
        <button id="tl-out" title="Recortar final en el cabezal (O)">Fin aquí ]</button>
        <button id="tl-del" title="Borrar segmento (Supr)">🗑 Borrar</button>
        <button id="tl-undo" title="Deshacer (Ctrl+Z)">↶</button>
        <button id="tl-redo" title="Rehacer (Ctrl+Y)">↷</button>
        <button id="tl-hl" class="accent" title="Crear un resumen automático con los mejores momentos">✨ Highlights automáticos</button>
        <button id="tl-music-btn" title="Poner música de fondo">🎵 Música</button>
        <button id="tl-trans-btn" title="Transiciones entre momentos">⧉ Transiciones</button>
        <span class="spacer"></span>
        <span id="tl-info" class="muted"></span>
        <label>Zoom <input type="range" id="tl-zoom" min="0" max="100" value="0"></label>
      </div>
      <div id="tl-scroll" class="tl-scroll">
        <div id="tl-inner" class="tl-inner">
          <div id="tl-ruler" class="tl-ruler"></div>
          <div id="tl-track" class="tl-track"></div>
          <div id="tl-music" class="tl-music"></div>
          <div id="tl-insert" class="tl-insert"></div>
          <div id="tl-head" class="tl-head"></div>
        </div>
      </div>
    </section>
  </div>`;

  const video = $<HTMLVideoElement>('#ev-video', root);
  const bin = $('#ev-bin', root);
  const track = $('#tl-track', root);
  const inner = $('#tl-inner', root);
  const scroll = $('#tl-scroll', root);
  const headEl = $('#tl-head', root);
  const zoom = $<HTMLInputElement>('#tl-zoom', root);
  const showData = $<HTMLInputElement>('#ev-showdata', root);

  let T = 0; // posición del cabezal en la línea de tiempo (s)
  let playing = false;
  let selected: string | null = null;
  let loadedSeg: number = -1;

  const pps = () => {
    // píxeles por segundo: el mínimo hace que todo quepa en pantalla
    const total = Math.max(1, store.timelineDuration());
    const fit = (scroll.clientWidth - 40) / total;
    const z = Number(zoom.value) / 100;
    return Math.max(0.5, fit * Math.pow(60, z * z));
  };

  const segStarts = () => {
    const starts: number[] = [];
    let acc = 0;
    for (const s of store.timeline) {
      starts.push(acc);
      acc += s.out - s.in;
    }
    return starts;
  };

  function locate(t: number): { idx: number; local: number } | null {
    let acc = 0;
    for (let i = 0; i < store.timeline.length; i++) {
      const d = store.timeline[i].out - store.timeline[i].in;
      if (t < acc + d - 1e-4 || i === store.timeline.length - 1) return { idx: i, local: clamp(t - acc, 0, d) };
      acc += d;
    }
    return null;
  }

  // ------------------------------------------------------------ música
  const audio = new Audio();
  audio.preload = 'auto';
  /** Mantiene la canción al compás de la línea de tiempo (y el volumen con su fundido final). */
  function syncMusic() {
    const songs = store.activeSongs();
    const st = store.musicSettings;
    video.volume = songs.length ? Math.max(0, Math.min(1, st.origVolume)) : 1;
    const at = songs.length ? store.songAt(T) : null;
    if (!at) { if (!audio.paused) audio.pause(); return; }
    const src = window.api.mediaUrl(at.song.path);
    const switched = audio.dataset.src !== src;
    if (switched) { audio.src = src; audio.dataset.src = src; }
    const end = Math.min(store.timelineDuration(), store.musicLength());
    const fade = st.fadeOut > 0 ? Math.max(0, Math.min(1, (end - T) / st.fadeOut)) : 1;
    audio.volume = Math.max(0, Math.min(1, st.volume * fade));
    const target = at.songTime;
    if (!playing) { if (!audio.paused) audio.pause(); audio.currentTime = target; return; }
    if (audio.paused || switched) { audio.currentTime = target; audio.play().catch(() => {}); }
    else if (Math.abs(audio.currentTime - target) > 0.25) audio.currentTime = target;
  }

  // ------------------------------------------------------------ reproducción
  async function showAt(t: number, play = false) {
    T = clamp(t, 0, store.timelineDuration());
    const loc = locate(T);
    $('#ev-empty', root).style.display = loc ? 'none' : '';
    if (!loc) {
      video.removeAttribute('src');
      loadedSeg = -1;
      updateHead();
      return;
    }
    const seg = store.timeline[loc.idx];
    const clip = store.clip(seg.clipId)!;
    const src = previewUrl(clip);
    if (video.dataset.src !== src) {
      video.src = src;
      video.dataset.src = src;
      await new Promise<void>((r) => video.addEventListener('loadedmetadata', () => r(), { once: true }));
    }
    loadedSeg = loc.idx;
    video.currentTime = seg.in + loc.local;
    syncMusic();
    if (play) await video.play().catch(() => {});
    updateHead();
  }

  function play() {
    if (!store.timeline.length) return;
    if (T >= store.timelineDuration() - 0.05) T = 0;
    playing = true;
    $('#ev-play', root).textContent = '❚❚';
    showAt(T, true);
  }
  function pause() {
    playing = false;
    video.pause();
    syncMusic();
    $('#ev-play', root).textContent = '▶';
  }
  const toggle = () => (playing ? pause() : play());

  function tick() {
    if (playing && loadedSeg >= 0 && !video.seeking) {
      const seg = store.timeline[loadedSeg];
      if (seg) {
        const starts = segStarts();
        T = starts[loadedSeg] + (video.currentTime - seg.in);
        if (video.currentTime >= seg.out - 0.03 || video.ended) {
          if (loadedSeg + 1 < store.timeline.length) {
            T = starts[loadedSeg + 1];
            showAt(T, true);
          } else {
            T = store.timelineDuration();
            pause();
          }
        }
      }
      syncMusic();
      updateHead();
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  function updateHead() {
    const total = store.timelineDuration();
    headEl.style.left = `${T * pps()}px`;
    $('#ev-time', root).textContent = `${fmtTime(T, true)} / ${fmtTime(total)}`;
    const cv = $<HTMLCanvasElement>('#ev-canvas', root);
    cv.style.display = showData.checked ? '' : 'none';
    if (showData.checked) {
      const seg = loadedSeg >= 0 ? store.timeline[loadedSeg] : null;
      const clip = seg ? store.clip(seg.clipId) : null;
      paintOverlay(cv, clip ? { clip, clipTime: video.currentTime } : null);
    }
    if (playing) {
      const x = T * pps();
      if (x > scroll.scrollLeft + scroll.clientWidth - 60 || x < scroll.scrollLeft) scroll.scrollLeft = x - 60;
    }
  }

  // ------------------------------------------------------------ biblioteca
  function renderBin() {
    bin.innerHTML = '';
    if (!store.clips.length) bin.append(h('div', { class: 'muted pad' }, 'Sin clips. Usa «Añadir clips».'));
    for (const c of store.clips) {
      const used = store.timeline.filter((s) => s.clipId === c.id).length;
      const tel = store.telemetry;
      const t0 = store.teleTime(c, 0);
      const syncWarn = tel && (t0 == null || t0 + c.probe.duration * 1000 < tel.start || t0 > tel.end);
      const item = h('div', { class: 'bin-item', draggable: 'true', title: c.path },
        h('i', { class: 'dot', style: `background:${clipColor(c)}` }),
        h('div', { class: 'bin-main' },
          h('div', { class: 'bin-name' }, c.name),
          h('div', { class: 'bin-meta' },
            `${fmtTime(c.probe.duration)} · ${c.probe.width}×${c.probe.height} · ${Math.round(c.probe.fps)} fps`,
            used ? h('span', { class: 'tag' }, `en línea ×${used}`) : null,
            syncWarn ? h('span', { class: 'tag warn' }, 'fuera de la ruta') : null
          ),
          c.proxy
            ? null
            : c.proxyError
              ? h('div', { class: 'bin-meta err' }, 'Proxy falló: la vista previa irá a saltos ', h('button', { class: 'mini retry' }, 'Reintentar'))
              : h('div', { class: 'proxy-line' },
                  h('div', { class: 'bar' }, h('div', { style: `width:${Math.round(c.proxyPct * 100)}%` })),
                  h('span', {}, c.proxyPct > 0
                    ? `Vista fluida ${Math.round(c.proxyPct * 100)} %${c.proxyEta && c.proxyEta >= 1 ? ' · ~' + fmtTime(c.proxyEta) : ''}`
                    : 'Vista fluida: en cola'))
        ),
        h('button', { class: 'x', title: 'Quitar del proyecto' }, '×')
      );
      item.ondblclick = () => store.addToTimeline(c.id);
      const retry = item.querySelector('.retry') as HTMLButtonElement | null;
      if (retry) retry.onclick = (e) => { e.stopPropagation(); retryProxy(c); };
      item.ondragstart = (e) => e.dataTransfer!.setData('text/clip', c.id);
      (item.querySelector('.x') as HTMLButtonElement).onclick = async (e) => {
        e.stopPropagation();
        if ((await window.api.confirm(`¿Quitar ${c.name} del proyecto?`, ['Quitar', 'Cancelar'])) === 0) store.removeClip(c.id);
      };
      bin.append(item);
    }
  }
  $('#ev-addall', root).onclick = () => {
    for (const c of store.clips) store.timeline.push({ id: uid(), clipId: c.id, in: 0, out: c.probe.duration });
    store.emit('timeline');
  };

  // ------------------------------------------------------------ línea de tiempo
  function renderTimeline() {
    const k = pps();
    const total = store.timelineDuration();
    inner.style.width = `${Math.max(scroll.clientWidth, total * k + 200)}px`;
    track.innerHTML = '';
    store.timeline.forEach((s, i) => {
      const c = store.clip(s.clipId);
      if (!c) return;
      const w = (s.out - s.in) * k;
      const el = h('div', {
        class: 'seg' + (s.id === selected ? ' sel' : ''),
        style: `width:${w}px;--c:${clipColor(c)}`,
        draggable: 'true',
        title: `${c.name}\n${fmtTime(s.in, true)} → ${fmtTime(s.out, true)}`
      },
        h('div', { class: 'h l' }),
        h('div', { class: 'seg-label' }, w > 70 ? c.name : ''),
        h('div', { class: 'seg-dur' }, w > 40 ? fmtTime(s.out - s.in) : ''),
        h('div', { class: 'h r' })
      );
      el.onpointerdown = (e) => {
        if ((e.target as HTMLElement).classList.contains('h')) return;
        selected = s.id;
        track.querySelectorAll('.seg.sel').forEach((x) => x.classList.remove('sel'));
        el.classList.add('sel');
      };
      el.ondragstart = (e) => {
        if ((e.target as HTMLElement).classList?.contains('h')) { e.preventDefault(); return; }
        e.dataTransfer!.setData('text/seg', String(i));
      };
      for (const side of ['l', 'r'] as const) {
        const handle = el.querySelector(`.h.${side}`) as HTMLElement;
        handle.onpointerdown = (e) => startTrim(e, s, side, el);
      }
      track.append(el);
    });
    renderRuler(total, k);
    renderMusicLane(k);
    // marcas de transición en cada corte
    const tr = store.transitions;
    $<HTMLButtonElement>('#tl-trans-btn', root).textContent = tr.type === 'none' && !tr.fadeEnds ? '⧉ Transiciones' : `⧉ ${(TRANSITIONS.find((x) => x[0] === tr.type)?.[1] ?? '').split(' (')[0]}`;
    if (tr.type !== 'none') {
      let acc = 0;
      store.timeline.forEach((s, i) => {
        acc += s.out - s.in;
        if (i < store.timeline.length - 1) track.append(h('div', { class: 'tr-mark', style: `left:${acc * k}px`, title: 'Transición' }, '◆'));
      });
    }
    $('#tl-info', root).textContent = store.timeline.length
      ? `${store.timeline.length} segmentos · ${fmtTime(total)}`
      : '';
    updateHead();
  }

  const SONG_COLORS = ['#9b7bff', '#ff7ab8', '#3bd1c8', '#ffb347', '#7bb4ff', '#b6e36b'];
  function renderMusicLane(k: number) {
    const lane = $('#tl-music', root);
    lane.innerHTML = '';
    const songs = store.activeSongs();
    lane.style.display = store.songs.length ? '' : 'none';
    const btn = $<HTMLButtonElement>('#tl-music-btn', root);
    btn.textContent = !store.songs.length ? '🎵 Música'
      : songs.length === 1 ? `🎵 ${songs[0].name.replace(/\.[^.]+$/, '').slice(0, 22)}`
      : `🎵 ${songs.length} canciones · ${fmtTime(store.musicLength())}`;
    if (!songs.length) { lane.append(h('div', { class: 'muted small lane-empty' }, 'Ninguna canción marcada')); return; }
    let off = 0;
    songs.forEach((s, n) => {
      const len = s.end - s.start;
      const color = SONG_COLORS[store.songs.indexOf(s) % SONG_COLORS.length];
      const bar = h('div', { class: 'tl-music-bar', style: `left:${off * k}px;width:${len * k}px;--sc:${color}`, title: `${s.name} · ${Math.round(s.bpm)} BPM · ${fmtTime(len)}` },
        h('span', {}, `🎵 ${n + 1}. ${s.name} · ${Math.round(s.bpm)} BPM`));
      const beatPx = (60 / s.bpm) * k;
      s.beats.forEach((b, i) => {
        const t = b - s.start;
        if (t <= 0 || t >= len) return;
        const isBar = (i - s.barPhase) % 4 === 0;
        if (!isBar && beatPx < 7) return;
        bar.append(h('i', { class: isBar ? 'bar' : '', style: `left:${t * k}px` }));
      });
      lane.append(bar);
      off += len;
    });
    const diff = store.timelineDuration() - store.musicLength();
    lane.title = Math.abs(diff) < 0.5 ? 'El montaje dura lo mismo que la música' : diff > 0 ? `El montaje dura ${fmtTime(diff)} más que la música` : `La música dura ${fmtTime(-diff)} más que el montaje (se cortará con un fundido)`;
  }

  function renderRuler(total: number, k: number) {
    const ruler = $('#tl-ruler', root);
    ruler.innerHTML = '';
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
    const step = steps.find((s) => s * k >= 70) ?? 3600;
    for (let t = 0; t <= total + step; t += step) {
      ruler.append(h('div', { class: 'tick', style: `left:${t * k}px` }, fmtTime(t)));
    }
  }

  function startTrim(e: PointerEvent, s: Segment, side: 'l' | 'r', segEl: HTMLElement) {
    e.preventDefault();
    e.stopPropagation();
    pause();
    selected = s.id;
    const c = store.clip(s.clipId)!;
    const x0 = e.clientX;
    const in0 = s.in;
    const out0 = s.out;
    const k = pps();
    const target = e.target as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const d = (ev.clientX - x0) / k;
      if (side === 'l') s.in = clamp(in0 + d, 0, s.out - MIN_SEG);
      else s.out = clamp(out0 + d, s.in + MIN_SEG, c.probe.duration);
      segEl.style.width = `${(s.out - s.in) * k}px`;
      // previsualiza el fotograma del borde
      const starts = segStarts();
      const i = store.timeline.indexOf(s);
      showAt(starts[i] + (side === 'l' ? 0 : s.out - s.in - 0.001));
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      store.emit('timeline');
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  }

  function dropIndex(clientX: number) {
    const rect = track.getBoundingClientRect();
    const x = clientX - rect.left;
    const k = pps();
    const starts = segStarts();
    for (let i = 0; i < store.timeline.length; i++) {
      const mid = (starts[i] + (store.timeline[i].out - store.timeline[i].in) / 2) * k;
      if (x < mid) return i;
    }
    return store.timeline.length;
  }

  const insertEl = $('#tl-insert', root);
  const VIDEO_RE = /\.(mp4|mov|m4v|mkv)$/i;
  function showInsert(clientX: number) {
    const i = dropIndex(clientX);
    const starts = segStarts();
    const t = i < store.timeline.length ? starts[i] : store.timelineDuration();
    insertEl.style.left = `${t * pps()}px`;
    insertEl.style.display = 'block';
  }
  function hideInsert() {
    track.classList.remove('drop');
    insertEl.style.display = 'none';
  }
  const timelineArea = $('.timeline-wrap', root);
  timelineArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    track.classList.add('drop');
    showInsert(e.clientX);
  });
  timelineArea.addEventListener('dragleave', (e) => {
    if (!timelineArea.contains(e.relatedTarget as Node)) hideInsert();
  });
  timelineArea.addEventListener('drop', async (e) => {
    e.preventDefault();
    hideInsert();
    const to0 = dropIndex(e.clientX);
    // Archivos de vídeo desde el Explorador: se añaden e insertan en esa posición
    const files = Array.from(e.dataTransfer?.files ?? []);
    const vids = files.map((f) => window.api.pathForFile(f)).filter((p) => p && VIDEO_RE.test(p));
    if (vids.length) {
      (e as DragEvent & { videosHandled?: boolean }).videosHandled = true;
      await store.addClips(vids);
      const clips = vids
        .map((p) => store.clipByPath(p))
        .filter((c): c is NonNullable<typeof c> => !!c)
        .sort((a, b) => (a.cameraStamp ?? 0) - (b.cameraStamp ?? 0) || a.name.localeCompare(b.name));
      clips.forEach((c, k) => store.timeline.splice(to0 + k, 0, { id: uid(), clipId: c.id, in: 0, out: c.probe.duration }));
      if (clips.length) store.emit('timeline');
      return;
    }
    let to = to0;
    const clipId = e.dataTransfer!.getData('text/clip');
    const segIdx = e.dataTransfer!.getData('text/seg');
    if (clipId) store.addToTimeline(clipId, to);
    else if (segIdx !== '') {
      const from = Number(segIdx);
      const [moved] = store.timeline.splice(from, 1);
      if (to > from) to--;
      store.timeline.splice(to, 0, moved);
      store.emit('timeline');
    }
  });

  // clic en la regla o zona vacía = mover cabezal
  const seekFromEvent = (e: PointerEvent) => {
    const rect = inner.getBoundingClientRect();
    showAt((e.clientX - rect.left) / pps());
  };
  $('#tl-ruler', root).onpointerdown = (e) => {
    pause();
    seekFromEvent(e);
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    el.onpointermove = (ev) => seekFromEvent(ev);
    el.onpointerup = () => (el.onpointermove = null);
  };
  track.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).classList.contains('h')) return;
    pause();
    const rect = inner.getBoundingClientRect();
    showAt((e.clientX - rect.left) / pps());
  });

  // ------------------------------------------------------------ edición
  function currentSeg() {
    const loc = locate(T);
    return loc ? { ...loc, seg: store.timeline[loc.idx] } : null;
  }

  function split() {
    const cur = currentSeg();
    if (!cur) return;
    const { seg, local } = cur;
    const at = seg.in + local;
    if (at - seg.in < MIN_SEG || seg.out - at < MIN_SEG) return;
    const right: Segment = { id: uid(), clipId: seg.clipId, in: at, out: seg.out };
    seg.out = at;
    store.timeline.splice(cur.idx + 1, 0, right);
    selected = right.id;
    store.emit('timeline');
  }
  function trimIn() {
    const cur = currentSeg();
    if (!cur) return;
    const at = cur.seg.in + cur.local;
    if (cur.seg.out - at < MIN_SEG) return;
    cur.seg.in = at;
    selected = cur.seg.id;
    T = segStarts()[cur.idx];
    store.emit('timeline');
  }
  function trimOut() {
    const cur = currentSeg();
    if (!cur) return;
    const at = cur.seg.in + cur.local;
    if (at - cur.seg.in < MIN_SEG) return;
    cur.seg.out = at;
    selected = cur.seg.id;
    store.emit('timeline');
  }
  function del() {
    const id = selected ?? currentSeg()?.seg.id;
    if (!id) return;
    store.timeline = store.timeline.filter((s) => s.id !== id);
    selected = null;
    store.emit('timeline');
  }

  $('#tl-split', root).onclick = split;
  $('#tl-in', root).onclick = trimIn;
  $('#tl-out', root).onclick = trimOut;
  $('#tl-del', root).onclick = del;
  $('#tl-undo', root).onclick = () => store.undoTimeline();
  $('#tl-redo', root).onclick = () => store.redoTimeline();
  $('#tl-hl', root).onclick = () => { pause(); openHighlightsDialog(); };
  $('#tl-music-btn', root).onclick = () => { pause(); openMusicDialog(); };
  $('#tl-trans-btn', root).onclick = () => { pause(); openTransitionsDialog(); };
  const updateUndo = () => {
    $<HTMLButtonElement>('#tl-undo', root).disabled = !store.canUndoTimeline;
    $<HTMLButtonElement>('#tl-redo', root).disabled = !store.canRedoTimeline;
  };
  store.on(updateUndo);
  updateUndo();
  $('#ev-play', root).onclick = toggle;
  video.onclick = toggle;
  $('#ev-start', root).onclick = () => { pause(); showAt(0); scroll.scrollLeft = 0; };
  zoom.oninput = () => renderTimeline();
  showData.onchange = updateHead;
  new ResizeObserver(() => renderTimeline()).observe(scroll);

  store.on((what) => {
    if (['clips', 'proxy', 'proxy-progress', 'sync', 'telemetry', 'all', 'timeline'].includes(what)) renderBin();
    if (['overlay', 'sync', 'telemetry'].includes(what) && !playing) updateHead();
    if (what === 'music') { renderTimeline(); syncMusic(); }
    if (what === 'transitions' || what === 'all') renderTimeline();
    if (['timeline', 'clips', 'all'].includes(what)) {
      renderTimeline();
      if (!playing) showAt(T);
    }
    if (what === 'proxy' && !playing && loadedSeg >= 0) showAt(T);
  });

  renderBin();
  renderTimeline();

  return {
    show() { renderTimeline(); showAt(T); },
    hide() { pause(); },
    key(e: KeyboardEvent) {
      const k = e.key.toLowerCase();
      if (e.ctrlKey && k === 'z' && !e.shiftKey) { store.undoTimeline(); return true; }
      if (e.ctrlKey && (k === 'y' || (e.shiftKey && k === 'z'))) { store.redoTimeline(); return true; }
      if (e.ctrlKey) return false;
      if (e.code === 'Space') { toggle(); return true; }
      if (k === 's' && !e.ctrlKey) { split(); return true; }
      if (k === 'i') { trimIn(); return true; }
      if (k === 'o' && !e.ctrlKey) { trimOut(); return true; }
      if (e.key === 'Delete' || e.key === 'Backspace') { del(); return true; }
      if (e.key === 'Home') { pause(); showAt(0); return true; }
      if (e.key === 'End') { pause(); showAt(store.timelineDuration()); return true; }
      if (e.key === 'ArrowLeft') { pause(); showAt(T - (e.shiftKey ? 5 : 1 / 30)); return true; }
      if (e.key === 'ArrowRight') { pause(); showAt(T + (e.shiftKey ? 5 : 1 / 30)); return true; }
      return false;
    }
  };
}
