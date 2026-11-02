import { store, previewUrl } from './store';
import { clamp } from './util';

/** Reproduce la línea de tiempo (varios segmentos de distintos clips) en un único <video>. */
export class TimelinePlayer {
  T = 0;
  playing = false;
  private loadedIdx = -1;
  private seeking: Promise<void> | null = null;
  onUpdate: () => void = () => {};
  private dead = false;
  /** Deja de actualizarse (al cerrar una ventana que tenía su propio reproductor). */
  destroy() { this.dead = true; this.pause(); }

  constructor(public video: HTMLVideoElement) {
    const tick = () => {
      if (this.dead) return;
      if (this.playing && this.loadedIdx >= 0 && !this.video.seeking && !this.seeking) {
        const loc = store.locate(this.T);
        const seg = store.timeline[this.loadedIdx];
        if (seg && loc) {
          const starts = this.starts();
          this.T = starts[this.loadedIdx] + (this.video.currentTime - seg.in);
          if (this.video.currentTime >= seg.out - 0.03 || this.video.ended) {
            if (this.loadedIdx + 1 < store.timeline.length) this.seek(starts[this.loadedIdx + 1], true);
            else { this.T = store.timelineDuration(); this.pause(); }
          }
        }
        this.onUpdate();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private starts() {
    const s: number[] = [];
    let acc = 0;
    for (const seg of store.timeline) { s.push(acc); acc += seg.out - seg.in; }
    return s;
  }

  /** Clip y segundo del clip que se está mostrando ahora. */
  current() {
    if (this.loadedIdx < 0) return null;
    const seg = store.timeline[this.loadedIdx];
    const clip = seg && store.clip(seg.clipId);
    return clip ? { clip, clipTime: this.video.currentTime } : null;
  }

  async seek(t: number, play = false) {
    this.T = clamp(t, 0, store.timelineDuration());
    const loc = store.locate(this.T);
    if (!loc) {
      this.loadedIdx = -1;
      this.video.removeAttribute('src');
      this.onUpdate();
      return;
    }
    const src = previewUrl(loc.clip);
    const job = (async () => {
      if (this.video.dataset.src !== src) {
        this.video.src = src;
        this.video.dataset.src = src;
        await new Promise<void>((r) => this.video.addEventListener('loadedmetadata', () => r(), { once: true }));
      }
      this.loadedIdx = loc.idx;
      this.video.currentTime = loc.clipTime;
      if (play) await this.video.play().catch(() => {});
    })();
    this.seeking = job;
    await job;
    if (this.seeking === job) this.seeking = null;
    this.onUpdate();
  }

  play() {
    if (!store.timeline.length) return;
    if (this.T >= store.timelineDuration() - 0.05) this.T = 0;
    this.playing = true;
    this.seek(this.T, true);
  }
  pause() {
    this.playing = false;
    this.video.pause();
    this.onUpdate();
  }
  toggle() {
    if (this.playing) this.pause(); else this.play();
  }
}
