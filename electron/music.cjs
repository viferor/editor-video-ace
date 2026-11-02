// Análisis de ritmo de una canción: tempo (BPM), pulsos y compases.
// Método: envolvente de ataques (flujo espectral) + autocorrelación para el tempo
// + programación dinámica para colocar los pulsos (Ellis, 2007).
const { spawn } = require('child_process');

const SR = 11025;
const N = 1024; // ventana FFT
const HOP = 256; // ~23 ms
const FPS = SR / HOP;

function decode(ffmpeg, file) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1'], { windowsHide: true });
    const chunks = [];
    let err = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('No se pudo leer la canción: ' + err.slice(-300)));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)));
    });
  });
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/** Envolvente de ataques: aumento de energía espectral (en escala logarítmica) entre ventanas. */
function onsetEnvelope(x) {
  const frames = Math.max(0, Math.floor((x.length - N) / HOP));
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const bins = N / 2;
  let prev = new Float32Array(bins);
  const env = new Float32Array(frames);
  const envLow = new Float32Array(frames);
  const lowBins = Math.round(200 / (SR / N)); // < 200 Hz: bombo y bajo
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    const o = f * HOP;
    for (let i = 0; i < N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const cur = new Float32Array(bins);
    let flux = 0, low = 0;
    for (let k = 1; k < bins; k++) {
      cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      const d = cur[k] - prev[k];
      if (d > 0) { flux += d; if (k <= lowBins) low += d; }
    }
    env[f] = flux;
    envLow[f] = low;
    prev = cur;
  }
  const a = detrend(env), b = detrend(envLow);
  const mix = new Float32Array(frames);
  for (let i = 0; i < frames; i++) mix[i] = a[i] + 1.5 * b[i];
  return { env: detrend(mix), low: b, full: a };
}

/** Quita la tendencia (media móvil de ~1 s) y normaliza. */
function detrend(env) {
  const frames = env.length;
  const out = new Float32Array(frames);
  const w = Math.round(FPS / 2);
  let acc = 0;
  for (let i = 0; i < frames + w; i++) {
    if (i < frames) acc += env[i];
    if (i - 2 * w - 1 >= 0) acc -= env[i - 2 * w - 1];
    const c = i - w;
    if (c >= 0 && c < frames) {
      const n = Math.min(frames, c + w + 1) - Math.max(0, c - w);
      out[c] = Math.max(0, env[c] - acc / n);
    }
  }
  let sd = 0;
  for (const v of out) sd += v * v;
  sd = Math.sqrt(sd / (frames || 1)) || 1;
  for (let i = 0; i < frames; i++) out[i] /= sd;
  return out;
}

function estimateTempo(env) {
  const minLag = Math.round((60 / 190) * FPS), maxLag = Math.round((60 / 65) * FPS);
  let best = { lag: Math.round(0.5 * FPS), score: -Infinity };
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    s /= env.length - lag;
    // preferencia suave por tempos cercanos a 120 BPM (evita confundir el doble o la mitad)
    const bpm = (60 * FPS) / lag;
    const w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    if (s * w > best.score) best = { lag, score: s * w };
  }
  // afinar con interpolación parabólica
  return best.lag;
}

function trackBeats(env, lag) {
  const n = env.length;
  const score = new Float32Array(n), back = new Int32Array(n).fill(-1);
  const tight = 100;
  for (let t = 0; t < n; t++) {
    let bestV = 0, bestP = -1;
    const lo = Math.max(0, t - 2 * lag), hi = t - Math.round(lag / 2);
    for (let p = lo; p <= hi; p++) {
      const r = Math.log((t - p) / lag);
      const v = score[p] - tight * r * r;
      if (bestP < 0 || v > bestV) { bestV = v; bestP = p; }
    }
    score[t] = env[t] + (bestP >= 0 ? bestV : 0);
    back[t] = bestP;
  }
  // último pulso: el de mejor puntuación en el último periodo
  let t = n - 1, bestT = n - 1;
  for (let k = Math.max(0, n - lag); k < n; k++) if (score[k] > score[bestT]) bestT = k;
  t = bestT;
  const beats = [];
  while (t >= 0) { beats.push(t); t = back[t]; }
  return beats.reverse().map((f) => (f * HOP + N / 2) / SR);
}

async function analyzeMusic(ffmpeg, file) {
  const x = await decode(ffmpeg, file);
  const duration = x.length / SR;
  if (duration < 3) throw new Error('La canción es demasiado corta');
  const { env, low, full } = onsetEnvelope(x);
  const lag = estimateTempo(env);
  let beats = trackBeats(env, lag);
  // ¿los pulsos caen en el bombo o a contratiempo? Se comparan los graves en el pulso y medio pulso después.
  const lowAt = (sec) => { const f = Math.round(((sec * SR) - N / 2) / HOP); let m = 0; for (let k = f - 2; k <= f + 2; k++) if (low[k] > m) m = low[k]; return m; };
  const half = (lag * HOP) / SR / 2;
  let on = 0, off = 0;
  for (const b of beats) { on += lowAt(b); off += lowAt(b + half); }
  if (off > on * 1.15) beats = beats.map((b) => b + half).filter((b) => b < duration);
  // sin pulsos en el silencio inicial ni final
  const firstSound = (() => { for (let i = 0; i < env.length; i++) if (env[i] > 0.5) return (i * HOP) / SR; return 0; })();
  beats = beats.filter((b) => b >= firstSound - 0.1);
  const bpm = beats.length > 4 ? 60 / ((beats[beats.length - 1] - beats[0]) / (beats.length - 1)) : (60 * FPS) / lag;
  // compás: de los 4 posibles desfases, el que tenga ataques más fuertes en el primer tiempo
  const strength = (sec) => {
    const f = Math.round(((sec * SR) - N / 2) / HOP);
    let m = 0;
    for (let k = f - 2; k <= f + 2; k++) if (full[k] > m) m = full[k];
    return m;
  };
  let phase = 0, bestS = -1;
  for (let ph = 0; ph < 4; ph++) {
    let s = 0;
    for (let i = ph; i < beats.length; i += 4) s += strength(beats[i]);
    if (s > bestS) { bestS = s; phase = ph; }
  }
  return { duration, bpm: Math.round(bpm * 10) / 10, beats: beats.map((b) => Math.round(b * 1000) / 1000), barPhase: phase };
}

module.exports = { analyzeMusic };
