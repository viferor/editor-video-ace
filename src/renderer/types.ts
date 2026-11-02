export interface ProbeInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  fpsStr: string;
  vcodec: string;
  pixFmt?: string;
  hasAudio: boolean;
  creationTime: string | null;
  size: number;
}

export interface Clip {
  id: string;
  path: string;
  name: string;
  probe: ProbeInfo;
  /** Hora del reloj de la cámara (ms, tal como la escribe la cámara), o null si no se conoce. */
  cameraStamp: number | null;
  /** Desfase propio del clip; null = usa el desfase global. */
  offsetMs: number | null;
  proxy: string | null;
  proxyPct: number;
  proxyEta?: number | null;
  proxyError?: string;
}

export interface Segment {
  id: string;
  clipId: string;
  in: number;
  out: number;
}

export interface TPoint {
  t: number; // ms UTC
  lat?: number;
  lon?: number;
  alt?: number;
  speed?: number; // m/s
  hr?: number;
  cad?: number;
  power?: number;
  temp?: number;
  dist?: number; // m
  grade?: number; // % (calculada)
  turn?: number; // giro en grados/s (calculado)
}

export interface Telemetry {
  source: 'fit' | 'gpx';
  name: string;
  points: TPoint[];
  /** Diferencia hora local - UTC en minutos, si el archivo la indica. */
  tzOffsetMin: number | null;
  start: number;
  end: number;
}

export interface Encoders {
  h264Nvenc: boolean;
  hevcNvenc: boolean;
  ffmpeg: string;
}

export interface MusicAnalysis {
  duration: number;
  bpm: number;
  beats: number[]; // segundos
  barPhase: number; // índice del primer pulso que empieza compás
}

/** Una canción de la lista de música. */
export interface Song extends MusicAnalysis {
  id: string;
  path: string;
  name: string;
  /** Tramo de la canción que se usa (segundos): para saltarse la intro o cortar el final. */
  start: number;
  end: number;
  /** Si se usa en el vídeo (se pueden tener canciones en la lista sin usarlas). */
  enabled: boolean;
}

export interface MusicSettings {
  volume: number; // 0–1
  /** Volumen del sonido de la cámara mientras suena la música. */
  origVolume: number; // 0–1
  /** Fundido al final del vídeo (s). */
  fadeOut: number;
}

export type TransitionType = 'none' | 'fade' | 'fadeblack' | 'fadewhite' | 'dissolve' | 'slideleft' | 'wipeleft' | 'circleopen' | 'zoomin' | 'radial' | 'random';

export interface TransitionSettings {
  type: TransitionType;
  /** Duración de cada transición (s). */
  duration: number;
  /** Fundido desde negro al empezar y a negro al terminar. */
  fadeEnds: boolean;
}

export interface ExportJob {
  segments: { path: string; in: number; out: number; hasAudio: boolean; clipDur: number }[];
  transitions?: TransitionSettings | null;
  output: string;
  width: number;
  height: number;
  fps: number;
  codec: 'hevc' | 'h264';
  quality: 'high' | 'max';
  music?: { songs: { path: string; start: number; end: number }[]; volume: number; origVolume: number; fadeOut: number } | null;
  overlay?: { W: number; H: number; fps: number; items: { id: string; ax: number; ay: number; w: number; h: number; X: number; Y: number }[] } | null;
}

export interface ProjectFile {
  app: 'editor-video-ace';
  version: 1;
  clips: { id: string; path: string; cameraStamp: number | null; offsetMs: number | null }[];
  telemetryPath: string | null;
  globalOffsetMs: number;
  stampIsEnd: boolean;
  syncLocked?: boolean;
  mapSynced?: boolean;
  timeline: Segment[];
  overlay?: import('./overlay').Widget[];
  overlayEnabled?: boolean;
  songs?: Omit<Song, keyof MusicAnalysis>[];
  musicSettings?: MusicSettings;
  transitions?: TransitionSettings;
  /** Formato antiguo (una sola canción). */
  music?: { path: string; name: string; start: number; volume: number; origVolume: number; fadeOut: number } | null;
}

export interface TabletInfo { port: number; token: string; ips: string[]; urls: string[]; autoStart?: boolean; portChanged?: boolean }

/** Estado del proyecto que el PC comparte con la tablet. */
export interface TabletState {
  name: string;
  clips: { id: string; path: string; name: string; probe: ProbeInfo; cameraStamp: number | null; offsetMs: number | null; proxy: string | null; proxyPct?: number }[];
  globalOffsetMs: number;
  stampIsEnd: boolean;
  timeline: Segment[];
  overlay: import('./overlay').Widget[];
  overlayEnabled: boolean;
  songs: Song[];
  musicSettings: MusicSettings;
  transitions: TransitionSettings;
  telemetryPath: string | null;
  exportStatus: ExportStatus;
  encoders: Encoders | null;
  projectPath: string | null;
  telemetryName: string | null;
  busy: string | null;
  syncLocked: boolean;
  mapSynced?: boolean;
  offers: FileOffer[];
  /** Proyectos recientes del PC (los que existen). */
  recents?: string[];
  syncSource?: string;
}

/** Archivo que el PC ofrece para descargar en la tablet. */
export interface FileOffer { id?: string; path: string; name: string; size: number; at?: number }

/** Órdenes de la tablet que solo puede hacer el PC (archivos y proyecto). */
export type TabletCommand =
  | { cmd: 'newProject'; name: string }
  /** Proyecto nuevo con los vídeos de una carpeta del PC (y su FIT/GPX) o con unos vídeos elegidos. */
  | { cmd: 'newFrom'; name: string | null; folder?: string; videos?: string[] }
  | { cmd: 'openProject'; path: string }
  | { cmd: 'rename'; name: string }
  | { cmd: 'addClips'; paths: string[]; toTimeline?: boolean }
  | { cmd: 'removeClip'; id: string }
  | { cmd: 'loadTelemetry'; path: string }
  | { cmd: 'addSongs'; paths: string[] };

/** Cambios que manda la tablet. */
export interface TabletEdits {
  timeline?: Segment[];
  overlay?: import('./overlay').Widget[];
  overlayEnabled?: boolean;
  songs?: { id: string; enabled: boolean; start: number; end: number }[];
  musicSettings?: MusicSettings;
  transitions?: TransitionSettings;
  sync?: { globalOffsetMs: number; stampIsEnd: boolean; syncLocked: boolean; mapSynced?: boolean; clipOffsets: Record<string, number | null> };
}

export interface TabletExportOptions { res: 'source' | '3840x2160' | '2560x1440' | '1920x1080'; codec: 'hevc' | 'h264'; quality: 'high' | 'max'; overlay: boolean; music: boolean }

export interface ExportStatus { running: boolean; pct: number; eta: number | null; error: string | null; output: string | null; from: 'pc' | 'tablet' | null }

export interface Api {
  openVideos(): Promise<string[]>;
  openTelemetry(): Promise<string | null>;
  openProjectDialog(): Promise<string | null>;
  saveProjectDialog(name?: string): Promise<string | null>;
  saveExportDialog(name?: string): Promise<string | null>;
  confirm(message: string, buttons: string[]): Promise<number>;
  readFile(p: string): Promise<Uint8Array>;
  readText(p: string): Promise<string>;
  writeText(p: string, t: string): Promise<boolean>;
  exists(p: string): Promise<boolean>;
  showItem(p: string): Promise<void>;
  openFolder(title?: string): Promise<string | null>;
  findFiles(dir: string, names: string[]): Promise<Record<string, string>>;
  scanMedia(dir: string): Promise<{ videos: string[]; activities: string[] }>;
  probe(p: string): Promise<ProbeInfo>;
  proxy(p: string, durationSec: number): Promise<string>;
  encoders(): Promise<Encoders>;
  openMusic(): Promise<string[]>;
  analyzeMusic(p: string): Promise<MusicAnalysis>;
  audioLevels(p: string): Promise<{ step: number; levels: number[] } | null>;
  analyze(p: string, durationSec: number): Promise<{ motion: number[] | null; audio: number[] | null }>;
  exportStart(job: ExportJob): Promise<{ gpu: boolean }>;
  exportFinish(): Promise<{ output: string; gpu: boolean; seconds: number }>;
  exportFrame(data: Uint8Array): Promise<boolean>;
  exportFramesEnd(): Promise<boolean>;
  exportCancel(): Promise<boolean>;
  onProxyProgress(cb: (d: { src: string; pct: number; eta?: number | null }) => void): void;
  onExportProgress(cb: (d: { pct: number; eta: number | null }) => void): void;
  onBeforeClose(cb: () => void): void;
  closeConfirmed(): Promise<void>;
  recoveryPath(): Promise<string>;
  exportDefaultPath(name: string): Promise<string>;
  tabletStart(): Promise<TabletInfo>;
  tabletStop(): Promise<boolean>;
  tabletInfo(): Promise<TabletInfo | null>;
  tabletSetAutoStart(v: boolean): Promise<boolean>;
  tabletNewKey(): Promise<TabletInfo | null>;
  tabletClients(): Promise<{ clients: { ip: string; ua: string; ago: number; stage?: string; error?: string | null; got?: boolean }[]; hasState: boolean } | null>;
  tabletPush(s: TabletState): void;
  onTabletApply(cb: (edits: TabletEdits) => void): void;
  onTabletCommand(cb: (cmd: TabletCommand) => Promise<unknown>): void;
  projectPathFor(name: string): Promise<string>;
  openAny(title?: string): Promise<FileOffer[]>;
  onTabletStarted(cb: (i: TabletInfo) => void): void;
  onTabletTransfer(cb: (t: { id: string; dir: 'up' | 'down'; name: string; size?: number; done?: number; finished?: boolean; error?: string; path?: string }) => void): void;
  onTabletExport(cb: (o: TabletExportOptions) => void): void;
  /** true en la app de la tablet (sin acceso a archivos del PC). */
  isTablet?: boolean;
  mediaUrl(p: string): string;
  pathForFile(f: File): string;
}

declare global {
  interface Window {
    api: Api;
  }
}
