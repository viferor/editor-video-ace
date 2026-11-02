// En la tablet no hay acceso a los archivos del PC: esta "API" habla con el editor del PC por la red.
import type { Api } from './types';
import { pickFiles } from './tabletFiles';
import { toast } from './util';

const qs = new URLSearchParams(location.search);
export const KEY = qs.get('k') || (() => { try { return localStorage.getItem('claveTablet') || ''; } catch { return ''; } })();
try { if (KEY) localStorage.setItem('claveTablet', KEY); } catch {}

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(`${url}?k=${encodeURIComponent(KEY)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Error ${r.status}`);
  return r.json();
}

const notHere = async () => { throw new Error('No disponible en la tablet'); };
const nothing = () => {};

const api: Partial<Api> = {
  isTablet: true,
  mediaUrl: (p: string) => `/media?k=${encodeURIComponent(KEY)}&p=${encodeURIComponent(p)}`,
  readFile: async (p: string) => new Uint8Array(await (await fetch(`/media?k=${encodeURIComponent(KEY)}&p=${encodeURIComponent(p)}`)).arrayBuffer()),
  readText: async (p: string) => (await fetch(`/media?k=${encodeURIComponent(KEY)}&p=${encodeURIComponent(p)}`)).text(),
  analyze: (p: string, durationSec: number) => post('/api/analyze', { path: p, duration: durationSec }),
  analyzeMusic: (p: string) => post('/api/analyzeMusic', { path: p }),
  audioLevels: (p: string) => post('/api/audioLevels', { path: p }),
  confirm: async (message: string, buttons: string[]) => (window.confirm(message) ? 0 : buttons.length - 1),
  // en la tablet: se eligen (o suben) y las analiza y añade el PC; la lista llega luego con el estado
  openMusic: async () => {
    const paths = await pickFiles({ kind: 'music', title: '🎵 Añadir canciones', multi: true });
    if (!paths || !paths.length) return [];
    const t = toast('El PC está analizando el ritmo…', 'info', 600000);
    try {
      const wait = nextState();
      await command({ cmd: 'addSongs', paths });
      await wait;
    } finally { t.remove(); }
    return paths;
  },
  writeText: async () => true,
  exists: async () => true,
  recoveryPath: async () => '',
  onProxyProgress: nothing,
  onExportProgress: nothing,
  onBeforeClose: nothing,
  onTabletApply: nothing,
  onTabletExport: nothing,
  tabletPush: nothing,
  onTabletStarted: nothing,
  onTabletTransfer: nothing,
  onTabletCommand: nothing,
  probe: notHere,
  proxy: notHere,
  encoders: notHere
};
(window as unknown as { api: Partial<Api> }).api = api;

/** Órdenes que hace el PC (archivos y proyecto). */
export async function command<T = unknown>(c: import('./types').TabletCommand): Promise<T> {
  return (await post<{ result: T }>('/api/command', c)).result;
}
/** Promesa que se cumple cuando llega el siguiente estado del PC (o a los 8 s). */
export function nextState(): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, 8000);
    window.addEventListener('tablet-state', () => { clearTimeout(t); res(); }, { once: true });
  });
}

export async function postEdits(body: unknown) { return post('/api/state', body); }
export async function postExport(body: unknown) { return post('/api/export', body); }
export async function postCancelExport() { return post('/api/export/cancel', {}); }
