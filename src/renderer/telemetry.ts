import { Decoder, Stream } from '@garmin/fitsdk';
import type { Telemetry, TPoint } from './types';

const SEMI = 180 / 2 ** 31;
const FIT_EPOCH_MS = 631065600000; // 1989-12-31T00:00:00Z

const toMs = (v: unknown): number | null => {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v * 1000 + FIT_EPOCH_MS;
  return null;
};
const num = (v: unknown): number | undefined => (typeof v === 'number' && isFinite(v) ? v : undefined);

export function parseFit(bytes: Uint8Array, name: string): Telemetry {
  const stream = Stream.fromByteArray(Array.from(bytes));
  const decoder = new Decoder(stream);
  if (!decoder.isFIT()) throw new Error('El archivo no es un FIT válido');
  const { messages, errors } = decoder.read({ convertDateTimesToDates: true, applyScaleAndOffset: true, expandComponents: true });
  if (errors.length && !messages.recordMesgs?.length) throw new Error('No se pudo leer el FIT: ' + String(errors[0]));
  const pts: TPoint[] = [];
  for (const r of (messages.recordMesgs ?? []) as any[]) {
    const t = toMs(r.timestamp);
    if (t == null) continue;
    const lat = num(r.positionLat);
    const lon = num(r.positionLong);
    pts.push({
      t,
      lat: lat !== undefined ? lat * SEMI : undefined,
      lon: lon !== undefined ? lon * SEMI : undefined,
      alt: num(r.enhancedAltitude) ?? num(r.altitude),
      speed: num(r.enhancedSpeed) ?? num(r.speed),
      hr: num(r.heartRate),
      cad: num(r.cadence),
      power: num(r.power),
      temp: num(r.temperature),
      dist: num(r.distance)
    });
  }
  let tz: number | null = null;
  const act = (messages.activityMesgs ?? [])[0] as any;
  if (act && act.localTimestamp != null && act.timestamp != null) {
    const local = toMs(act.localTimestamp);
    const utc = toMs(act.timestamp);
    if (local != null && utc != null) tz = Math.round((local - utc) / 60000 / 15) * 15;
  }
  return finish('fit', name, pts, tz);
}

export function parseGpx(text: string, name: string): Telemetry {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('El GPX no es XML válido');
  const pts: TPoint[] = [];
  const trkpts = doc.getElementsByTagNameNS('*', 'trkpt');
  const ext = (el: Element, ...names: string[]) => {
    for (const n of names) {
      const found = el.getElementsByTagNameNS('*', n)[0];
      if (found && found.textContent) {
        const v = parseFloat(found.textContent);
        if (isFinite(v)) return v;
      }
    }
    return undefined;
  };
  for (const p of Array.from(trkpts)) {
    const timeEl = p.getElementsByTagNameNS('*', 'time')[0];
    if (!timeEl?.textContent) continue;
    const t = Date.parse(timeEl.textContent);
    if (!isFinite(t)) continue;
    pts.push({
      t,
      lat: parseFloat(p.getAttribute('lat') || ''),
      lon: parseFloat(p.getAttribute('lon') || ''),
      alt: ext(p, 'ele'),
      hr: ext(p, 'hr', 'heartrate'),
      cad: ext(p, 'cad', 'cadence'),
      power: ext(p, 'power', 'watts', 'PowerInWatts'),
      temp: ext(p, 'atemp', 'temp', 'temperature'),
      speed: ext(p, 'speed')
    });
  }
  return finish('gpx', name, pts, null);
}

function haversine(a: TPoint, b: TPoint) {
  const R = 6371000;
  const dLat = ((b.lat! - a.lat!) * Math.PI) / 180;
  const dLon = ((b.lon! - a.lon!) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat! * Math.PI) / 180) * Math.cos((b.lat! * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const hasPos = (p: TPoint) => p.lat !== undefined && p.lon !== undefined && isFinite(p.lat) && isFinite(p.lon);

function finish(source: 'fit' | 'gpx', name: string, pts: TPoint[], tz: number | null): Telemetry {
  pts.sort((a, b) => a.t - b.t);
  if (pts.length < 2) throw new Error('La actividad no tiene puntos suficientes');
  // Distancia acumulada y velocidad si faltan
  const needDist = pts.every((p) => p.dist === undefined);
  const needSpeed = pts.every((p) => p.speed === undefined);
  let acc = 0;
  let prev: TPoint | null = null;
  for (const p of pts) {
    if (prev && hasPos(prev) && hasPos(p)) {
      const d = haversine(prev, p);
      acc += d;
      if (needSpeed) {
        const dt = (p.t - prev.t) / 1000;
        p.speed = dt > 0 && dt < 30 ? d / dt : 0;
      }
    }
    if (needDist) p.dist = acc;
    if (hasPos(p)) prev = p;
  }
  if (needSpeed) {
    // suavizado ligero (media móvil de 5 puntos)
    const raw = pts.map((p) => p.speed ?? 0);
    pts.forEach((p, i) => {
      let s = 0, n = 0;
      for (let k = Math.max(0, i - 2); k <= Math.min(raw.length - 1, i + 2); k++) { s += raw[k]; n++; }
      p.speed = s / n;
    });
  }
  computeGrade(pts);
  computeTurn(pts);
  return { source, name, points: pts, tzOffsetMin: tz, start: pts[0].t, end: pts[pts.length - 1].t };
}

function smooth(vals: (number | undefined)[], half: number): (number | undefined)[] {
  return vals.map((_, i) => {
    let s = 0, n = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(vals.length - 1, i + half); k++) {
      const v = vals[k];
      if (v !== undefined) { s += v; n++; }
    }
    return n ? s / n : undefined;
  });
}

/** Pendiente (%) con una ventana de ±30 m de distancia para que no salte por el ruido del altímetro. */
function computeGrade(pts: TPoint[]) {
  const W = 30;
  let j = 0, k = 0;
  const raw: (number | undefined)[] = pts.map((p, i) => {
    if (p.dist === undefined || p.alt === undefined) return undefined;
    while (j < i && (pts[j].dist === undefined || pts[j].dist! < p.dist - W)) j++;
    if (k < i) k = i;
    while (k < pts.length - 1 && (pts[k].dist === undefined || pts[k].dist! < p.dist + W)) k++;
    const a = pts[j], b = pts[k];
    if (a.alt === undefined || b.alt === undefined || a.dist === undefined || b.dist === undefined) return undefined;
    const dd = b.dist - a.dist;
    if (dd < 15) return undefined;
    return Math.max(-35, Math.min(35, ((b.alt - a.alt) / dd) * 100));
  });
  smooth(raw, 3).forEach((g, i) => (pts[i].grade = g));
}

/** Velocidad de giro (grados/s): sirve para detectar curvas cerradas. */
function computeTurn(pts: TPoint[]) {
  const bearing = (a: TPoint, b: TPoint) => {
    const y = Math.sin(((b.lon! - a.lon!) * Math.PI) / 180) * Math.cos((b.lat! * Math.PI) / 180);
    const x =
      Math.cos((a.lat! * Math.PI) / 180) * Math.sin((b.lat! * Math.PI) / 180) -
      Math.sin((a.lat! * Math.PI) / 180) * Math.cos((b.lat! * Math.PI) / 180) * Math.cos(((b.lon! - a.lon!) * Math.PI) / 180);
    return (Math.atan2(y, x) * 180) / Math.PI;
  };
  const hd: (number | undefined)[] = pts.map((_, i) => {
    const a = pts[Math.max(0, i - 2)], b = pts[Math.min(pts.length - 1, i + 2)];
    if (!hasPos(a) || !hasPos(b) || haversine(a, b) < 4) return undefined;
    return bearing(a, b);
  });
  const raw: (number | undefined)[] = pts.map((p, i) => {
    if (i === 0 || hd[i] === undefined || hd[i - 1] === undefined) return undefined;
    let d = Math.abs(hd[i]! - hd[i - 1]!);
    if (d > 180) d = 360 - d;
    const dt = (p.t - pts[i - 1].t) / 1000;
    return dt > 0 && dt < 10 ? d / dt : undefined;
  });
  smooth(raw, 2).forEach((v, i) => (pts[i].turn = v));
}

function indexAt(tel: Telemetry, t: number): number {
  const p = tel.points;
  let lo = 0, hi = p.length - 1;
  if (t <= p[0].t) return 0;
  if (t >= p[hi].t) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p[mid].t <= t) lo = mid; else hi = mid;
  }
  return lo;
}

const KEYS = ['lat', 'lon', 'alt', 'speed', 'hr', 'cad', 'power', 'temp', 'dist', 'grade', 'turn'] as const;

/** Valor interpolado en el instante t (ms UTC). null si cae fuera de la actividad. */
export function sampleAt(tel: Telemetry, t: number): TPoint | null {
  if (t < tel.start - 2000 || t > tel.end + 2000) return null;
  const pts = tel.points;
  const i = indexAt(tel, t);
  const a = pts[i];
  const b = pts[Math.min(i + 1, pts.length - 1)];
  const gap = b.t - a.t;
  const out: TPoint = { t };
  if (gap <= 0 || gap > 10000) {
    const n = Math.abs(t - a.t) < Math.abs(t - b.t) ? a : b;
    Object.assign(out, n, { t });
    if (gap > 10000) out.speed = 0; // pausa en la grabación
    return out;
  }
  const f = Math.max(0, Math.min(1, (t - a.t) / gap));
  for (const k of KEYS) {
    const va = a[k], vb = b[k];
    if (va !== undefined && vb !== undefined) out[k] = va + (vb - va) * f;
    else out[k] = va ?? vb;
  }
  return out;
}

/** Índices [i0, i1] de los puntos entre t0 y t1. */
export function rangeIdx(tel: Telemetry, t0: number, t1: number): [number, number] {
  return [indexAt(tel, t0), indexAt(tel, t1) + 1];
}

/** Pasos de la ruta cerca de un punto: devuelve el punto más cercano de cada paso. */
export function passesNear(tel: Telemetry, lat: number, lon: number, maxM: number): { idx: number; d: number }[] {
  const cos = Math.cos((lat * Math.PI) / 180);
  const res: { idx: number; d: number }[] = [];
  let cur: { idx: number; d: number } | null = null;
  let lastIdx = -100;
  tel.points.forEach((p, i) => {
    if (!hasPos(p)) return;
    const dx = (p.lon! - lon) * cos * 111320;
    const dy = (p.lat! - lat) * 110540;
    const d = Math.hypot(dx, dy);
    if (d > maxM) return;
    if (!cur || i - lastIdx > 15) {
      cur = { idx: i, d };
      res.push(cur);
    } else if (d < cur.d) {
      cur.idx = i;
      cur.d = d;
    }
    lastIdx = i;
  });
  return res;
}

export const posPoints = (tel: Telemetry) => tel.points.filter(hasPos);
export { hasPos };
