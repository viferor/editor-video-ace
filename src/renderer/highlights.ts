// Highlights automáticos: puntúa cada segundo de vídeo con los datos de la actividad (y, opcionalmente,
// con el movimiento y el sonido del vídeo) y elige los mejores momentos hasta llenar la duración pedida.
import { store } from './store';
import { sampleAt } from './telemetry';
import type { Clip, Segment, Telemetry } from './types';
import { uid } from './util';

export interface HighlightOptions {
  target: number; // segundos del resumen
  clipLen: number; // segundos por momento
  speed: boolean; // velocidad y bajadas
  curves: boolean;
  climbs: boolean; // rampas duras y cimas
  effort: boolean; // pulso / potencia
  video: boolean; // movimiento y sonido del vídeo
  includeEnds: boolean; // salida y llegada
  variety: 'alta' | 'media' | 'baja'; // reparto a lo largo de la ruta
  /** Solo una parte de la salida: entre dos instantes (ms UTC) o entre dos distancias (m). */
  range?: { kind: 'time' | 'km'; from: number; to: number } | null;
  /**
   * Duración exacta de cada momento, en orden (para cortar al ritmo de la música).
   * Si se da, el resumen tiene exactamente estos momentos y dura su suma.
   */
  lengths?: number[] | null;
}

/** ¿El instante t (ms UTC de la actividad) / punto p está dentro del tramo pedido? */
export function inRange(range: HighlightOptions['range'], t: number | null, dist: number | undefined) {
  if (!range) return true;
  if (range.kind === 'time') return t != null && t >= range.from && t <= range.to;
  return dist !== undefined && dist >= range.from && dist <= range.to;
}

/** Segundos de vídeo que caen dentro del tramo (para mostrarlo en el diálogo). */
export function videoInRange(range: HighlightOptions['range']): number {
  const tel = store.telemetry;
  let n = 0;
  for (const c of store.clips) {
    for (let i = 0; i < c.probe.duration; i += 2) {
      const t = store.teleTime(c, i);
      const d = range?.kind === 'km' && tel && t != null ? sampleAt(tel, t)?.dist : undefined;
      if (inRange(range, t, d)) n += Math.min(2, c.probe.duration - i);
    }
  }
  return n;
}

export const DEFAULT_HL: HighlightOptions = {
  target: 60, clipLen: 5, speed: true, curves: true, climbs: true, effort: true, video: true, includeEnds: true, variety: 'alta'
};

interface Sec { clip: Clip; i: number; f: Record<string, number | undefined>; stopped: boolean; score: number; summit: boolean; pos?: number; vt: number }

/** Cimas: máximos de altitud con al menos 40 m de subida previa. */
function summits(tel: Telemetry): number[] {
  const pts = tel.points.filter((p) => p.alt !== undefined && p.dist !== undefined);
  const res: number[] = [];
  let j0 = 0, j1 = 0, lastD = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    while (pts[j0].dist! < p.dist! - 2000) j0++;
    while (j1 < pts.length - 1 && pts[j1 + 1].dist! <= p.dist! + 500) j1++;
    let isMax = true, minBefore = p.alt!;
    for (let k = j0; k <= j1; k++) {
      if (pts[k].alt! > p.alt!) { isMax = false; break; }
      if (k < i) minBefore = Math.min(minBefore, pts[k].alt!);
    }
    if (isMax && p.alt! - minBefore >= 40 && p.dist! - lastD > 2000) { res.push(p.t); lastD = p.dist!; }
  }
  return res;
}

function zscore(values: (number | undefined)[]): (number | undefined)[] {
  const v = values.filter((x): x is number => x !== undefined && isFinite(x));
  if (v.length < 5) return values.map(() => undefined);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length) || 1;
  return values.map((x) => (x === undefined || !isFinite(x) ? undefined : Math.max(-2, Math.min(3, (x - mean) / sd))));
}

export async function generateHighlights(opts: HighlightOptions, onProgress: (msg: string) => void): Promise<Segment[]> {
  const tel = store.telemetry;
  const clips = [...store.clips].sort((a, b) => (store.teleTime(a, 0) ?? a.cameraStamp ?? 0) - (store.teleTime(b, 0) ?? b.cameraStamp ?? 0));
  if (!clips.length) throw new Error('No hay clips en el proyecto');

  // 1) características por segundo
  const secs: Sec[] = [];
  const peaks = tel ? summits(tel) : [];
  for (let ci = 0; ci < clips.length; ci++) {
    const c = clips[ci];
    let vid: { motion: number[] | null; audio: number[] | null } = { motion: null, audio: null };
    if (opts.video) {
      onProgress(`Analizando el vídeo ${ci + 1} de ${clips.length}…`);
      try { vid = await window.api.analyze(c.proxy ?? c.path, c.probe.duration); } catch { /* sin análisis */ }
    }
    const n = Math.floor(c.probe.duration);
    for (let i = 0; i < n; i++) {
      const t = store.teleTime(c, i + 0.5);
      const p = tel && t != null ? sampleAt(tel, t) : null;
      if (!inRange(opts.range, t, p?.dist)) continue;
      const kmh = p?.speed != null ? p.speed * 3.6 : undefined;
      const f: Record<string, number | undefined> = {};
      if (p) {
        if (opts.speed) {
          f.speed = kmh;
          f.descent = kmh !== undefined && p.grade !== undefined ? kmh * Math.max(0, -p.grade) : undefined;
        }
        if (opts.curves) f.curves = p.turn !== undefined && kmh !== undefined && kmh > 8 ? p.turn * Math.min(1, kmh / 25) : undefined;
        if (opts.climbs) f.climb = p.grade !== undefined ? Math.max(0, p.grade - 3) * (p.power !== undefined ? 0.5 + p.power / 400 : 1) : undefined;
        if (opts.effort) f.effort = p.power ?? p.hr;
      }
      if (opts.video) {
        f.motion = vid.motion?.[i];
        f.audio = vid.audio?.[i];
      }
      const summit = !!(opts.climbs && t != null && peaks.some((pk) => Math.abs(pk - t) < 5000));
      secs.push({ clip: c, i, f, stopped: kmh !== undefined && kmh < 4, score: 0, summit, pos: p?.dist, vt: secs.length });
    }
  }
  if (!secs.length) throw new Error(opts.range ? 'No hay vídeo grabado en ese tramo de la salida' : 'Los clips son demasiado cortos');
  // límites dentro de cada clip (si se pidió un tramo, los momentos no se salen de él)
  const bounds = new Map<Clip, [number, number]>();
  for (const s of secs) {
    const b = bounds.get(s.clip);
    bounds.set(s.clip, b ? [Math.min(b[0], s.i), Math.max(b[1], s.i + 1)] : [s.i, s.i + 1]);
  }
  onProgress('Eligiendo los mejores momentos…');

  // 2) normalizar y puntuar
  const W: Record<string, number> = { speed: 1, descent: 1.2, curves: 1, climb: 1, effort: 0.8, motion: 0.6, audio: 0.4 };
  const keys = Object.keys(W).filter((k) => secs.some((s) => s.f[k] !== undefined));
  const z: Record<string, (number | undefined)[]> = {};
  for (const k of keys) z[k] = zscore(secs.map((s) => s.f[k]));
  secs.forEach((s, idx) => {
    let sc = 0;
    for (const k of keys) sc += (z[k][idx] ?? 0) * W[k];
    if (s.summit) sc += 3;
    if (s.stopped) sc -= 6; // parado en un semáforo, avituallamiento…
    s.score = sc;
  });
  // suavizado (ventana de 5 s dentro de cada clip)
  const smoothScore = secs.map((s, idx) => {
    let sum = 0, n = 0;
    for (let k = idx - 2; k <= idx + 2; k++) if (secs[k] && secs[k].clip === s.clip) { sum += secs[k].score; n++; }
    return sum / n;
  });

  // 3) elegir
  const picks: { clip: Clip; in: number; out: number }[] = [];
  const used = new Map<Clip, [number, number][]>();
  const overlaps = (c: Clip, a: number, b: number, margin: number) => (used.get(c) ?? []).some(([x, y]) => a < y + margin && b > x - margin);
  const add = (c: Clip, a: number, b: number) => {
    picks.push({ clip: c, in: a, out: b });
    used.set(c, [...(used.get(c) ?? []), [a, b]]);
  };
  const lens = opts.lengths && opts.lengths.length ? opts.lengths : null;
  const L = lens ? lens.reduce((a, b) => a + b, 0) / lens.length : opts.clipLen;
  const maxLen = lens ? Math.max(...lens) : L;
  const total = () => picks.reduce((s, p) => s + (p.out - p.in), 0);
  const done = () => (lens ? picks.length >= lens.length : total() >= opts.target);
  const fits = (c: Clip) => { const [lo, hi] = bounds.get(c)!; return !lens || hi - lo >= maxLen; };
  if (opts.includeEnds && fits(secs[0].clip)) {
    // salida y llegada del tramo elegido (o de toda la salida)
    const first = secs[0], last = secs[secs.length - 1];
    const [f0, f1] = bounds.get(first.clip)!;
    const a = Math.min(f0 + (f0 === 0 ? 1 : 0), Math.max(f0, f1 - L));
    add(first.clip, a, Math.min(f1, a + L));
    const [l0, l1] = bounds.get(last.clip)!;
    const b = Math.max(l0, l1 - (l1 >= last.clip.probe.duration - 0.5 ? 1 : 0));
    if (!done() && fits(last.clip) && !overlaps(last.clip, Math.max(l0, b - L), b, 1)) add(last.clip, Math.max(l0, b - L), b);
  }
  // separación mínima entre momentos del mismo clip, según la variedad pedida
  let gap = L * (opts.variety === 'alta' ? 4 : opts.variety === 'media' ? 2.5 : 1.5);
  const tryPick = (idx: number) => {
    const s = secs[idx];
    const [lo, hi] = bounds.get(s.clip)!;
    if (!fits(s.clip)) return false; // con música, cada momento tiene que caber entero
    const len = Math.min(L, hi - lo);
    const a = Math.max(lo, Math.min(hi - len, s.i + 0.5 - len * 0.45));
    if (overlaps(s.clip, a, a + len, gap)) return false;
    add(s.clip, a, a + len);
    return true;
  };
  const order = secs.map((_, i) => i).sort((a, b) => smoothScore[b] - smoothScore[a]);
  // Reparto por zonas: la ruta (por kilómetros, o por tiempo de vídeo si no hay datos) se divide en
  // tramos y primero se coge el mejor momento de cada tramo; luego se completa con los mejores del total.
  const wanted = lens ? Math.max(1, lens.length - picks.length) : Math.max(1, Math.round((opts.target - total()) / L));
  const nZones = opts.variety === 'alta' ? wanted : opts.variety === 'media' ? Math.ceil(wanted / 2) : 0;
  if (nZones > 1) {
    const withPos = secs.filter((s) => s.pos !== undefined);
    const usePos = withPos.length > secs.length * 0.6;
    const lo = usePos ? Math.min(...withPos.map((s) => s.pos!)) : 0;
    const hi = usePos ? Math.max(...withPos.map((s) => s.pos!)) : secs.length;
    const zoneOf = (s: Sec) => {
      const v = usePos ? (s.pos ?? lo) : s.vt;
      return Math.min(nZones - 1, Math.floor(((v - lo) / ((hi - lo) || 1)) * nZones));
    };
    const bestInZone = new Map<number, number>();
    for (const idx of order) {
      if (smoothScore[idx] < -1) break;
      const z = zoneOf(secs[idx]);
      if (!bestInZone.has(z)) bestInZone.set(z, idx);
    }
    // los tramos con mejores momentos primero, por si no caben todos
    const zoneBest = [...bestInZone.values()].sort((a, b) => smoothScore[b] - smoothScore[a]);
    for (const idx of zoneBest) {
      if (done()) break;
      tryPick(idx);
    }
  }
  // si no se llega a la duración pedida (poco vídeo), se permite que los momentos estén más juntos
  for (const factor of [gap / L, 1.5, 0.5, 0.05]) {
    if (done()) break;
    gap = L * Math.min(factor, gap / L);
    for (const idx of order) {
      if (done()) break;
      if (smoothScore[idx] < -1.5 && !lens && factor > 1) break; // lo que queda no merece la pena
      tryPick(idx);
    }
  }
  // último recurso: rellenar los huecos libres que queden en los clips (de mejor a peor puntuación)
  if (!done()) {
    const len = lens ? maxLen : L;
    const holes: { clip: Clip; a: number; score: number }[] = [];
    for (const [clip, [lo, hi]] of bounds) {
      const taken = [...(used.get(clip) ?? [])].sort((x, y) => x[0] - y[0]);
      let cur = lo;
      for (const [x, y] of [...taken, [hi, hi] as [number, number]]) {
        for (let a = cur; a + len <= Math.min(x, hi) + 1e-6; a += len) {
          const idx = secs.findIndex((s) => s.clip === clip && s.i === Math.floor(a + len / 2));
          holes.push({ clip, a, score: idx >= 0 ? smoothScore[idx] : -99 });
        }
        cur = Math.max(cur, y);
      }
    }
    holes.sort((x, y) => y.score - x.score);
    for (const hole of holes) {
      if (done()) break;
      if (!overlaps(hole.clip, hole.a, hole.a + len, 0)) add(hole.clip, hole.a, hole.a + len);
    }
  }
  // ajustar al tiempo pedido recortando el último momento añadido si se pasa
  const over = total() - opts.target;
  if (!lens && over > 0.5 && picks.length) {
    const lastPick = picks[picks.length - 1];
    if (lastPick.out - lastPick.in - over >= 2) lastPick.out -= over;
  }
  // 4) orden cronológico
  const when = (p: { clip: Clip; in: number }) => (store.teleTime(p.clip, p.in) ?? (p.clip.cameraStamp ?? 0) + p.in * 1000);
  picks.sort((x, y) => when(x) - when(y));
  // con música: cada momento toma la duración exacta de su hueco entre cortes
  if (lens) {
    picks.forEach((p, j) => {
      const [lo, hi] = bounds.get(p.clip)!;
      const len = Math.min(lens[j], hi - lo);
      const center = (p.in + p.out) / 2;
      p.in = Math.max(lo, Math.min(hi - len, center - len * 0.45));
      p.out = p.in + len;
    });
  }
  return picks.map((p) => ({ id: uid(), clipId: p.clip.id, in: +p.in.toFixed(3), out: +p.out.toFixed(3) }));
}

/**
 * Cortes al ritmo de la música: cada momento dura un número entero de pulsos (o de compases si son
 * largos) y empieza en un primer tiempo de compás. Con varias canciones, siempre hay un corte al
 * cambiar de canción. Devuelve la duración de cada momento, en orden.
 * maxTotal limita la duración (por ejemplo, si hay menos vídeo que música).
 */
export function musicCuts(approxLen: number, maxTotal = Infinity): { lengths: number[]; beatsPerCut: number[]; total: number } {
  const lengths: number[] = [];
  const bpcs: number[] = [];
  let used = 0;
  for (const song of store.activeSongs()) {
    if (used >= maxTotal - 1) break;
    const beatInt = 60 / song.bpm;
    const songLen = song.end - song.start;
    const end = Math.min(songLen, maxTotal - used);
    let bpc = approxLen >= beatInt * 6 ? Math.max(4, Math.round(approxLen / (beatInt * 4)) * 4) : Math.max(1, Math.round(approxLen / beatInt));
    if (bpc > 1 && bpc < 4 && bpc % 2) bpc += 1;
    bpcs.push(bpc);
    const beats = song.beats.map((b, i) => ({ t: b - song.start, bar: (i - song.barPhase) % 4 === 0 })).filter((b) => b.t >= 0);
    const k0 = Math.max(0, beats.findIndex((b) => b.bar));
    const cuts: number[] = [];
    for (let k = k0; k < beats.length; k += bpc) {
      const t = beats[k].t;
      if (t > 0.5 && t < end - 0.5) cuts.push(t);
    }
    const bounds = [0, ...cuts];
    const avg = bpc * beatInt;
    if (end - bounds[bounds.length - 1] < avg * 0.5 && bounds.length > 1) bounds.pop();
    bounds.push(end);
    if (bounds.length > 2 && bounds[1] < 1) bounds.splice(1, 1);
    for (let n = 1; n < bounds.length; n++) lengths.push(+(bounds[n] - bounds[n - 1]).toFixed(3));
    used += end;
  }
  return { lengths, beatsPerCut: bpcs, total: used };
}
