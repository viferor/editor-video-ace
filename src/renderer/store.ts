import type { Clip, Encoders, MusicSettings, ProjectFile, Segment, Song, Telemetry, TransitionSettings } from './types';
import { parseFit, parseGpx } from './telemetry';
import { builtinTemplates, cloneWidgets, type Widget } from './overlay';
import { basename, toast, uid } from './util';

type Listener = (what: string) => void;
type SyncSnap = { g: number; end: boolean; clips: Record<string, number | null> };

class Store {
  clips: Clip[] = [];
  timeline: Segment[] = [];
  telemetry: Telemetry | null = null;
  telemetryPath: string | null = null;
  globalOffsetMs = 0;
  /** true si la cámara guarda la hora del FINAL de la grabación en lugar del inicio. */
  stampIsEnd = false;
  /** true = sincronización dada por buena: el clic en el mapa navega en vez de ajustar. */
  syncLocked = false;
  /** Ya se ha sincronizado algún clip a mano en el mapa (a partir de ahí se pregunta a qué clips aplicar). */
  mapSynced = false;
  /** Widgets de datos sobre el vídeo. */
  overlay: Widget[] = cloneWidgets(builtinTemplates()[0].widgets);
  overlayEnabled = true;
  /** Lista de canciones (con su ritmo analizado). Suenan seguidas las que estén marcadas. */
  songs: Song[] = [];
  musicSettings: MusicSettings = { volume: 1, origVolume: 0.2, fadeOut: 3 };
  transitions: TransitionSettings = { type: 'none', duration: 0.5, fadeEnds: false };
  projectPath: string | null = null;
  dirty = false;
  encoders: Encoders | null = null;
  private listeners = new Set<Listener>();
  private syncUndo: SyncSnap[] = [];
  private syncRedo: SyncSnap[] = [];
  private lastPush = { key: '', at: 0 };

  // ---------------------------------------------------------------- deshacer sincronización
  private snapSync(): SyncSnap {
    const clips: Record<string, number | null> = {};
    for (const c of this.clips) clips[c.id] = c.offsetMs;
    return { g: this.globalOffsetMs, end: this.stampIsEnd, clips };
  }
  private restoreSync(s: SyncSnap) {
    this.globalOffsetMs = s.g;
    this.stampIsEnd = s.end;
    for (const c of this.clips) c.offsetMs = c.id in s.clips ? s.clips[c.id] : null;
  }
  /**
   * Guarda el estado de sincronización antes de cambiarlo. Los toques seguidos con la misma
   * clave (p. ej. varios clics en +0,1 s) se agrupan en un solo paso de deshacer.
   */
  pushSync(key = '') {
    const now = Date.now();
    if (key && this.lastPush.key === key && now - this.lastPush.at < 1200) {
      this.lastPush.at = now;
      return;
    }
    this.lastPush = { key, at: now };
    this.syncUndo.push(this.snapSync());
    if (this.syncUndo.length > 200) this.syncUndo.shift();
    this.syncRedo = [];
  }
  setSyncLocked(v: boolean) {
    this.syncLocked = v;
    this.emit('lock');
  }
  get canUndoSync() { return this.syncUndo.length > 0; }
  get canRedoSync() { return this.syncRedo.length > 0; }
  undoSync() {
    const s = this.syncUndo.pop();
    if (!s) return false;
    this.syncRedo.push(this.snapSync());
    this.restoreSync(s);
    this.lastPush = { key: '', at: 0 };
    this.emit('sync');
    return true;
  }
  redoSync() {
    const s = this.syncRedo.pop();
    if (!s) return false;
    this.syncUndo.push(this.snapSync());
    this.restoreSync(s);
    this.lastPush = { key: '', at: 0 };
    this.emit('sync');
    return true;
  }
  /** Quita toda la sincronización: vuelve a la hora tal cual la guarda la cámara. */
  clearSync() {
    this.pushSync();
    this.globalOffsetMs = 0;
    this.stampIsEnd = false;
    for (const c of this.clips) c.offsetMs = null;
    this.mapSynced = false;
    this.emit('sync');
  }
  private clearSyncHistory() {
    this.syncUndo = [];
    this.syncRedo = [];
    this.lastPush = { key: '', at: 0 };
  }

  on(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  // ---------------------------------------------------------------- deshacer en la línea de tiempo
  private tlSnap = '[]';
  private tlUndo: string[] = [];
  private tlRedo: string[] = [];
  private trackTimeline() {
    const now = JSON.stringify(this.timeline);
    if (now === this.tlSnap) return;
    this.tlUndo.push(this.tlSnap);
    if (this.tlUndo.length > 100) this.tlUndo.shift();
    this.tlRedo = [];
    this.tlSnap = now;
  }
  resetTimelineHistory() {
    this.tlSnap = JSON.stringify(this.timeline);
    this.tlUndo = [];
    this.tlRedo = [];
  }
  get canUndoTimeline() { return this.tlUndo.length > 0; }
  get canRedoTimeline() { return this.tlRedo.length > 0; }
  undoTimeline() {
    const prev = this.tlUndo.pop();
    if (prev == null) return false;
    this.tlRedo.push(this.tlSnap);
    this.tlSnap = prev;
    this.timeline = JSON.parse(prev);
    this.emit('timeline', true, false);
    return true;
  }
  redoTimeline() {
    const next = this.tlRedo.pop();
    if (next == null) return false;
    this.tlUndo.push(this.tlSnap);
    this.tlSnap = next;
    this.timeline = JSON.parse(next);
    this.emit('timeline', true, false);
    return true;
  }

  emit(what: string, markDirty = true, track = true) {
    if (what === 'timeline' && track) this.trackTimeline();
    if (markDirty) {
      this.dirty = true;
      this.scheduleAutosave();
    }
    for (const l of this.listeners) l(what);
  }

  // ---------------------------------------------------------------- guardado automático
  /** Momento del último guardado automático (ms) o null. */
  lastAutosave: number | null = null;
  /** false en la tablet: allí no se guarda nada (lo guarda el PC). */
  autosave = true;
  /** true si la sesión actual se recuperó del cierre anterior sin haberse guardado como proyecto. */
  recovered = false;
  private autosaveTimer: number | null = null;

  private scheduleAutosave() {
    if (this.autosaveTimer != null) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => { this.autosaveTimer = null; this.flushAutosave(); }, 1500);
  }

  /**
   * Guarda ya: en el propio proyecto si tiene archivo; si no, en la sesión de recuperación,
   * para que nada se pierda al cerrar la app.
   */
  async flushAutosave() {
    if (this.autosaveTimer != null) { clearTimeout(this.autosaveTimer); this.autosaveTimer = null; }
    if (!this.autosave) return;
    if (!this.clips.length && !this.telemetry) return;
    try {
      const json = JSON.stringify(this.serialize(), null, 1);
      if (this.projectPath) {
        if (!this.dirty) return;
        await window.api.writeText(this.projectPath, json);
        this.dirty = false;
      } else {
        await window.api.writeText(await window.api.recoveryPath(), json);
      }
      this.lastAutosave = Date.now();
      this.emit('saved', false);
    } catch (e) {
      console.warn('Guardado automático falló', e);
    }
  }

  clip(id: string) {
    return this.clips.find((c) => c.id === id);
  }

  offsetOf(c: Clip) {
    return c.offsetMs ?? this.globalOffsetMs;
  }

  cameraStart(c: Clip): number | null {
    if (c.cameraStamp == null) return null;
    return c.cameraStamp - (this.stampIsEnd ? c.probe.duration * 1000 : 0);
  }

  /** Instante de la telemetría (ms UTC) que corresponde al segundo t del clip. */
  teleTime(c: Clip, t: number): number | null {
    const s = this.cameraStart(c);
    return s == null ? null : s + this.offsetOf(c) + t * 1000;
  }

  /** Qué clip y qué segundo del clip se ve en el instante T de la línea de tiempo. */
  locate(T: number): { idx: number; seg: Segment; clip: Clip; clipTime: number; segStart: number } | null {
    let acc = 0;
    for (let i = 0; i < this.timeline.length; i++) {
      const seg = this.timeline[i];
      const d = seg.out - seg.in;
      if (T < acc + d - 1e-6 || i === this.timeline.length - 1) {
        const clip = this.clip(seg.clipId);
        if (!clip) return null;
        const local = Math.max(0, Math.min(d, T - acc));
        return { idx: i, seg, clip, clipTime: seg.in + local, segStart: acc };
      }
      acc += d;
    }
    return null;
  }

  // ---------------------------------------------------------------- música
  activeSongs() {
    return this.songs.filter((s) => s.enabled && s.end - s.start > 0.5);
  }
  /** Duración de toda la música marcada, una canción detrás de otra. */
  musicLength() {
    return this.activeSongs().reduce((a, s) => a + (s.end - s.start), 0);
  }
  /** Qué canción suena en el instante T del vídeo, y en qué segundo de esa canción. */
  songAt(T: number): { song: Song; songTime: number; offset: number } | null {
    let off = 0;
    for (const s of this.activeSongs()) {
      const len = s.end - s.start;
      if (T < off + len) return { song: s, songTime: s.start + Math.max(0, T - off), offset: off };
      off += len;
    }
    return null;
  }
  /** Pulsos de toda la música colocados en el tiempo del vídeo (s desde el inicio). */
  musicBeats(): { t: number; bar: boolean; songStart: boolean }[] {
    const out: { t: number; bar: boolean; songStart: boolean }[] = [];
    let off = 0;
    for (const s of this.activeSongs()) {
      const len = s.end - s.start;
      out.push({ t: off, bar: true, songStart: true });
      s.beats.forEach((b, i) => {
        const t = b - s.start;
        if (t > 0.05 && t < len) out.push({ t: off + t, bar: (i - s.barPhase) % 4 === 0, songStart: false });
      });
      off += len;
    }
    return out;
  }
  /** Añade canciones a la lista (analizando su ritmo). Devuelve las añadidas. */
  async addSongs(paths: string[], onProgress?: (msg: string) => void): Promise<Song[]> {
    const added: Song[] = [];
    for (let k = 0; k < paths.length; k++) {
      const p = paths[k];
      if (this.songs.some((s) => s.path.toLowerCase() === p.toLowerCase())) continue;
      onProgress?.(`Analizando el ritmo (${k + 1} de ${paths.length}): ${basename(p)}`);
      try {
        const a = await window.api.analyzeMusic(p);
        const first = a.beats[a.barPhase] ?? a.beats[0] ?? 0;
        const song: Song = { id: uid(), path: p, name: basename(p), ...a, start: +Math.max(0, first).toFixed(2), end: a.duration, enabled: true };
        this.songs.push(song);
        added.push(song);
      } catch (e) {
        toast(`No se pudo leer ${basename(p)}: ${(e as Error).message}`, 'error', 6000);
      }
    }
    if (added.length) this.emit('music');
    return added;
  }

  timelineDuration() {
    return this.timeline.reduce((a, s) => a + (s.out - s.in), 0);
  }

  // ---------------------------------------------------------------- clips
  async addClips(paths: string[]) {
    const hadClips = this.clips.length > 0;
    const existing = new Set(this.clips.map((c) => c.path.toLowerCase()));
    const added: Clip[] = [];
    for (const p of paths) {
      if (existing.has(p.toLowerCase())) continue;
      try {
        const probe = await window.api.probe(p);
        const c: Clip = {
          id: uid(),
          path: p,
          name: basename(p),
          probe,
          cameraStamp: parseCameraStamp(probe.creationTime, basename(p)),
          offsetMs: null,
          proxy: null,
          proxyPct: 0
        };
        added.push(c);
      } catch (e) {
        toast(`No se pudo abrir ${basename(p)}: ${(e as Error).message}`, 'error');
      }
    }
    added.sort((a, b) => (a.cameraStamp ?? 0) - (b.cameraStamp ?? 0) || a.name.localeCompare(b.name));
    this.clips.push(...added);
    this.clips.sort((a, b) => (a.cameraStamp ?? 0) - (b.cameraStamp ?? 0) || a.name.localeCompare(b.name));
    this.emit('clips');
    for (const c of added) proxyQueue.push(c);
    runProxyQueue();
    if (added.length && this.telemetry && !hadClips) this.autoSync(true);
    return added;
  }

  clipByPath(p: string) {
    return this.clips.find((c) => c.path.toLowerCase() === p.toLowerCase());
  }

  removeClip(id: string) {
    this.clips = this.clips.filter((c) => c.id !== id);
    this.timeline = this.timeline.filter((s) => s.clipId !== id);
    this.emit('clips');
    this.emit('timeline');
  }

  // ---------------------------------------------------------------- telemetría
  async loadTelemetry(path: string) {
    const name = basename(path);
    let tel: Telemetry;
    if (/\.fit$/i.test(path)) tel = parseFit(await window.api.readFile(path), name);
    else tel = parseGpx(await window.api.readText(path), name);
    this.telemetry = tel;
    this.telemetryPath = path;
    this.emit('telemetry');
    return tel;
  }

  /**
   * Sincronización automática: prueba si la cámara guarda hora local o UTC y si la marca es
   * de inicio o de fin, y se queda con la combinación que mejor encaja con la actividad.
   */
  autoSync(quiet = false): string {
    const tel = this.telemetry;
    if (!tel) return 'Primero carga una actividad FIT o GPX.';
    const clips = this.clips.filter((c) => c.cameraStamp != null);
    if (!clips.length) return 'Los clips no tienen hora de grabación; sincroniza en el mapa.';
    this.pushSync();
    const offsets = new Set<number>([0]);
    if (tel.tzOffsetMin != null) offsets.add(-tel.tzOffsetMin * 60000);
    else for (let h = -14; h <= 14; h++) offsets.add(h * 3600000);
    let best = { score: -1, off: 0, end: false };
    for (const end of [false, true]) {
      for (const off of offsets) {
        let score = 0;
        for (const c of clips) {
          const s = c.cameraStamp! - (end ? c.probe.duration * 1000 : 0) + off;
          const e = s + c.probe.duration * 1000;
          score += Math.max(0, Math.min(e, tel.end) - Math.max(s, tel.start));
        }
        const better =
          score > best.score + 1000 ||
          (Math.abs(score - best.score) <= 1000 && (Math.abs(off) < Math.abs(best.off) || (off === best.off && !end && best.end)));
        if (better) best = { score, off, end };
      }
    }
    for (const c of this.clips) c.offsetMs = null;
    let msg: string;
    if (best.score <= 0) {
      this.stampIsEnd = false;
      const first = clips[0];
      this.globalOffsetMs = tel.start - first.cameraStamp!;
      msg = 'Ningún clip coincide con el horario de la actividad. He colocado el primer clip al inicio de la ruta: ajústalo en el mapa.';
    } else {
      this.stampIsEnd = best.end;
      this.globalOffsetMs = best.off;
      const h = -best.off / 3600000;
      msg =
        best.off === 0
          ? 'Sincronizado: la cámara y la actividad usan la misma referencia horaria.'
          : `Sincronizado: la cámara guarda la hora local (UTC${h >= 0 ? '+' : ''}${h}).`;
      if (best.end) msg += ' La cámara marca la hora al final de cada clip.';
      msg += ' Afina con el mapa si hace falta.';
    }
    this.emit('sync');
    if (!quiet) toast(msg, best.score > 0 ? 'ok' : 'info', 7000);
    return msg;
  }

  // ---------------------------------------------------------------- línea de tiempo
  addToTimeline(clipId: string, index = this.timeline.length) {
    const c = this.clip(clipId);
    if (!c) return;
    this.timeline.splice(index, 0, { id: uid(), clipId, in: 0, out: c.probe.duration });
    this.emit('timeline');
  }

  // ---------------------------------------------------------------- proyecto
  serialize(): ProjectFile {
    return {
      app: 'editor-video-ace',
      version: 1,
      clips: this.clips.map((c) => ({ id: c.id, path: c.path, cameraStamp: c.cameraStamp, offsetMs: c.offsetMs })),
      telemetryPath: this.telemetryPath,
      globalOffsetMs: this.globalOffsetMs,
      stampIsEnd: this.stampIsEnd,
      syncLocked: this.syncLocked,
      mapSynced: this.mapSynced,
      overlay: this.overlay,
      overlayEnabled: this.overlayEnabled,
      songs: this.songs.map((s) => ({ id: s.id, path: s.path, name: s.name, start: s.start, end: s.end, enabled: s.enabled })),
      musicSettings: this.musicSettings,
      transitions: this.transitions,
      timeline: this.timeline
    };
  }

  reset() {
    this.clips = [];
    this.timeline = [];
    this.telemetry = null;
    this.telemetryPath = null;
    this.globalOffsetMs = 0;
    this.stampIsEnd = false;
    this.syncLocked = false;
    this.mapSynced = false;
    this.overlay = cloneWidgets(builtinTemplates()[0].widgets);
    this.overlayEnabled = true;
    this.songs = [];
    this.musicSettings = { volume: 1, origVolume: 0.2, fadeOut: 3 };
    this.transitions = { type: 'none', duration: 0.5, fadeEnds: false };
    this.projectPath = null;
    this.recovered = false;
    this.lastAutosave = null;
    rememberProject(null);
    proxyQueue.length = 0;
    this.clearSyncHistory();
    this.resetTimelineHistory();
    this.emit('all', false);
    this.dirty = false;
  }

  async load(path: string, opts: { recovered?: boolean } = {}) {
    const data = JSON.parse(await window.api.readText(path)) as ProjectFile;
    if (data.app !== 'editor-video-ace') throw new Error('No es un proyecto de Editor Video Ace');
    // ¿falta algún archivo? (p. ej. el proyecto se abre en otro ordenador): ofrecer buscarlos
    const relinked = opts.recovered ? false : await relinkMissing(data);
    this.reset();
    const missing: string[] = [];
    for (const sc of data.clips) {
      try {
        const probe = await window.api.probe(sc.path);
        this.clips.push({
          id: sc.id, path: sc.path, name: basename(sc.path), probe,
          cameraStamp: sc.cameraStamp, offsetMs: sc.offsetMs, proxy: null, proxyPct: 0
        });
      } catch {
        missing.push(basename(sc.path));
      }
    }
    const ids = new Set(this.clips.map((c) => c.id));
    this.timeline = data.timeline.filter((s) => ids.has(s.clipId));
    this.globalOffsetMs = data.globalOffsetMs;
    this.stampIsEnd = data.stampIsEnd;
    this.syncLocked = data.syncLocked ?? false;
    this.mapSynced = data.mapSynced ?? this.syncLocked;
    if (data.overlay) this.overlay = data.overlay;
    this.overlayEnabled = data.overlayEnabled ?? true;
    // música: lista de canciones (o el formato antiguo de una sola)
    const saved = data.songs ?? (data.music ? [{ id: uid(), path: data.music.path, name: data.music.name, start: data.music.start, end: Infinity, enabled: true }] : []);
    if (data.transitions) this.transitions = data.transitions;
    if (data.musicSettings) this.musicSettings = data.musicSettings;
    else if (data.music) this.musicSettings = { volume: data.music.volume, origVolume: data.music.origVolume, fadeOut: data.music.fadeOut };
    for (const sv of saved) {
      try {
        const a = await window.api.analyzeMusic(sv.path);
        this.songs.push({ ...a, ...sv, end: Math.min(sv.end ?? a.duration, a.duration) });
      } catch {
        missing.push(basename(sv.path));
      }
    }
    if (data.telemetryPath) {
      try {
        await this.loadTelemetry(data.telemetryPath);
      } catch {
        missing.push(basename(data.telemetryPath));
      }
    }
    this.projectPath = opts.recovered ? null : path;
    this.recovered = !!opts.recovered;
    if (!opts.recovered) rememberProject(path);
    this.clearSyncHistory();
    this.resetTimelineHistory();
    for (const c of this.clips) proxyQueue.push(c);
    runProxyQueue();
    this.emit('all', false);
    this.dirty = false;
    if (missing.length) toast('No se encontraron: ' + missing.join(', '), 'error', 9000);
    if (relinked && this.projectPath) {
      // guardar las rutas nuevas en el proyecto
      this.dirty = true;
      await this.flushAutosave();
      toast('Rutas actualizadas en el proyecto', 'ok', 3000);
    }
  }

  /** Guarda en una ruta concreta (sin preguntar). */
  async saveTo(p: string, notify = true) {
    await window.api.writeText(p, JSON.stringify(this.serialize(), null, 1));
    this.projectPath = p;
    this.recovered = false;
    this.dirty = false;
    this.lastAutosave = Date.now();
    rememberProject(p);
    this.emit('saved', false);
    if (notify) toast('Proyecto guardado', 'ok', 2500);
  }

  async save(saveAs = false) {
    let p = this.projectPath;
    if (!p || saveAs) {
      const suggested = this.projectPath
        ? this.projectPath.replace(/\.evproj$/i, '') + ' (copia).evproj'
        : this.telemetry ? this.telemetry.name.replace(/\.\w+$/, '') + '.evproj' : 'proyecto.evproj';
      p = await window.api.saveProjectDialog(suggested);
      if (!p) return false;
    }
    await window.api.writeText(p, JSON.stringify(this.serialize(), null, 1));
    this.projectPath = p;
    this.recovered = false;
    this.dirty = false;
    this.lastAutosave = Date.now();
    rememberProject(p);
    this.emit('saved', false);
    toast(saveAs ? `Guardado como ${basename(p)}. Ahora trabajas en esta copia.` : 'Proyecto guardado. A partir de ahora se guarda solo con cada cambio.', 'ok', 4000);
    return true;
  }
}

/**
 * Si faltan vídeos, canciones o el FIT, pregunta en qué carpeta buscarlos y los localiza por su nombre.
 * Cambia las rutas en `data`. Devuelve true si se cambió alguna.
 */
async function relinkMissing(data: ProjectFile): Promise<boolean> {
  const refs: { get: () => string; set: (p: string) => void }[] = [];
  for (const c of data.clips) refs.push({ get: () => c.path, set: (p) => (c.path = p) });
  for (const s of data.songs ?? []) refs.push({ get: () => s.path, set: (p) => (s.path = p) });
  if (data.music) { const m = data.music; refs.push({ get: () => m.path, set: (p) => (m.path = p) }); }
  if (data.telemetryPath) refs.push({ get: () => data.telemetryPath!, set: (p) => (data.telemetryPath = p) });
  let changed = false;
  for (let round = 0; round < 5; round++) {
    const missing: typeof refs = [];
    for (const r of refs) if (!(await window.api.exists(r.get()))) missing.push(r);
    if (!missing.length) return changed;
    const names = missing.map((r) => basename(r.get()));
    const list = names.slice(0, 6).join('\n') + (names.length > 6 ? `\n… y ${names.length - 6} más` : '');
    const ans = await window.api.confirm(
      `No se encuentran ${missing.length} ${missing.length === 1 ? 'archivo' : 'archivos'} del proyecto (¿lo abres en otro ordenador o los has movido?):\n\n${list}\n\n¿Buscarlos en una carpeta?`,
      ['Buscar en una carpeta…', 'Abrir sin ellos']
    );
    if (ans !== 0) return changed;
    const dir = await window.api.openFolder('¿Dónde están los vídeos, las canciones o el FIT?');
    if (!dir) return changed;
    const found = await window.api.findFiles(dir, names);
    let n = 0;
    for (const r of missing) {
      const hit = found[basename(r.get())];
      if (hit) { r.set(hit); n++; changed = true; }
    }
    toast(n ? `Encontrados ${n} de ${missing.length}` : 'No se encontró ninguno en esa carpeta', n ? 'ok' : 'error', 4000);
  }
  return changed;
}

// Último proyecto abierto, para reabrirlo solo al arrancar
const LAST_KEY = 'ultimoProyecto';
const RECENT_KEY = 'proyectosRecientes';
function rememberProject(p: string | null) {
  try {
    if (p) {
      localStorage.setItem(LAST_KEY, p);
      const list = recentProjects().filter((x) => x.toLowerCase() !== p.toLowerCase());
      localStorage.setItem(RECENT_KEY, JSON.stringify([p, ...list].slice(0, 8)));
    } else localStorage.removeItem(LAST_KEY);
  } catch {}
}
/** Últimos proyectos abiertos o guardados (el más reciente primero). */
export function recentProjects(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}
export function lastProjectPath(): string | null {
  try { return localStorage.getItem(LAST_KEY); } catch { return null; }
}

/** Hora de la cámara: metadato creation_time o, si falta, el nombre VID_AAAAMMDD_HHMMSS. */
export function parseCameraStamp(creation: string | null, name: string): number | null {
  if (creation) {
    const t = Date.parse(creation);
    if (isFinite(t) && new Date(t).getUTCFullYear() > 2005) return t;
  }
  const m = /(20\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(name);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return null;
}

export const store = new Store();

// ---------------------------------------------------------------- cola de proxies
const proxyQueue: Clip[] = [];
let proxyRunning = false;

window.api?.onProxyProgress(({ src, pct, eta }) => {
  const c = store.clips.find((x) => x.path === src);
  if (c) {
    c.proxyPct = pct;
    c.proxyEta = eta ?? null;
    store.emit('proxy-progress', false);
  }
});

async function runProxyQueue() {
  if (proxyRunning) return;
  proxyRunning = true;
  while (proxyQueue.length) {
    const c = proxyQueue.shift()!;
    if (!store.clips.includes(c) || c.proxy) continue;
    try {
      c.proxy = await window.api.proxy(c.path, c.probe.duration);
      c.proxyPct = 1;
      c.proxyError = undefined;
    } catch (e) {
      c.proxyError = (e as Error).message;
      toast(`Proxy de ${c.name} falló; se usará el original para la vista previa.`, 'error');
    }
    store.emit('proxy', false);
  }
  proxyRunning = false;
}

/** Pone un clip el primero de la cola de proxies (el que estás mirando). */
export function prioritizeProxy(c: Clip) {
  const i = proxyQueue.indexOf(c);
  if (i > 0) {
    proxyQueue.splice(i, 1);
    proxyQueue.unshift(c);
  }
}

/** Vuelve a intentar un proxy que falló. */
export function retryProxy(c: Clip) {
  c.proxyError = undefined;
  c.proxyPct = 0;
  if (!proxyQueue.includes(c)) proxyQueue.unshift(c);
  store.emit('proxy', false);
  runProxyQueue();
}

/** Estado de la vista previa de un clip, para mostrarlo en pantalla. */
export function previewState(c: Clip): { kind: 'proxy' | 'building' | 'failed' | 'queued'; pct: number } {
  if (c.proxy) return { kind: 'proxy', pct: 1 };
  if (c.proxyError) return { kind: 'failed', pct: 0 };
  return { kind: c.proxyPct > 0 ? 'building' : 'queued', pct: c.proxyPct };
}

/** URL para previsualizar: el proxy si existe, si no el original. */
export function previewUrl(c: Clip) {
  return window.api.mediaUrl(c.proxy ?? c.path);
}
