export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | undefined> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k === 'text') e.textContent = String(v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector(sel) as T;

export function fmtTime(sec: number, withFrac = false): string {
  if (!isFinite(sec)) sec = 0;
  const neg = sec < 0;
  sec = Math.abs(sec);
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = Math.floor(sec % 60);
  const ff = Math.floor((sec % 1) * 10);
  const core = (hh ? `${hh}:${String(mm).padStart(2, '0')}` : `${mm}`) + `:${String(ss).padStart(2, '0')}`;
  return (neg ? '-' : '') + core + (withFrac ? `.${ff}` : '');
}

export function fmtOffset(ms: number): string {
  const sign = ms >= 0 ? '+' : '−';
  const a = Math.round(Math.abs(ms) / 100) / 10; // décimas de segundo
  const hh = Math.floor(a / 3600);
  const mm = Math.floor((a % 3600) / 60);
  const ss = (a % 60).toFixed(1);
  if (hh) return `${sign}${hh} h ${mm} min ${ss} s`;
  if (mm) return `${sign}${mm} min ${ss} s`;
  return `${sign}${ss} s`;
}

export function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const uid = () => Math.random().toString(36).slice(2, 10);

export const basename = (p: string) => p.split(/[\\/]/).pop() || p;

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function toast(msg: string, kind: 'info' | 'error' | 'ok' = 'info', ms = 4500) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts' });
    document.body.append(box);
  }
  const t = h('div', { class: `toast ${kind}` }, msg);
  box.append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
  return t;
}

export function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
