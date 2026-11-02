// Comprobar la sincronización: el ruido del viento sube y baja con la velocidad.
// Si en un clip esos cambios llegan antes o después que en la actividad, el clip está desfasado.
import { store } from './store';
import { sampleAt } from './telemetry';
import type { Clip } from './types';

export interface SyncEstimate {
  /** segundos que habría que sumar a la sincronización actual del clip */
  lag: number;
  r: number;
  /** anchura del pico (s): cuanto más estrecho, más claro */
  width: number;
  level: 'alta' | 'media' | 'baja';
  reason?: string;
  curve: [number, number][];
}

const STEP = 0.25;
const RANGE = 20; // se buscan desfases de hasta ±20 s

const levelsCache = new Map<string, Promise<{ step: number; levels: number[] } | null>>();
export function clipLevels(c: Clip) {
  const src = c.proxy ?? c.path;
  let p = levelsCache.get(src);
  if (!p) {
    p = window.api.audioLevels(src).catch(() => null);
    levelsCache.set(src, p);
  }
  return p;
}

function smooth(a: Float64Array, k: number) {
  const o = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(a.length - 1, i + k); j++) { s += a[j]; c++; }
    o[i] = s / c;
  }
  return o;
}
function stats(a: ArrayLike<number>) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m += a[i];
  m /= a.length || 1;
  let v = 0;
  for (let i = 0; i < a.length; i++) v += (a[i] - m) ** 2;
  return { mean: m, std: Math.sqrt(v / (a.length || 1)) };
}
function corr(x: Float64Array, y: Float64Array, off: number, n: number) {
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i + off]; }
  mx /= n; my /= n;
  let sxy = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx, b = y[i + off] - my;
    sxy += a * b; sx += a * a; sy += b * b;
  }
  return sx && sy ? sxy / Math.sqrt(sx * sy) : 0;
}

/** Velocidad de la actividad (km/h) en una rejilla de 0,25 s desde el tiempo de vídeo t0. */
export function speedSeries(c: Clip, fromT: number, n: number): Float64Array | null {
  const tel = store.telemetry;
  const base = store.teleTime(c, 0);
  if (!tel || base == null) return null;
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = sampleAt(tel, base + (fromT + i * STEP) * 1000);
    s[i] = p?.speed != null ? p.speed * 3.6 : 0;
  }
  return s;
}

export async function estimateClip(c: Clip): Promise<SyncEstimate> {
  const none = (reason: string): SyncEstimate => ({ lag: 0, r: 0, width: 99, level: 'baja', reason, curve: [] });
  const tel = store.telemetry;
  if (!tel) return none('sin actividad');
  const lv = await clipLevels(c);
  if (!lv || lv.levels.length < 40) return none('el clip no tiene sonido');
  // solo la parte del vídeo que cae dentro de la actividad
  const base = store.teleTime(c, 0)!;
  const v0 = Math.max(0, (tel.start - base) / 1000);
  const v1 = Math.min(c.probe.duration, (tel.end - base) / 1000);
  if (v1 - v0 < 15) return none('el clip casi no coincide con la actividad');
  const i0 = Math.ceil(v0 / STEP), i1 = Math.min(lv.levels.length, Math.floor(v1 / STEP));
  const audio = smooth(Float64Array.from(lv.levels.slice(i0, i1)), 2);
  const n = audio.length;
  const pad = Math.round(RANGE / STEP);
  const speed = speedSeries(c, i0 * STEP - RANGE, n + 2 * pad);
  if (!speed) return none('el clip no tiene hora');
  const inside = speed.subarray(pad, pad + n);
  if (stats(inside).std < 1.2) return none('velocidad casi constante en este clip: no hay cambios con los que comparar');
  if (stats(audio).std < 0.8) return none('el sonido apenas cambia (¿micrófono tapado o sin viento?)');
  const curve: [number, number][] = [];
  for (let k = -pad; k <= pad; k++) curve.push([k * STEP, corr(audio, speed, k + pad, n)]);
  let bi = 0;
  for (let i = 1; i < curve.length; i++) if (curve[i][1] > curve[bi][1]) bi = i;
  const [lag, r] = curve[bi];
  // anchura del pico: hasta dónde se mantiene casi igual de alto
  let a = bi, b = bi;
  while (a > 0 && curve[a - 1][1] >= r - 0.03) a--;
  while (b < curve.length - 1 && curve[b + 1][1] >= r - 0.03) b++;
  const width = curve[b][0] - curve[a][0];
  const atEdge = bi < 4 || bi > curve.length - 5;
  const level: SyncEstimate['level'] = atEdge || r < 0.3 ? 'baja' : r >= 0.5 && width <= 2 ? 'alta' : r >= 0.35 && width <= 3 ? 'media' : 'baja';
  return { lag, r, width, level, reason: level === 'baja' ? (atEdge ? 'el desfase parece mayor de 20 s' : r < 0.3 ? 'el sonido no sigue bien a la velocidad' : 'la coincidencia no es clara') : undefined, curve };
}

export const fmtLag = (s: number) => `${s >= 0 ? '+' : '−'}${Math.abs(s).toFixed(1).replace('.', ',')} s`;

/** Gráfica de velocidad (naranja) y sonido (azul) del clip, con el cabezal. */
export async function drawSyncChart(canvas: HTMLCanvasElement, c: Clip | null, t: number) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = (canvas.width = canvas.clientWidth * devicePixelRatio);
  const H = (canvas.height = canvas.clientHeight * devicePixelRatio);
  ctx.clearRect(0, 0, W, H);
  if (!c || !store.telemetry || !W) return;
  const lv = await clipLevels(c);
  const dur = c.probe.duration;
  const n = Math.min(600, Math.max(50, Math.round(W / devicePixelRatio / 1.5)));
  const dt = dur / n;
  const line = (vals: number[], color: string) => {
    const s = stats(vals);
    const lo = s.mean - 2.2 * s.std, hi = s.mean + 2.2 * s.std;
    ctx.beginPath();
    vals.forEach((v, i) => {
      const x = (i / (vals.length - 1)) * W;
      const y = H - 4 - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo || 1)) * (H - 8);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6 * devicePixelRatio;
    ctx.stroke();
  };
  const base = store.teleTime(c, 0);
  if (base != null) {
    const sp: number[] = [];
    for (let i = 0; i < n; i++) { const p = sampleAt(store.telemetry, base + i * dt * 1000); sp.push(p?.speed != null ? p.speed * 3.6 : 0); }
    line(sp, '#ff8a2a');
  }
  if (lv) {
    const a: number[] = [];
    for (let i = 0; i < n; i++) {
      const j0 = Math.floor((i * dt) / lv.step), j1 = Math.max(j0 + 1, Math.floor(((i + 1) * dt) / lv.step));
      let s = 0, k = 0;
      for (let j = j0; j < j1 && j < lv.levels.length; j++) { s += lv.levels[j]; k++; }
      a.push(k ? s / k : a[a.length - 1] ?? -60);
    }
    line(a, '#4dabf7');
  }
  ctx.fillStyle = '#fff';
  ctx.fillRect((t / dur) * W - devicePixelRatio, 0, 2 * devicePixelRatio, H);
}
