import { store } from './store';
import { DEFAULT_HL, generateHighlights, musicCuts, videoInRange, type HighlightOptions } from './highlights';
import { chooseMusic } from './musicDialog';
import { $, fmtTime, toast } from './util';

const KEY = 'opcionesHighlights';

function loadOpts(): HighlightOptions {
  try { return { ...DEFAULT_HL, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULT_HL }; }
}

export function openHighlightsDialog() {
  if (!store.clips.length) { toast('Añade primero los clips', 'error'); return; }
  const o = loadOpts();
  const srcTotal = store.clips.reduce((a, c) => a + c.probe.duration, 0);
  const hasTel = !!store.telemetry;
  const dlg = document.createElement('div');
  dlg.className = 'modal-back';
  dlg.innerHTML = `
  <div class="modal">
    <h2>✨ Highlights automáticos</h2>
    <p class="muted">Elige los mejores momentos de tus ${store.clips.length} clips (${fmtTime(srcTotal)} de vídeo) y los monta en la línea de tiempo.</p>
    <div class="form">
      ${store.songs.length ? `
      <div class="music-box">
        <label class="check"><input type="checkbox" id="hl-music" ${store.activeSongs().length ? 'checked' : 'disabled'}> 🎵 Ajustar a la música: dura lo mismo que las canciones marcadas y corta al ritmo</label>
        <div class="muted small" id="hl-music-info"></div>
      </div>` : `<button type="button" id="hl-addmusic" class="music-add">🎵 Añadir canciones para que el resumen dure lo mismo y corte al ritmo</button>`}
      <label>Duración del resumen <span class="muted small">(minutos:segundos, p. ej. 1:30)</span>
        <div class="row">
          <input type="text" id="hl-target" class="num dur-input">
          <div class="chips">${[30, 60, 120, 180, 300].map((d) => `<button type="button" class="chip" data-d="${d}">${fmtTime(d)}</button>`).join('')}</div>
        </div>
      </label>
      <label>Parte de la salida
        <select id="hl-range">
          <option value="all">Toda la salida</option>
          <option value="time">Entre dos horas</option>
          <option value="km">Entre dos kilómetros</option>
        </select>
      </label>
      <div class="row range-row" id="hl-rtime" hidden>
        De <input type="time" id="hl-t0" step="60"> a <input type="time" id="hl-t1" step="60">
      </div>
      <div class="row range-row" id="hl-rkm" hidden>
        Del km <input type="number" id="hl-k0" class="num km" step="0.5" min="0"> al km <input type="number" id="hl-k1" class="num km" step="0.5" min="0">
      </div>
      <div class="muted small" id="hl-avail"></div>
      <label>Duración de cada momento
        <div class="row">
          <input type="range" id="hl-len" min="2" max="30" step="1" class="grow">
          <input type="number" id="hl-lenn" class="num len-num" min="1" max="600" step="1"> <span>s</span>
        </div>
        <span class="muted small range-legend"><span>cortos · muy dinámico</span><span>largos · tranquilo</span></span>
      </label>
      <label>Variedad de zonas
        <select id="hl-variety">
          <option value="alta">Alta · momentos repartidos por toda la ruta</option>
          <option value="media">Media</option>
          <option value="baja">Baja · solo los mejores, aunque se concentren</option>
        </select>
      </label>
      <div class="hl-checks">
        <span class="muted">Qué buscar</span>
        <label class="check"><input type="checkbox" id="hl-speed"> Velocidad y bajadas rápidas</label>
        <label class="check"><input type="checkbox" id="hl-curves"> Curvas cerradas</label>
        <label class="check"><input type="checkbox" id="hl-climbs"> Rampas duras y llegada a cimas</label>
        <label class="check"><input type="checkbox" id="hl-effort"> Picos de esfuerzo (potencia / pulso)</label>
        <label class="check"><input type="checkbox" id="hl-video"> Movimiento y sonido del vídeo</label>
        <label class="check"><input type="checkbox" id="hl-ends"> Incluir la salida y la llegada</label>
        ${hasTel ? '' : '<p class="muted small">Sin FIT cargado solo se puede usar el movimiento y el sonido del vídeo.</p>'}
      </div>
      <p class="muted small">La línea de tiempo actual se sustituye. Puedes volver atrás con ↶ o Ctrl+Z.</p>
    </div>
    <div id="hl-status" class="mono muted"></div>
    <div class="modal-actions">
      <button id="hl-cancel">Cancelar</button>
      <button id="hl-go" class="primary">Generar</button>
    </div>
  </div>`;
  document.body.append(dlg);
  const sel = (id: string) => $<HTMLSelectElement>(id, dlg);
  const chk = (id: string) => $<HTMLInputElement>(id, dlg);
  const targetInp = $<HTMLInputElement>('#hl-target', dlg);
  const lenInp = $<HTMLInputElement>('#hl-len', dlg);
  const lenNum = $<HTMLInputElement>('#hl-lenn', dlg);
  targetInp.value = fmtTime(o.target);
  lenInp.value = String(Math.min(30, Math.round(o.clipLen)));
  lenNum.value = String(Math.round(o.clipLen));
  lenInp.oninput = () => { lenNum.value = lenInp.value; updateMusic(); };
  lenNum.oninput = () => { lenInp.value = String(Math.min(30, Number(lenNum.value) || 2)); updateMusic(); };

  // ---- tramo de la salida
  const tel = store.telemetry;
  const tzMs = tel ? (tel.tzOffsetMin ?? -new Date(tel.start).getTimezoneOffset()) * 60000 : 0;
  const toHHMM = (utc: number) => { const d = new Date(utc + tzMs); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
  const fromHHMM = (v: string, ref: number) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(v);
    if (!m) return null;
    const dayLocal = Math.floor((ref + tzMs) / 86400000) * 86400000;
    return dayLocal + (Number(m[1]) * 60 + Number(m[2])) * 60000 - tzMs;
  };
  const totalKm = tel ? (tel.points[tel.points.length - 1].dist ?? 0) / 1000 : 0;
  const rangeSel = sel('#hl-range');
  const t0 = $<HTMLInputElement>('#hl-t0', dlg), t1 = $<HTMLInputElement>('#hl-t1', dlg);
  const k0 = $<HTMLInputElement>('#hl-k0', dlg), k1 = $<HTMLInputElement>('#hl-k1', dlg);
  if (tel) {
    t0.value = toHHMM(tel.start); t1.value = toHHMM(tel.end + 59000);
    k0.value = '0'; k1.value = totalKm.toFixed(1); k1.max = totalKm.toFixed(1); k0.max = totalKm.toFixed(1);
  } else {
    rangeSel.disabled = true;
    rangeSel.title = 'Hace falta el FIT para elegir un tramo';
  }
  const readRange = (): HighlightOptions['range'] => {
    if (!tel || rangeSel.value === 'all') return null;
    if (rangeSel.value === 'time') {
      const a = fromHHMM(t0.value, tel.start), b = fromHHMM(t1.value, tel.start);
      return a != null && b != null ? { kind: 'time', from: a, to: b + 59999 } : null;
    }
    const a = Number(k0.value), b = Number(k1.value);
    return isFinite(a) && isFinite(b) ? { kind: 'km', from: a * 1000, to: b * 1000 } : null;
  };
  let availSec = srcTotal;
  // ---- música
  const musicChk = dlg.querySelector<HTMLInputElement>('#hl-music');
  const addMusic = dlg.querySelector<HTMLButtonElement>('#hl-addmusic');
  if (addMusic) addMusic.onclick = async () => { if (await chooseMusic()) { dlg.remove(); openHighlightsDialog(); } };
  const updateMusic = () => {
    if (!musicChk || !store.songs.length) return;
    const songs = store.activeSongs();
    const info = $('#hl-music-info', dlg);
    if (!songs.length) { info.innerHTML = 'Ninguna canción marcada. Márcalas en <b>🎵 Música</b>.'; musicChk.checked = false; }
    const on = musicChk.checked;
    targetInp.disabled = on;
    dlg.querySelectorAll<HTMLButtonElement>('.chip').forEach((b) => (b.disabled = on));
    if (!on) { if (songs.length) info.textContent = ''; return; }
    const musicLen = store.musicLength();
    const cuts = musicCuts(Number(lenNum.value) || 5, availSec * 0.6);
    targetInp.value = fmtTime(cuts.total);
    const unit = (bpc: number) => bpc >= 4 && bpc % 4 === 0 ? `${bpc / 4} ${bpc === 4 ? 'compás' : 'compases'}` : `${bpc} ${bpc === 1 ? 'pulso' : 'pulsos'}`;
    const what = songs.length === 1
      ? `«${songs[0].name}» · ${Math.round(songs[0].bpm)} BPM`
      : `${songs.length} canciones (${songs.map((s) => Math.round(s.bpm)).join(' / ')} BPM)`;
    const units = [...new Set(cuts.beatsPerCut.map(unit))].join(' / ');
    info.textContent = `${what} · ${fmtTime(musicLen)}. Cada momento: ${units} · ${cuts.lengths.length} momentos · ${fmtTime(cuts.total)}` +
      (cuts.total < musicLen - 1 ? ` (no hay vídeo suficiente para toda la música: se cortará con un fundido)` : '');
  };
  if (musicChk) musicChk.onchange = updateMusic;
  const updateRange = () => {
    $('#hl-rtime', dlg).hidden = rangeSel.value !== 'time';
    $('#hl-rkm', dlg).hidden = rangeSel.value !== 'km';
    const r = readRange();
    availSec = r ? videoInRange(r) : srcTotal;
    $('#hl-avail', dlg).textContent = !tel ? '' :
      r ? `En ese tramo hay ${fmtTime(availSec)} de vídeo.` : `Salida de ${toHHMM(tel.start)} a ${toHHMM(tel.end)} · ${totalKm.toFixed(1).replace('.', ',')} km · ${fmtTime(srcTotal)} de vídeo.`;
  };
  [rangeSel, t0, t1, k0, k1].forEach((e) => (e.onchange = () => { updateRange(); updateMusic(); }));
  updateRange();
  updateMusic();
  sel('#hl-variety').value = o.variety;
  dlg.querySelectorAll<HTMLButtonElement>('.chip').forEach((b) => (b.onclick = () => (targetInp.value = fmtTime(Number(b.dataset.d)))));
  /** Acepta "90", "1:30", "2m", "1m30s"… */
  const parseDur = (txt: string): number | null => {
    const t = txt.trim().toLowerCase().replace(',', '.');
    let m = /^(\d+):(\d{1,2})$/.exec(t);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    m = /^(?:(\d+(?:\.\d+)?)\s*m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:eg)?)?$/.exec(t);
    if (m && (m[1] || m[2])) return Number(m[1] || 0) * 60 + Number(m[2] || 0);
    if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
    return null;
  };
  const map: [string, keyof HighlightOptions][] = [['#hl-speed', 'speed'], ['#hl-curves', 'curves'], ['#hl-climbs', 'climbs'], ['#hl-effort', 'effort'], ['#hl-video', 'video'], ['#hl-ends', 'includeEnds']];
  for (const [id, k] of map) chk(id).checked = !!o[k];
  if (!hasTel) for (const id of ['#hl-speed', '#hl-curves', '#hl-climbs', '#hl-effort']) { chk(id).checked = false; chk(id).disabled = true; }
  if (!hasTel) chk('#hl-video').checked = true;

  $('#hl-cancel', dlg).onclick = () => dlg.remove();
  $('#hl-go', dlg).onclick = async () => {
    const opts: HighlightOptions = {
      target: parseDur(targetInp.value) ?? -1,
      clipLen: Math.max(1, Number(lenNum.value) || Number(lenInp.value)),
      range: readRange(),
      lengths: musicChk?.checked && store.activeSongs().length ? musicCuts(Number(lenNum.value) || 5, availSec * 0.6).lengths : null,
      variety: sel('#hl-variety').value as HighlightOptions['variety'],
      speed: chk('#hl-speed').checked,
      curves: chk('#hl-curves').checked,
      climbs: chk('#hl-climbs').checked,
      effort: chk('#hl-effort').checked,
      video: chk('#hl-video').checked,
      includeEnds: chk('#hl-ends').checked
    };
    if (opts.lengths) opts.target = opts.lengths.reduce((a, b) => a + b, 0);
    if (!(opts.target >= 5)) { toast('Escribe la duración del resumen, por ejemplo 1:30', 'info'); targetInp.focus(); return; }
    if (opts.range && opts.range.to <= opts.range.from) { toast('El final del tramo tiene que ir después del principio', 'info'); return; }
    if (availSec < 1) { toast('No hay vídeo grabado en ese tramo', 'info'); return; }
    if (opts.target > availSec) { toast(`El resumen no puede durar más que el vídeo disponible (${fmtTime(availSec)})`, 'info'); return; }
    if (!opts.speed && !opts.curves && !opts.climbs && !opts.effort && !opts.video) { toast('Marca al menos un criterio', 'info'); return; }
    try { localStorage.setItem(KEY, JSON.stringify(opts)); } catch {}
    dlg.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, #hl-go').forEach((e) => (e.disabled = true));
    try {
      const segs = await generateHighlights(opts, (m) => ($('#hl-status', dlg).textContent = m));
      store.timeline = segs;
      store.emit('timeline');
      const dur = segs.reduce((a, s) => a + s.out - s.in, 0);
      dlg.remove();
      toast((dur < opts.target - 2 ? `Solo había material para ${fmtTime(dur)}. ` : '') + `Resumen creado: ${segs.length} momentos · ${fmtTime(dur)}. Revísalo y ajusta lo que quieras (Ctrl+Z para volver atrás).`, 'ok', 7000);
    } catch (e) {
      $('#hl-status', dlg).textContent = 'Error: ' + (e as Error).message;
      dlg.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, #hl-go').forEach((el) => (el.disabled = false));
    }
  };
}
