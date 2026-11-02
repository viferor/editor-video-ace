// Motor de widgets de datos. El mismo código dibuja la vista previa y los fotogramas de la exportación.
import type { Telemetry, TPoint } from './types';
import { hasPos, sampleAt } from './telemetry';
import { uid } from './util';

export type WidgetType = 'value' | 'gauge' | 'bar' | 'graph' | 'elevation' | 'map' | 'clock';
export type Metric = 'speed' | 'hr' | 'power' | 'cad' | 'alt' | 'grade' | 'dist' | 'temp' | 'time' | 'elapsed';

export interface WidgetStyle {
  bg: 'none' | 'card' | 'glass';
  font: 'sport' | 'clean' | 'heavy' | 'mono';
  color: string;
  accent: string;
  label: boolean;
  unit: boolean;
  opacity: number;
  /** Rango para indicador/barra/gráfica; null = automático según la actividad. */
  min: number | null;
  max: number | null;
  /** Segundos que muestra la gráfica. */
  window: number;
}

export interface Widget {
  id: string;
  type: WidgetType;
  metric: Metric;
  /** Posición y tamaño en fracciones del fotograma (0–1). */
  x: number;
  y: number;
  w: number;
  h: number;
  style: WidgetStyle;
}

export interface Rect { x: number; y: number; w: number; h: number }

// ---------------------------------------------------------------- métricas
interface MetricInfo {
  label: string;
  unit: string;
  get: (p: TPoint) => number | undefined;
  fmt: (v: number) => string;
  min: number;
  max: number;
  accent: string;
}

const dec = (v: number, n: number) => v.toFixed(n).replace('.', ',');

export const METRICS: Record<Metric, MetricInfo> = {
  speed: { label: 'Velocidad', unit: 'km/h', get: (p) => (p.speed != null ? p.speed * 3.6 : undefined), fmt: (v) => dec(v, 1), min: 0, max: 60, accent: '#ff7a1a' },
  hr: { label: 'Pulso', unit: 'ppm', get: (p) => p.hr, fmt: (v) => String(Math.round(v)), min: 60, max: 190, accent: '#ff4d5e' },
  power: { label: 'Potencia', unit: 'W', get: (p) => p.power, fmt: (v) => String(Math.round(v)), min: 0, max: 500, accent: '#ffd43b' },
  cad: { label: 'Cadencia', unit: 'rpm', get: (p) => p.cad, fmt: (v) => String(Math.round(v)), min: 0, max: 120, accent: '#2fb7ff' },
  alt: { label: 'Altitud', unit: 'm', get: (p) => p.alt, fmt: (v) => String(Math.round(v)), min: 0, max: 2000, accent: '#7bd88f' },
  grade: { label: 'Pendiente', unit: '%', get: (p) => p.grade, fmt: (v) => (v > 0.05 ? '+' : '') + dec(v, 1), min: -15, max: 15, accent: '#c792ea' },
  dist: { label: 'Distancia', unit: 'km', get: (p) => (p.dist != null ? p.dist / 1000 : undefined), fmt: (v) => dec(v, v < 100 ? 1 : 0), min: 0, max: 100, accent: '#ffffff' },
  temp: { label: 'Temp.', unit: '°C', get: (p) => p.temp, fmt: (v) => String(Math.round(v)), min: -5, max: 40, accent: '#ff9f43' },
  time: { label: 'Hora', unit: '', get: () => undefined, fmt: () => '', min: 0, max: 1, accent: '#ffffff' },
  elapsed: { label: 'Tiempo', unit: '', get: () => undefined, fmt: () => '', min: 0, max: 1, accent: '#ffffff' }
};

export const WIDGET_TYPES: Record<WidgetType, { label: string; metrics: Metric[] }> = {
  value: { label: 'Número', metrics: ['speed', 'hr', 'power', 'cad', 'alt', 'grade', 'dist', 'temp'] },
  gauge: { label: 'Indicador circular', metrics: ['speed', 'hr', 'power', 'cad', 'grade'] },
  bar: { label: 'Barra', metrics: ['speed', 'hr', 'power', 'cad', 'grade', 'temp'] },
  graph: { label: 'Gráfica (últimos segundos)', metrics: ['speed', 'hr', 'power', 'cad', 'alt', 'grade'] },
  elevation: { label: 'Perfil de altitud', metrics: ['alt'] },
  map: { label: 'Minimapa del recorrido', metrics: ['dist'] },
  clock: { label: 'Hora / tiempo', metrics: ['time', 'elapsed'] }
};

const FONTS: Record<WidgetStyle['font'], { family: string; weight: number }> = {
  sport: { family: "Bahnschrift, 'DIN Alternate', 'Arial Narrow', 'Segoe UI', sans-serif", weight: 600 },
  clean: { family: "'Segoe UI', system-ui, sans-serif", weight: 600 },
  heavy: { family: "'Arial Black', 'Segoe UI Black', 'Segoe UI', sans-serif", weight: 900 },
  mono: { family: "Consolas, 'Cascadia Mono', monospace", weight: 700 }
};

// ---------------------------------------------------------------- creación y plantillas
const DEFAULT_SIZE: Record<WidgetType, [number, number]> = {
  value: [0.13, 0.11],
  gauge: [0.15, 0.25],
  bar: [0.2, 0.1],
  graph: [0.24, 0.15],
  elevation: [0.42, 0.15],
  map: [0.17, 0.28],
  clock: [0.13, 0.09]
};

export function newWidget(type: WidgetType, metric?: Metric, at?: Partial<Pick<Widget, 'x' | 'y' | 'w' | 'h'>>, style?: Partial<WidgetStyle>): Widget {
  const m = metric ?? WIDGET_TYPES[type].metrics[0];
  const [w, h] = DEFAULT_SIZE[type];
  return {
    id: uid(),
    type,
    metric: m,
    x: at?.x ?? 0.05,
    y: at?.y ?? 0.07,
    w: at?.w ?? w,
    h: at?.h ?? h,
    style: {
      bg: type === 'map' || type === 'elevation' || type === 'graph' ? 'card' : 'none',
      font: 'sport',
      color: '#ffffff',
      accent: METRICS[m].accent,
      label: true,
      unit: true,
      opacity: 1,
      min: null,
      max: null,
      window: 60,
      ...style
    }
  };
}

export interface Template { name: string; builtin?: boolean; widgets: Widget[] }

export function builtinTemplates(): Template[] {
  const W = newWidget;
  return [
    {
      name: 'Completo', builtin: true, widgets: [
        W('clock', 'time', { x: 0.035, y: 0.05 }),
        W('map', 'dist', { x: 0.795, y: 0.05 }),
        W('gauge', 'speed', { x: 0.035, y: 0.68 }),
        W('value', 'hr', { x: 0.19, y: 0.7 }),
        W('value', 'power', { x: 0.19, y: 0.82 }),
        W('value', 'cad', { x: 0.32, y: 0.7 }),
        W('value', 'grade', { x: 0.32, y: 0.82 }),
        W('elevation', 'alt', { x: 0.535, y: 0.8, w: 0.43, h: 0.15 })
      ]
    },
    {
      name: 'Minimalista', builtin: true, widgets: [
        W('value', 'speed', { x: 0.035, y: 0.82, w: 0.15, h: 0.13 }, { font: 'clean' }),
        W('value', 'hr', { x: 0.19, y: 0.84, w: 0.1, h: 0.1 }, { font: 'clean' }),
        W('value', 'power', { x: 0.3, y: 0.84, w: 0.1, h: 0.1 }, { font: 'clean' }),
        W('elevation', 'alt', { x: 0.7, y: 0.85, w: 0.265, h: 0.1 }, { bg: 'none', label: false })
      ]
    },
    {
      name: 'Puerto de montaña', builtin: true, widgets: [
        W('value', 'grade', { x: 0.035, y: 0.06, w: 0.17, h: 0.15 }, { bg: 'card' }),
        W('value', 'alt', { x: 0.215, y: 0.06, w: 0.13, h: 0.15 }, { bg: 'card' }),
        W('bar', 'power', { x: 0.035, y: 0.62, w: 0.24, h: 0.1 }, { bg: 'card' }),
        W('bar', 'hr', { x: 0.035, y: 0.735, w: 0.24, h: 0.1 }, { bg: 'card' }),
        W('value', 'speed', { x: 0.035, y: 0.85, w: 0.12, h: 0.11 }),
        W('value', 'cad', { x: 0.16, y: 0.85, w: 0.115, h: 0.11 }),
        W('elevation', 'alt', { x: 0.36, y: 0.78, w: 0.605, h: 0.18 })
      ]
    },
    {
      name: 'MTB', builtin: true, widgets: [
        W('gauge', 'speed', { x: 0.035, y: 0.68 }, { font: 'heavy' }),
        W('value', 'hr', { x: 0.19, y: 0.72 }, { font: 'heavy' }),
        W('value', 'grade', { x: 0.19, y: 0.84 }, { font: 'heavy' }),
        W('map', 'dist', { x: 0.795, y: 0.66, w: 0.17, h: 0.3 }),
        W('graph', 'hr', { x: 0.035, y: 0.05, w: 0.22, h: 0.14 })
      ]
    }
  ];
}

export function cloneWidgets(ws: Widget[]): Widget[] {
  return ws.map((w) => ({ ...w, id: uid(), style: { ...w.style } }));
}

// ---------------------------------------------------------------- datos precalculados por actividad
interface Ranges { [k: string]: { min: number; max: number } }
interface RouteGeo {
  x: Float32Array; // 0–1
  y: Float32Array; // 0–1
  t: Float64Array;
  aspect: number; // ancho/alto del recorrido
  prof: { d: Float32Array; a: Float32Array; t: Float64Array; dMax: number; aMin: number; aMax: number };
}

const rangeCache = new WeakMap<Telemetry, Ranges>();
const geoCache = new WeakMap<Telemetry, RouteGeo | null>();

function niceCeil(v: number, step: number) {
  return Math.ceil(v / step) * step;
}

export function ranges(tel: Telemetry): Ranges {
  let r = rangeCache.get(tel);
  if (r) return r;
  r = {};
  for (const m of Object.keys(METRICS) as Metric[]) {
    const vals = tel.points.map((p) => METRICS[m].get(p)).filter((v): v is number => v !== undefined && isFinite(v)).sort((a, b) => a - b);
    if (!vals.length) { r[m] = { min: METRICS[m].min, max: METRICS[m].max }; continue; }
    const p99 = vals[Math.floor(vals.length * 0.99)];
    const p01 = vals[Math.floor(vals.length * 0.01)];
    if (m === 'grade') { const a = Math.max(8, niceCeil(Math.max(Math.abs(p01), Math.abs(p99)), 5)); r[m] = { min: -a, max: a }; }
    else if (m === 'hr') r[m] = { min: 60, max: Math.max(160, niceCeil(p99, 10)) };
    else if (m === 'alt') r[m] = { min: Math.floor(p01 / 50) * 50, max: niceCeil(p99, 50) };
    else r[m] = { min: METRICS[m].min, max: Math.max(METRICS[m].min + 1, niceCeil(p99 * 1.05, m === 'power' ? 50 : 10)) };
  }
  rangeCache.set(tel, r);
  return r;
}

function routeGeo(tel: Telemetry): RouteGeo | null {
  if (geoCache.has(tel)) return geoCache.get(tel)!;
  const pts = tel.points.filter(hasPos);
  if (pts.length < 2) { geoCache.set(tel, null); return null; }
  const lat0 = pts.reduce((a, p) => a + p.lat!, 0) / pts.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    const X = p.lon! * k, Y = -p.lat!;
    minX = Math.min(minX, X); maxX = Math.max(maxX, X); minY = Math.min(minY, Y); maxY = Math.max(maxY, Y);
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1e-6;
  const x = new Float32Array(pts.length), y = new Float32Array(pts.length), t = new Float64Array(pts.length);
  pts.forEach((p, i) => {
    x[i] = (p.lon! * k - minX) / span;
    y[i] = (-p.lat! - minY) / span;
    t[i] = p.t;
  });
  const aspect = (maxX - minX) / ((maxY - minY) || 1e-6);
  // perfil: hasta 600 puntos
  const ap = tel.points.filter((p) => p.alt !== undefined && p.dist !== undefined);
  const step = Math.max(1, Math.floor(ap.length / 600));
  const sel = ap.filter((_, i) => i % step === 0);
  const prof = {
    d: Float32Array.from(sel.map((p) => p.dist!)),
    a: Float32Array.from(sel.map((p) => p.alt!)),
    t: Float64Array.from(sel.map((p) => p.t)),
    dMax: sel.length ? sel[sel.length - 1].dist! : 1,
    aMin: sel.length ? Math.min(...sel.map((p) => p.alt!)) : 0,
    aMax: sel.length ? Math.max(...sel.map((p) => p.alt!)) : 1
  };
  const g: RouteGeo = { x, y, t, aspect, prof };
  geoCache.set(tel, g);
  return g;
}

// ---------------------------------------------------------------- dibujo
export interface DrawData {
  tel: Telemetry | null;
  /** Instante de la actividad (ms UTC) que corresponde al fotograma, o null si no hay datos. */
  t: number | null;
  p: TPoint | null;
}

export function drawData(tel: Telemetry | null, t: number | null): DrawData {
  return { tel, t, p: tel && t != null ? sampleAt(tel, t) : null };
}

function font(st: WidgetStyle, px: number, weightOverride?: number) {
  const f = FONTS[st.font];
  return `${weightOverride ?? f.weight} ${Math.max(4, px).toFixed(1)}px ${f.family}`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Ajusta el tamaño de letra para que el texto quepa en el ancho dado. */
function fitText(ctx: CanvasRenderingContext2D, st: WidgetStyle, text: string, maxW: number, maxPx: number, weight?: number) {
  ctx.font = font(st, 100, weight);
  const w100 = ctx.measureText(text).width || 1;
  return Math.min(maxPx, (maxW / w100) * 100);
}

function valueOf(w: Widget, d: DrawData): number | undefined {
  if (!d.p) return undefined;
  const v = METRICS[w.metric].get(d.p);
  return v !== undefined && isFinite(v) ? v : undefined;
}

function rangeOf(w: Widget, d: DrawData) {
  const auto = d.tel ? ranges(d.tel)[w.metric] : { min: METRICS[w.metric].min, max: METRICS[w.metric].max };
  return { min: w.style.min ?? auto.min, max: w.style.max ?? auto.max };
}

function clockText(w: Widget, d: DrawData) {
  if (d.t == null || !d.tel) return '--:--';
  if (w.metric === 'elapsed') {
    const s = Math.max(0, Math.round((d.t - d.tel.start) / 1000));
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
  const off = d.tel.tzOffsetMin != null ? d.tel.tzOffsetMin * 60000 : -new Date(d.t).getTimezoneOffset() * 60000;
  const dt = new Date(d.t + off);
  return `${String(dt.getUTCHours()).padStart(2, '0')}:${String(dt.getUTCMinutes()).padStart(2, '0')}:${String(dt.getUTCSeconds()).padStart(2, '0')}`;
}

export function widgetRect(w: Widget, W: number, H: number): Rect {
  return { x: w.x * W, y: w.y * H, w: w.w * W, h: w.h * H };
}

export function drawOverlay(ctx: CanvasRenderingContext2D, W: number, H: number, widgets: Widget[], d: DrawData) {
  for (const w of widgets) drawWidget(ctx, w, widgetRect(w, W, H), d);
}

export function drawWidget(ctx: CanvasRenderingContext2D, w: Widget, r: Rect, d: DrawData) {
  const st = w.style;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.globalAlpha = st.opacity;
  const pad = Math.min(r.w, r.h) * 0.08;
  if (st.bg === 'card') {
    ctx.fillStyle = 'rgba(10, 12, 16, 0.58)';
    roundRect(ctx, r.x, r.y, r.w, r.h, Math.min(r.w, r.h) * 0.12);
    ctx.fill();
  } else if (st.bg === 'glass') {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    roundRect(ctx, r.x, r.y, r.w, r.h, Math.min(r.w, r.h) * 0.12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = Math.max(1, r.h * 0.01);
    ctx.stroke();
  }
  if (st.bg === 'none') {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
    ctx.shadowBlur = Math.max(2, r.h * 0.06);
    ctx.shadowOffsetY = Math.max(1, r.h * 0.015);
  }
  const inner: Rect = st.bg === 'none' ? { x: r.x + pad * 0.3, y: r.y + pad * 0.3, w: r.w - pad * 0.6, h: r.h - pad * 0.6 } : { x: r.x + pad, y: r.y + pad, w: r.w - 2 * pad, h: r.h - 2 * pad };
  ctx.textBaseline = 'alphabetic';
  switch (w.type) {
    case 'value': drawValue(ctx, w, inner, d); break;
    case 'clock': drawClock(ctx, w, inner, d); break;
    case 'gauge': drawGauge(ctx, w, inner, d); break;
    case 'bar': drawBar(ctx, w, inner, d); break;
    case 'graph': drawGraph(ctx, w, inner, d); break;
    case 'elevation': drawElevation(ctx, w, inner, d); break;
    case 'map': drawMap(ctx, w, inner, d); break;
  }
  ctx.restore();
}

function drawLabel(ctx: CanvasRenderingContext2D, w: Widget, r: Rect, px: number, text = METRICS[w.metric].label) {
  ctx.font = font(w.style, px, 500);
  ctx.fillStyle = w.style.color;
  ctx.globalAlpha = w.style.opacity * 0.8;
  ctx.textAlign = 'left';
  ctx.fillText(text.toUpperCase(), r.x, r.y + px * 0.95);
  ctx.globalAlpha = w.style.opacity;
}

function drawValue(ctx: CanvasRenderingContext2D, w: Widget, r: Rect, d: DrawData) {
  const st = w.style;
  const m = METRICS[w.metric];
  const v = valueOf(w, d);
  const txt = v === undefined ? '--' : m.fmt(v);
  const labelPx = st.label ? r.h * 0.22 : 0;
  if (st.label) drawLabel(ctx, w, r, labelPx);
  const unitTxt = st.unit && m.unit ? ' ' + m.unit : '';
  const avail = r.h - labelPx * 1.1;
  // número grande + unidad pequeña en la misma línea
  ctx.font = font(st, 100);
  const nW = ctx.measureText(txt).width;
  ctx.font = font(st, 42, 500);
  const uW = unitTxt ? ctx.measureText(unitTxt).width : 0;
  const px = Math.min(avail * 0.95, (r.w / (nW + uW || 1)) * 100);
  const base = r.y + r.h - avail * 0.08;
  ctx.textAlign = 'left';
  ctx.fillStyle = st.color;
  ctx.font = font(st, px);
  ctx.fillText(txt, r.x, base);
  if (unitTxt) {
    const w1 = ctx.measureText(txt).width;
    ctx.font = font(st, px * 0.42, 500);
    ctx.fillStyle = st.accent;
    ctx.fillText(unitTxt, r.x + w1, base);
  }
}

function drawClock(ctx: CanvasRenderingContext2D, w: Widget, r: Rect, d: DrawData) {
  const st = w.style;
  const labelPx = st.label ? r.h * 0.24 : 0;
  if (st.label) drawLabel(ctx, w, r, labelPx);
  const txt = clockText(w, d);
  const avail = r.h - labelPx * 1.1;
  const px = fitText(ctx, st, txt, r.w, avail * 0.95);
  ctx.font = font(st, px);
  ctx.fillStyle = st.color;
  ctx.textAlign = 'left';
  ctx.fillText(txt, r.x, r.y + r.h - avail * 0.08);
}

function drawGauge(ctx: CanvasRenderingContext2D, w: Widget, r: Rect, d: DrawData) {
  const st = w.style;
  const m = METRICS[w.metric];
  const v = valueOf(w, d);
  const { min, max } = rangeOf(w, d);
  const R = Math.min(r.w / 2, r.h / 1.75) * 0.98;
  const cx = r.x + r.w / 2;
  const cy = r.y + R * 1.02;
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
  const lw = R * 0.15;
  ctx.lineCap = 'round';
  ctx.lineWidth = lw;
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath(); ctx.arc(cx, cy, R - lw / 2, a0, a1); ctx.stroke();
  if (v !== undefined) {
    const f = Math.max(0, Math.min(1, (v - min) / (max - min || 1)));
    ctx.strokeStyle = st.accent;
    ctx.beginPath(); ctx.arc(cx, cy, R - lw / 2, a0, a0 + (a1 - a0) * Math.max(0.001, f)); ctx.stroke();
  }
  // marcas
  ctx.lineWidth = Math.max(1, R * 0.025);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  for (let i = 0; i <= 10; i++) {
    const a = a0 + ((a1 - a0) * i) / 10;
    const r1 = R - lw - R * 0.04, r2 = r1 - R * (i % 5 === 0 ? 0.12 : 0.06);
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); ctx.stroke();
  }
  const txt = v === undefined ? '--' : m.fmt(v);
  const px = fitText(ctx, st, txt, R * 1.15, R * 0.62);
  ctx.textAlign = 'center';
  ctx.fillStyle = st.color;
  ctx.font = font(st, px);
  ctx.fillText(txt, cx, cy + px * 0.3);
  if (st.unit && m.unit) {
    ctx.font = font(st, R * 0.2, 500);
    ctx.fillStyle = st.accent;
    ctx.fillText(m.unit, cx, cy + px * 0.3 + R * 0.26);
  }
  if (st.label) {
    ctx.font = font(st, R * 0.17, 500);
    ctx.fillStyle = st.color;
    ctx.globalAlpha = st.opacity * 0.8;
    ctx.fillText(m.label.toUpperCase(), cx, Math.min(r.y + r.h - R * 0.02, cy + R * 0.92));
  }
}

function drawBar(ctx: CanvasRenderingContext2D, w: Widget, r: Rect, d: DrawData) {
  const st = w.style;
  const m = METRICS[w.metric];
  const v = valueOf(w, d);
  const { min, max } = rangeOf(w, d);
  const barH = r.h * 0.3;
  const top = r.y;
  const textPx = r.h * 0.5;
  // fila superior: etiqueta a la izquierda, valor a la derecha
  if (st.label) {
    ctx.font = font(st, textPx * 0.62, 500);
    ctx.fillStyle = st.color;
    ctx.globalAlpha = st.opacity * 0.8;
    ctx.textAlign = 'left';
    ctx.fillText(m.label.toUpperCase(), r.x, top + textPx * 0.85);
    ctx.globalAlpha = st.opacity;
  }
  const txt = (v === undefined ? '--' : m.fmt(v)) + (st.unit && m.unit ? ' ' + m.unit : '');
  ctx.font = font(st, textPx);
  ctx.fillStyle = st.color;
  ctx.textAlign = 'right';
  ctx.fillText(txt, r.x + r.w, top + textPx * 0.9);
  // barra
  const by = r.y + r.h - barH;
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  roundRect(ctx, r.x, by, r.w, barH, barH / 2); ctx.fill();
  if (v !== undefined) {
    ctx.fillStyle = st.accent;
    const fz = min < 0 && max > 0 ? -min / (max - min) : 0;
    const f = Math.max(0, Math.min(1, (v - min) / (max - min || 1)));
    const x0 = r.x + r.w * Math.min(fz, f), x1 = r.x + r.w * Math.max(fz, f);
    roundRect(ctx, x0, by, Math.max(barH, x1 - x0), barH, barH / 2); ctx.fill();
    if (fz > 0) {
      ctx.fillStyle = st.color;
      ctx.fillRect(r.x + r.w * fz - 1, by - barH * 0.25, 2, barH * 1.5);
    }
  }
}

function drawGraph(ctx: CanvasRenderingContext2D, w: Widget, r: Rect, d: DrawData) {
  const st = w.style;
  const m = METRICS[w.metric];
  const labelPx = r.h * 0.2;
  const v = valueOf(w, d);
  ctx.textAlign = 'left';
  ctx.font = font(st, labelPx, 500);
  ctx.fillStyle = st.color;
  ctx.fillText((st.label ? m.label.toUpperCase() + '  ' : '') + (v === undefined ? '--' : m.fmt(v)) + (st.unit ? ' ' + m.unit : ''), r.x, r.y + labelPx * 0.95);
  if (!d.tel || d.t == null) return;
  const N = 60;
  const win = Math.max(5, st.window) * 1000;
  const vals: (number | undefined)[] = [];
  for (let i = 0; i <= N; i++) {
    const p = sampleAt(d.tel, d.t - win + (win * i) / N);
    vals.push(p ? METRICS[w.metric].get(p) : undefined);
  }
  const defined = vals.filter((x): x is number => x !== undefined);
  if (defined.length < 2) return;
  let lo = Math.min(...defined), hi = Math.max(...defined);
  const rg = rangeOf(w, d);
  const minSpan = (rg.max - rg.min) * 0.15;
  if (hi - lo < minSpan) { const c = (hi + lo) / 2; lo = c - minSpan / 2; hi = c + minSpan / 2; }
  const gy = r.y + labelPx * 1.3, gh = r.h - labelPx * 1.3;
  const X = (i: number) => r.x + (r.w * i) / N;
  const Y = (val: number) => gy + gh - ((val - lo) / (hi - lo || 1)) * gh * 0.92;
  ctx.shadowColor = 'transparent';
  ctx.beginPath();
  let started = false, lastX = r.x;
  vals.forEach((val, i) => {
    if (val === undefined) return;
    if (!started) { ctx.moveTo(X(i), Y(val)); started = true; } else ctx.lineTo(X(i), Y(val));
    lastX = X(i);
  });
  ctx.strokeStyle = st.accent;
  ctx.lineWidth = Math.max(1.5, r.h * 0.025);
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.lineTo(lastX, gy + gh);
  const firstI = vals.findIndex((x) => x !== undefined);
  ctx.lineTo(X(firstI), gy + gh);
  ctx.closePath();
  ctx.globalAlpha = st.opacity * 0.25;
  ctx.fillStyle = st.accent;
  ctx.fill();
  ctx.globalAlpha = st.opacity;
}

function drawElevation(ctx: CanvasRenderingContext2D, w: Widget, r: Rect, d: DrawData) {
  const st = w.style;
  if (!d.tel) return;
  const g = routeGeo(d.tel);
  if (!g || g.prof.d.length < 2) return;
  const { d: D, a: A, dMax, aMin, aMax } = g.prof;
  const labelPx = st.label ? r.h * 0.2 : 0;
  const v = d.p?.alt;
  if (st.label) {
    ctx.textAlign = 'left';
    ctx.font = font(st, labelPx, 500);
    ctx.fillStyle = st.color;
    const gr = d.p?.grade;
    ctx.fillText(
      `ALTITUD ${v !== undefined ? Math.round(v) + ' m' : '--'}` + (gr !== undefined ? `   ${METRICS.grade.fmt(gr)} %` : ''),
      r.x, r.y + labelPx * 0.95
    );
  }
  const gy = r.y + labelPx * 1.25, gh = r.h - labelPx * 1.25;
  const span = Math.max(aMax - aMin, 30);
  const X = (dist: number) => r.x + (dist / (dMax || 1)) * r.w;
  const Y = (alt: number) => gy + gh - ((alt - aMin) / span) * gh * 0.9;
  const curD = d.p?.dist ?? -1;
  ctx.shadowColor = 'transparent';
  const fillTo = (until: number, color: string, alpha: number) => {
    ctx.beginPath();
    ctx.moveTo(X(D[0]), gy + gh);
    let lastX = X(D[0]);
    for (let i = 0; i < D.length && D[i] <= until; i++) { ctx.lineTo(X(D[i]), Y(A[i])); lastX = X(D[i]); }
    ctx.lineTo(lastX, gy + gh);
    ctx.closePath();
    ctx.globalAlpha = st.opacity * alpha;
    ctx.fillStyle = color;
    ctx.fill();
  };
  fillTo(Infinity, '#ffffff', 0.28);
  if (curD >= 0) fillTo(curD, st.accent, 0.85);
  ctx.globalAlpha = st.opacity;
  // línea superior
  ctx.beginPath();
  for (let i = 0; i < D.length; i++) (i ? ctx.lineTo(X(D[i]), Y(A[i])) : ctx.moveTo(X(D[i]), Y(A[i])));
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = Math.max(1, r.h * 0.015);
  ctx.stroke();
  if (curD >= 0 && v !== undefined) {
    const px = X(curD), py = Y(v);
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(px, py, Math.max(3, r.h * 0.05), 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = st.accent;
    ctx.beginPath(); ctx.arc(px, py, Math.max(2, r.h * 0.032), 0, Math.PI * 2); ctx.fill();
  }
}

const mapPathCache = new WeakMap<RouteGeo, Map<string, { full: Path2D }>>();

function drawMap(ctx: CanvasRenderingContext2D, w: Widget, r: Rect, d: DrawData) {
  const st = w.style;
  if (!d.tel) return;
  const g = routeGeo(d.tel);
  if (!g) return;
  // encaja el recorrido en el recuadro manteniendo proporciones
  const sx = g.aspect >= 1 ? 1 : g.aspect, sy = g.aspect >= 1 ? 1 / g.aspect : 1;
  const s = Math.min(r.w / sx, r.h / sy) * 0.92;
  const ox = r.x + (r.w - s * sx) / 2, oy = r.y + (r.h - s * sy) / 2;
  const X = (i: number) => ox + g.x[i] * s, Y = (i: number) => oy + g.y[i] * s;
  const key = `${r.w.toFixed(0)}x${r.h.toFixed(0)}@${ox.toFixed(1)},${oy.toFixed(1)}`;
  let cache = mapPathCache.get(g);
  if (!cache) { cache = new Map(); mapPathCache.set(g, cache); }
  let entry = cache.get(key);
  if (!entry) {
    const full = new Path2D();
    for (let i = 0; i < g.x.length; i++) (i ? full.lineTo(X(i), Y(i)) : full.moveTo(X(i), Y(i)));
    entry = { full };
    if (cache.size > 20) cache.clear();
    cache.set(key, entry);
  }
  const lw = Math.max(1.5, Math.min(r.w, r.h) * 0.022);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = lw * 2.2;
  ctx.stroke(entry.full);
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = lw;
  ctx.stroke(entry.full);
  if (d.t == null) return;
  // tramo recorrido
  let lo = 0, hi = g.t.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (g.t[mid] <= d.t) lo = mid; else hi = mid; }
  ctx.beginPath();
  for (let i = 0; i <= lo; i++) (i ? ctx.lineTo(X(i), Y(i)) : ctx.moveTo(X(i), Y(i)));
  ctx.strokeStyle = st.accent;
  ctx.lineWidth = lw * 1.1;
  ctx.stroke();
  // posición
  let px = X(lo), py = Y(lo);
  if (d.p && d.p.lat !== undefined && hi > lo) {
    const f = Math.max(0, Math.min(1, (d.t - g.t[lo]) / (g.t[hi] - g.t[lo] || 1)));
    px = X(lo) + (X(hi) - X(lo)) * f;
    py = Y(lo) + (Y(hi) - Y(lo)) * f;
  }
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(px, py, lw * 2.4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = st.accent;
  ctx.beginPath(); ctx.arc(px, py, lw * 1.5, 0, Math.PI * 2); ctx.fill();
}

// ---------------------------------------------------------------- atlas para exportar
export interface AtlasItem { id: string; ax: number; ay: number; w: number; h: number; X: number; Y: number }
export interface Atlas { W: number; H: number; items: AtlasItem[] }

/**
 * Para exportar, cada widget se dibuja a resolución completa en una tira vertical (atlas):
 * así a FFmpeg solo le llegan los píxeles de los widgets, no fotogramas 4K enteros vacíos.
 */
export function buildAtlas(widgets: Widget[], W: number, H: number): Atlas {
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  const raw: AtlasItem[] = [];
  for (const w of widgets) {
    const X = Math.max(0, Math.round((w.x * W) / 2) * 2), Y = Math.max(0, Math.round((w.y * H) / 2) * 2);
    const pw = Math.min(even(w.w * W), W - X), ph = Math.min(even(w.h * H), H - Y);
    if (pw < 2 || ph < 2) continue;
    raw.push({ id: w.id, ax: 0, ay: 0, w: pw - (pw % 2), h: ph - (ph % 2), X, Y });
  }
  if (!raw.length) return { W: 2, H: 2, items: [] };
  // empaquetado por filas: los más altos primero, filas de como mucho ~2048 px de ancho
  const limit = Math.max(2048, ...raw.map((r) => r.w));
  const sorted = [...raw].sort((a, b) => b.h - a.h);
  let x = 0, y = 0, rowH = 0, maxW = 0;
  for (const it of sorted) {
    if (x + it.w > limit) { y += rowH; x = 0; rowH = 0; }
    it.ax = x; it.ay = y;
    x += it.w; rowH = Math.max(rowH, it.h); maxW = Math.max(maxW, x);
  }
  // se mantiene el orden original (el de dibujo) para superponer en FFmpeg
  return { W: even(maxW), H: even(y + rowH), items: raw };
}

export function drawAtlas(ctx: CanvasRenderingContext2D, atlas: Atlas, widgets: Widget[], d: DrawData) {
  ctx.clearRect(0, 0, atlas.W, atlas.H);
  for (const it of atlas.items) {
    const w = widgets.find((x) => x.id === it.id);
    if (w) drawWidget(ctx, w, { x: it.ax, y: it.ay, w: it.w, h: it.h }, d);
  }
}

/** Rectángulo que ocupa la imagen dentro de un recuadro (como object-fit: contain). */
export function containRect(boxW: number, boxH: number, aspect: number): Rect {
  let w = boxW, h = boxW / aspect;
  if (h > boxH) { h = boxH; w = boxH * aspect; }
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}
