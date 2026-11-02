import { store } from './store';
import type { ExportJob, ExportStatus } from './types';
import { buildAtlas, drawAtlas, drawData } from './overlay';
import { $, fmtTime, h, toast } from './util';

let busy = false;

/** Estado de la exportación (también lo ve la tablet). */
export const exportStatus: ExportStatus = { running: false, pct: 0, eta: null, error: null, output: null, from: null };

export interface ExportParams {
  output: string;
  width: number;
  height: number;
  fps: number;
  codec: 'hevc' | 'h264';
  quality: 'high' | 'max';
  overlay: boolean;
  music: boolean;
  from: 'pc' | 'tablet';
}

export function isExporting() {
  return busy;
}

/** Exporta el montaje actual (lo usan el diálogo del PC y la tablet). */
export async function exportProject(p: ExportParams) {
  if (busy) throw new Error('Ya hay una exportación en curso');
  const job: ExportJob = {
    segments: store.timeline.map((s) => {
      const c = store.clip(s.clipId)!;
      return { path: c.path, in: s.in, out: s.out, hasAudio: c.probe.hasAudio, clipDur: c.probe.duration };
    }),
    output: p.output,
    width: p.width,
    height: p.height,
    fps: p.fps || 30,
    codec: p.codec,
    quality: p.quality,
    overlay: null,
    transitions: store.transitions.type !== 'none' || store.transitions.fadeEnds ? store.transitions : null,
    music: p.music && store.activeSongs().length
      ? { songs: store.activeSongs().map((s) => ({ path: s.path, start: s.start, end: s.end })), ...store.musicSettings }
      : null
  };
  const withOverlay = p.overlay && !!store.telemetry && store.overlay.length > 0;
  const ovFps = Math.min(30, job.fps);
  const atlas = withOverlay ? buildAtlas(store.overlay, p.width, p.height) : null;
  if (atlas && atlas.items.length) job.overlay = { W: atlas.W, H: atlas.H, fps: ovFps, items: atlas.items };
  busy = true;
  Object.assign(exportStatus, { running: true, pct: 0, eta: null, error: null, output: p.output, from: p.from });
  store.emit('export', false);
  try {
    await window.api.exportStart(job);
    if (job.overlay && atlas) await pumpOverlay(job, atlas, ovFps);
    const r = await window.api.exportFinish();
    Object.assign(exportStatus, { running: false, pct: 1, eta: null });
    return r;
  } catch (e) {
    const msg = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    Object.assign(exportStatus, { running: false, error: /cancelad/i.test(msg) ? 'Exportación cancelada' : msg });
    throw new Error(msg);
  } finally {
    busy = false;
    store.emit('export', false);
  }
}

export async function openExportDialog() {
  if (busy) return;
  if (!store.timeline.length) {
    toast('La línea de tiempo está vacía', 'error');
    return;
  }
  const first = store.clip(store.timeline[0].clipId)!;
  const enc = store.encoders ?? (await window.api.encoders());
  store.encoders = enc;
  const srcRes = `${first.probe.width}x${first.probe.height}`;
  const gpuTxt = enc.hevcNvenc || enc.h264Nvenc ? 'GPU NVIDIA (NVENC)' : 'CPU (no se detectó NVENC: será más lento)';

  const dlg = h('div', { class: 'modal-back' });
  dlg.innerHTML = `
  <div class="modal">
    <h2>Exportar vídeo</h2>
    <div class="form">
      <label>Resolución
        <select id="x-res">
          <option value="${srcRes}">Original (${first.probe.width}×${first.probe.height})</option>
          <option value="3840x2160">4K UHD (3840×2160)</option>
          <option value="2560x1440">1440p (2560×1440)</option>
          <option value="1920x1080">1080p (1920×1080)</option>
        </select>
      </label>
      <label>Formato
        <select id="x-codec">
          <option value="hevc">H.265 / HEVC (menos peso, recomendado)</option>
          <option value="h264">H.264 (máxima compatibilidad)</option>
        </select>
      </label>
      <label>Calidad
        <select id="x-q">
          <option value="high">Alta</option>
          <option value="max">Máxima (archivo más grande)</option>
        </select>
      </label>
      <label>Fotogramas por segundo
        <select id="x-fps">
          <option value="${first.probe.fps}">Igual que el original (${Math.round(first.probe.fps)} fps)</option>
          <option value="30">30 fps</option>
          <option value="60">60 fps</option>
        </select>
      </label>
      <label class="check row-check"><input type="checkbox" id="x-ov" ${store.overlayEnabled && store.overlay.length && store.telemetry ? 'checked' : ''} ${store.overlay.length && store.telemetry ? '' : 'disabled'}>
        Grabar los datos en el vídeo (${store.overlay.length} ${store.overlay.length === 1 ? 'dato' : 'datos'}${store.telemetry ? '' : ' · falta cargar el FIT'})</label>
      ${store.activeSongs().length ? `<label class="check row-check"><input type="checkbox" id="x-mus" checked> Incluir la música (🎵 ${store.activeSongs().length === 1 ? store.activeSongs()[0].name : store.activeSongs().length + ' canciones'})</label>` : ''}
      <p class="muted">Duración: ${fmtTime(store.timelineDuration())} · ${store.timeline.length} segmentos · Codificador: ${gpuTxt}</p>
      <p class="muted small">Se exporta desde los archivos originales, no desde los proxies.</p>
    </div>
    <div class="progress" id="x-prog" hidden><div class="bar big"><div id="x-bar"></div></div><div id="x-txt" class="mono"></div></div>
    <div class="modal-actions">
      <button id="x-cancel">Cancelar</button>
      <button id="x-go" class="primary">Exportar…</button>
    </div>
  </div>`;
  document.body.append(dlg);
  const close = () => dlg.remove();

  $('#x-cancel', dlg).onclick = async () => {
    if (busy) await window.api.exportCancel();
    else close();
  };

  $('#x-go', dlg).onclick = async () => {
    const out = await window.api.saveExportDialog(
      (store.telemetry?.name.replace(/\.\w+$/, '') || 'resumen') + '_editado.mp4'
    );
    if (!out) return;
    const [w, hgt] = $<HTMLSelectElement>('#x-res', dlg).value.split('x').map(Number);
    dlg.querySelectorAll<HTMLSelectElement | HTMLInputElement>('select, input').forEach((s) => (s.disabled = true));
    $('#x-go', dlg).setAttribute('disabled', '');
    $('#x-prog', dlg).hidden = false;
    $('#x-txt', dlg).textContent = 'Preparando…';
    try {
      const r = await exportProject({
        output: out, width: w, height: hgt,
        fps: Number($<HTMLSelectElement>('#x-fps', dlg).value) || 30,
        codec: $<HTMLSelectElement>('#x-codec', dlg).value as 'hevc' | 'h264',
        quality: $<HTMLSelectElement>('#x-q', dlg).value as 'high' | 'max',
        overlay: $<HTMLInputElement>('#x-ov', dlg).checked,
        music: !!dlg.querySelector<HTMLInputElement>('#x-mus')?.checked,
        from: 'pc'
      });
      close();
      toast(`Exportado en ${fmtTime(r.seconds)} con ${r.gpu ? 'la GPU' : 'la CPU'}`, 'ok', 8000);
      window.api.showItem(r.output);
    } catch (e) {
      const msg = (e as Error).message;
      if (/cancelad/i.test(msg)) {
        toast('Exportación cancelada', 'info');
        close();
      } else {
        $('#x-txt', dlg).textContent = '';
        $('#x-prog', dlg).append(h('pre', { class: 'err' }, msg));
        $('#x-go', dlg).removeAttribute('disabled');
        dlg.querySelectorAll<HTMLSelectElement | HTMLInputElement>('select, input').forEach((s) => (s.disabled = false));
      }
    }
  };
}

/** Dibuja cada fotograma de los datos y se lo pasa a FFmpeg (que va marcando el ritmo). */
async function pumpOverlay(job: ExportJob, atlas: ReturnType<typeof buildAtlas>, fps: number) {
  const canvas = document.createElement('canvas');
  canvas.width = atlas.W;
  canvas.height = atlas.H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const total = job.segments.reduce((a, s) => a + (s.out - s.in), 0);
  const frames = Math.ceil(total * fps);
  try {
    for (let k = 0; k < frames; k++) {
      const loc = store.locate(k / fps);
      const t = loc ? store.teleTime(loc.clip, loc.clipTime) : null;
      drawAtlas(ctx, atlas, store.overlay, drawData(store.telemetry, t));
      const img = ctx.getImageData(0, 0, atlas.W, atlas.H);
      const ok = await window.api.exportFrame(new Uint8Array(img.data.buffer));
      if (!ok) break; // FFmpeg terminó (error o cancelación)
    }
  } finally {
    await window.api.exportFramesEnd();
  }
}

let lastEmit = 0;
window.api?.onExportProgress(({ pct, eta }) => {
  exportStatus.pct = pct;
  exportStatus.eta = eta;
  if (Date.now() - lastEmit > 1000) { lastEmit = Date.now(); store.emit('export', false); }
  const bar = document.getElementById('x-bar');
  const txt = document.getElementById('x-txt');
  if (bar) bar.style.width = `${(pct * 100).toFixed(1)}%`;
  if (txt) txt.textContent = `${(pct * 100).toFixed(1)} %` + (eta != null ? ` · quedan ~${fmtTime(eta)}` : '');
});
