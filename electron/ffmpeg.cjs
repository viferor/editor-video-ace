// Envoltorio de FFmpeg/FFprobe: análisis, proxies, detección de GPU y exportación.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function unpacked(p) {
  return p ? p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep) : p;
}

const FFMPEG = process.env.FFMPEG_PATH || unpacked(require('ffmpeg-static'));
/** ffprobe: en la app instalada va en resources/bin; en desarrollo, el del paquete ffprobe-static. */
function findFfprobe() {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  if (process.resourcesPath) {
    const p = path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (fs.existsSync(p)) return p;
  }
  return unpacked(require('ffprobe-static').path);
}
const FFPROBE = findFfprobe();

/** Lanza un proceso y devuelve { proc, done } donde done resuelve con { code, stdout, stderr }. */
const running = new Set();
/** Mata todos los FFmpeg en marcha (al cerrar la app, para que no queden huérfanos). */
function killAll() {
  for (const p of running) {
    try { p.kill('SIGKILL'); } catch {}
  }
  running.clear();
}

function run(bin, args, { onStdoutLine } = {}) {
  const proc = spawn(bin, args, { windowsHide: true });
  running.add(proc);
  proc.on('close', () => running.delete(proc));
  let stdout = '';
  let stderr = '';
  let buf = '';
  proc.stdout.on('data', (d) => {
    const s = d.toString();
    stdout += s;
    if (onStdoutLine) {
      buf += s;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        onStdoutLine(buf.slice(0, i).trim());
        buf = buf.slice(i + 1);
      }
    }
  });
  proc.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 200000) stderr = stderr.slice(-100000);
  });
  const done = new Promise((resolve) => {
    proc.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + String(err) }));
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  return { proc, done };
}

function parseRate(r) {
  if (!r || r === '0/0') return 0;
  const [a, b] = r.split('/').map(Number);
  return b ? a / b : a;
}

async function probe(file) {
  const { code, stdout, stderr } = await run(FFPROBE, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file
  ]).done;
  if (code !== 0) throw new Error('ffprobe falló: ' + stderr.slice(-500));
  const j = JSON.parse(stdout);
  const streams = j.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('El archivo no tiene pista de vídeo');
  const fmt = j.format || {};
  const tags = Object.assign({}, v.tags || {}, fmt.tags || {});
  // Giro en sentido horario (0/90/180/270), como lo aplica FFmpeg al decodificar.
  // La Insta360 lo marca así cuando graba boca abajo (180).
  let rotation = 0;
  if (v.tags && v.tags.rotate) rotation = Number(v.tags.rotate) || 0;
  for (const sd of v.side_data_list || []) if (typeof sd.rotation === 'number') rotation = -sd.rotation;
  rotation = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  let width = v.width;
  let height = v.height;
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  const fpsStr = v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate;
  return {
    duration: Number(fmt.duration || v.duration || 0),
    width,
    height,
    fps: parseRate(fpsStr),
    fpsStr,
    vcodec: v.codec_name,
    pixFmt: v.pix_fmt,
    hasAudio: !!a,
    rotation,
    creationTime: tags.creation_time || null,
    size: Number(fmt.size || 0)
  };
}

let encoderCache = null;
async function detectEncoders() {
  if (encoderCache) return encoderCache;
  const test = async (enc) => {
    const { code } = await run(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:d=0.2',
      '-c:v', enc, '-f', 'null', '-'
    ]).done;
    return code === 0;
  };
  const [h264, hevc] = await Promise.all([test('h264_nvenc'), test('hevc_nvenc')]);
  encoderCache = { h264Nvenc: h264, hevcNvenc: hevc, ffmpeg: FFMPEG };
  return encoderCache;
}

/**
 * Proxy ligero: 540p, máximo 30 fps y GOP corto para que buscar fotogramas sea instantáneo.
 * mode 'cuda': todo en la GPU (decodifica, escala y codifica sin pasar por el procesador; lo más rápido)
 * mode 'gpu':  decodifica y codifica en la GPU, escala en el procesador
 * mode 'cpu':  todo en el procesador (último recurso)
 */
function makeProxyOnce(src, dest, info, mode, onProgress) {
  const tmp = `${dest}.${process.pid}-${Date.now()}.part.mp4`;
  const H = 540;
  const W = Math.max(2, Math.round((H * (info.width || 16)) / (info.height || 9) / 2) * 2);
  const fpsCap = info.fps > 31 ? ',fps=30' : '';
  // Con fotogramas en la GPU FFmpeg no aplica el giro automático: se escala en la GPU,
  // se baja la imagen pequeña y se gira en el procesador (barato a 540p).
  const rot = info.rotation || 0;
  const rotF = rot === 180 ? ',hflip,vflip' : rot === 90 ? ',transpose=clock' : rot === 270 ? ',transpose=cclock' : '';
  const preW = rot % 180 ? H : W, preH = rot % 180 ? W : H;
  const vf =
    mode === 'cuda'
      ? `scale_cuda=${preW}:${preH}:format=yuv420p${rotF ? ',hwdownload,format=yuv420p' + rotF : ''}${fpsCap}`
      : `scale=${W}:${H},format=yuv420p${fpsCap}`;
  const args = [
    '-y', '-hide_banner', '-nostats', '-loglevel', 'error', '-progress', 'pipe:1',
    ...(mode === 'cuda' ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'] : mode === 'gpu' ? ['-hwaccel', 'cuda'] : []),
    '-i', src,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', vf,
    ...(mode === 'cpu'
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27']
      : ['-c:v', 'h264_nvenc', '-preset', 'p1', '-rc', 'vbr', '-cq', '30', '-b:v', '0']),
    '-g', '15', '-bf', '0',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
    '-movflags', '+faststart',
    tmp
  ];
  const started = Date.now();
  const job = run(FFMPEG, args, {
    onStdoutLine: (line) => {
      const m = /^out_time_us=(\d+)/.exec(line);
      if (m && info.duration > 0) {
        const pct = Math.min(0.99, Number(m[1]) / 1e6 / info.duration);
        const el = (Date.now() - started) / 1000;
        onProgress(pct, pct > 0.03 ? (el / pct) * (1 - pct) : null);
      }
    }
  });
  const done = job.done.then(({ code, stderr }) => {
    if (code !== 0) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`Error generando proxy (${mode}): ` + stderr.slice(-800));
    }
    fs.renameSync(tmp, dest);
    return dest;
  });
  return { proc: job.proc, done };
}

/** Prueba el modo más rápido disponible y, si falla, baja al siguiente. */
function makeProxy(src, dest, info, enc, onProgress) {
  const modes = enc.h264Nvenc ? ['cuda', 'gpu', 'cpu'] : ['cpu'];
  const attempt = (i) =>
    makeProxyOnce(src, dest, info, modes[i], onProgress).done.catch((err) => {
      if (i + 1 >= modes.length) throw err;
      console.warn(`Proxy en modo ${modes[i]} falló, probando ${modes[i + 1]}:`, String(err).slice(0, 300));
      onProgress(0, null);
      return attempt(i + 1);
    });
  return { done: attempt(0) };
}

/**
 * Análisis rápido del vídeo para los highlights: movimiento (diferencia entre imágenes clave)
 * y volumen del sonido, cada medio segundo. Solo decodifica imágenes clave, así que es muy rápido.
 */
async function analyze(file, duration) {
  const parse = (out, key) => {
    const res = [];
    let t = null;
    for (const line of out.split(/\r?\n/)) {
      const m = /pts_time:([\d.]+)/.exec(line);
      if (m) { t = Number(m[1]); continue; }
      if (t != null && line.startsWith(key + '=')) {
        const v = Number(line.slice(key.length + 1));
        if (isFinite(v)) res.push([t, v]);
        t = null;
      }
    }
    return res;
  };
  const toBins = (pairs, fill) => {
    const n = Math.max(1, Math.ceil(duration));
    const sum = new Float64Array(n), cnt = new Uint32Array(n);
    for (const [t, v] of pairs) { const i = Math.min(n - 1, Math.floor(t)); sum[i] += v; cnt[i]++; }
    const out = [];
    let last = fill;
    for (let i = 0; i < n; i++) { if (cnt[i]) last = sum[i] / cnt[i]; out.push(last); }
    return out;
  };
  const vid = await run(FFMPEG, [
    '-hide_banner', '-nostats', '-skip_frame', 'nokey', '-i', file, '-an',
    '-vf', 'scale=160:90,format=gray,tblend=all_mode=difference,signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=-',
    '-f', 'null', '-'
  ]).done;
  const aud = await run(FFMPEG, [
    '-hide_banner', '-nostats', '-i', file, '-vn',
    '-af', 'aresample=8000,asetnsamples=n=4000:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-',
    '-f', 'null', '-'
  ]).done;
  const motion = vid.code === 0 ? toBins(parse(vid.stdout, 'lavfi.signalstats.YAVG'), 0) : null;
  const audio = aud.code === 0 ? toBins(parse(aud.stdout, 'lavfi.astats.Overall.RMS_level').map(([t, v]) => [t, Math.max(-90, v)]), -90) : null;
  return { motion, audio };
}

/** Borra proxies a medias que quedaron de sesiones anteriores. */
function cleanPartials(dir) {
  try {
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.part.mp4')) fs.rmSync(path.join(dir, f), { force: true });
  } catch {}
}

function encoderArgs(codec, quality, enc) {
  if (quality === 'inter') {
    // piezas intermedias (se vuelven a codificar al poner los datos): calidad muy alta
    if (codec === 'hevc' && enc.hevcNvenc) return { gpu: true, args: ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '14', '-b:v', '0', '-tag:v', 'hvc1'] };
    if (enc.h264Nvenc) return { gpu: true, args: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '13', '-b:v', '0', '-profile:v', 'high'] };
    return { gpu: false, args: ['-c:v', 'libx264', '-preset', 'fast', '-crf', '12'] };
  }
  const hq = quality === 'max';
  if (codec === 'hevc') {
    if (enc.hevcNvenc)
      return { gpu: true, args: ['-c:v', 'hevc_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', hq ? '18' : '22', '-b:v', '0', '-bf', '3', '-tag:v', 'hvc1'] };
    return { gpu: false, args: ['-c:v', 'libx265', '-preset', 'medium', '-crf', hq ? '18' : '22', '-tag:v', 'hvc1'] };
  }
  if (enc.h264Nvenc)
    return { gpu: true, args: ['-c:v', 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', hq ? '17' : '21', '-b:v', '0', '-profile:v', 'high'] };
  return { gpu: false, args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', hq ? '16' : '19', '-profile:v', 'high'] };
}

/**
 * Exportación en dos pasos, para no agotar la memoria con muchos momentos en 4K:
 *  1) cada momento se recorta, escala y codifica por separado (un solo decodificador cada vez);
 *  2) las piezas se unen (sin recodificar si no hay datos encima) y se añaden datos y música.
 *
 * job = { segments: [{ path, in, out, hasAudio }], output, width, height, fps, codec, quality,
 *         overlay?: { W, H, fps, items[] }, music?: { songs[], volume, origVolume, fadeOut } }
 */
function runExport(job, enc, tmpDir, onProgress) {
  const W = job.width, H = job.height, fps = job.fps || 30;
  const ov = job.overlay && job.overlay.items && job.overlay.items.length ? job.overlay : null;
  const songs = job.music && Array.isArray(job.music.songs) ? job.music.songs.filter((x) => x.end - x.start > 0.1) : [];
  const final = encoderArgs(job.codec, job.quality, enc);
  const piece = ov ? encoderArgs(job.codec, 'inter', enc) : final;
  const durs = job.segments.map((s) => Math.max(0.05, s.out - s.in));
  const total = durs.reduce((a, b) => a + b, 0);
  const workDir = path.join(path.dirname(job.output), `.${path.basename(job.output)}.piezas`);
  const work_dir = () => workDir;
  // peso de cada fase en la barra de progreso
  const w2 = ov ? 0.45 : 0.08;
  const started = Date.now();
  let cancelled = false;
  let current = null;
  let phase2Resolve;
  const phase2 = new Promise((r) => (phase2Resolve = r));
  const report = (frac) => {
    const pct = Math.min(0.999, Math.max(0, frac));
    const el = (Date.now() - started) / 1000;
    onProgress({ pct, eta: pct > 0.02 ? (el / pct) * (1 - pct) : null });
  };
  const runStep = async (args, onTime) => {
    if (cancelled) throw new Error('Exportación cancelada');
    const r = run(FFMPEG, args, {
      onStdoutLine: (line) => {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m) onTime(Number(m[1]) / 1e6);
      }
    });
    current = r.proc;
    r.proc.stdin.on('error', () => {});
    return r;
  };

  const done = (async () => {
    fs.mkdirSync(workDir, { recursive: true });
    try {
      // ---------- 1) piezas
      // Transiciones: centradas en cada corte (usan medio tiempo de cada lado), así la duración
      // total no cambia y el cambio de escena sigue cayendo donde estaba el corte (en el pulso).
      const tr = job.transitions || null;
      const TYPES = ['fade', 'dissolve', 'slideleft', 'wipeleft', 'circleopen', 'zoomin', 'radial', 'fadeblack'];
      const n = job.segments.length;
      const D = tr && tr.type && tr.type !== 'none' ? Math.max(0.1, tr.duration || 0.5) : 0;
      const evenFrames = (x) => Math.max(0, 2 * Math.round((x * fps) / 2)) / fps;
      const td = [];
      for (let k = 0; k < n - 1; k++) td.push(D ? evenFrames(Math.min(D, durs[k] * 0.4, durs[k + 1] * 0.4)) : 0);
      const ttype = (k) => (tr.type === 'random' ? TYPES[(k * 5 + 2) % TYPES.length] : tr.type);
      const endFade = tr && tr.fadeEnds ? Math.min(0.8, durs[0] * 0.4, durs[n - 1] * 0.4) : 0;
      const vChain = `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`;
      const aChain = 'aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo';
      const steps = [];
      for (let k = 0; k < n; k++) {
        const before = k > 0 ? td[k - 1] / 2 : 0, after = k < n - 1 ? td[k] / 2 : 0;
        steps.push({ kind: 'body', k, start: job.segments[k].in + before, len: Math.max(1 / fps, durs[k] - before - after) });
        if (k < n - 1 && td[k] > 0) steps.push({ kind: 'trans', k, len: td[k] });
      }
      const work = steps.reduce((a, st) => a + st.len, 0);
      const parts = [];
      let acc = 0;
      for (let si = 0; si < steps.length; si++) {
        const st = steps[si];
        const out = path.join(work_dir(), `pieza_${String(si).padStart(4, '0')}.mkv`);
        let args;
        if (st.kind === 'body') {
          const s = job.segments[st.k];
          const len = st.len;
          const audioIn = s.hasAudio ? [] : ['-f', 'lavfi', '-t', len.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo'];
          let vf = vChain, af = '';
          if (endFade && st.k === 0) { vf += `,fade=t=in:st=0:d=${endFade}`; af += `,afade=t=in:st=0:d=${endFade}`; }
          if (endFade && st.k === n - 1) { vf += `,fade=t=out:st=${Math.max(0, len - endFade).toFixed(3)}:d=${endFade}`; af += `,afade=t=out:st=${Math.max(0, len - endFade).toFixed(3)}:d=${endFade}`; }
          const fc =
            `[0:v:0]setpts=PTS-STARTPTS,${vf}[v];` +
            `[${s.hasAudio ? '0:a:0' : '1:a:0'}]asetpts=PTS-STARTPTS,${aChain},apad,atrim=0:${len.toFixed(3)}${af}[a]`;
          args = [
            ...(enc.h264Nvenc ? ['-hwaccel', 'cuda'] : []),
            '-ss', st.start.toFixed(3), '-t', len.toFixed(3), '-i', s.path,
            ...audioIn,
            '-filter_complex', fc, '-map', '[v]', '-map', '[a]', '-t', len.toFixed(3)
          ];
        } else {
          // transición: final del momento k + principio del k+1, mezclados con xfade
          const A = job.segments[st.k], B = job.segments[st.k + 1];
          const d = st.len;
          const aStart = A.out - d / 2;
          const missA = Math.max(0, aStart + d - (A.clipDur || Infinity));
          const bWant = B.in - d / 2;
          const missB = Math.max(0, -bWant);
          const bStart = Math.max(0, bWant);
          const ins = [
            ...(enc.h264Nvenc ? ['-hwaccel', 'cuda'] : []), '-ss', aStart.toFixed(3), '-t', d.toFixed(3), '-i', A.path,
            ...(enc.h264Nvenc ? ['-hwaccel', 'cuda'] : []), '-ss', bStart.toFixed(3), '-t', (d - missB).toFixed(3), '-i', B.path
          ];
          let next = 2;
          const aIdx = A.hasAudio ? '0:a:0' : (ins.push('-f', 'lavfi', '-t', d.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo'), `${next++}:a:0`);
          const bIdx = B.hasAudio ? '1:a:0' : (ins.push('-f', 'lavfi', '-t', d.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo'), `${next++}:a:0`);
          const fc = [
            `[0:v:0]setpts=PTS-STARTPTS,${vChain},tpad=stop_mode=clone:stop_duration=${(missA + 0.2).toFixed(3)},trim=duration=${d.toFixed(4)},setpts=PTS-STARTPTS,fps=${fps}[va]`,
            `[1:v:0]setpts=PTS-STARTPTS,${vChain}${missB > 0 ? `,tpad=start_mode=clone:start_duration=${missB.toFixed(3)}` : ''},tpad=stop_mode=clone:stop_duration=0.2,trim=duration=${d.toFixed(4)},setpts=PTS-STARTPTS,fps=${fps}[vb]`,
            `[va][vb]xfade=transition=${ttype(st.k)}:duration=${(d - 0.5 / fps).toFixed(4)}:offset=0,format=yuv420p[v]`,
            `[${aIdx}]asetpts=PTS-STARTPTS,${aChain},apad,atrim=0:${d.toFixed(3)}[aa]`,
            `[${bIdx}]asetpts=PTS-STARTPTS,${aChain}${missB > 0 ? `,adelay=${Math.round(missB * 1000)}:all=1` : ''},apad,atrim=0:${d.toFixed(3)}[ab]`,
            `[aa][ab]acrossfade=d=${(d * 0.98).toFixed(3)}:c1=tri:c2=tri,apad,atrim=0:${d.toFixed(3)}[a]`
          ].join(';');
          args = [...ins, '-filter_complex', fc, '-map', '[v]', '-map', '[a]', '-t', d.toFixed(3)];
        }
        args = ['-y', '-hide_banner', '-nostats', '-loglevel', 'error', '-progress', 'pipe:1', ...args, ...piece.args, '-c:a', 'pcm_s16le', out];
        const r = await runStep(args, (t) => report(((acc + Math.min(t, st.len)) / work) * (1 - w2)));
        r.proc.stdin.end();
        const res = await r.done;
        if (cancelled) throw new Error('Exportación cancelada');
        if (res.code !== 0)
          throw new Error((st.kind === 'body' ? `FFmpeg falló en el momento ${st.k + 1} de ${n}: ` : `FFmpeg falló en la transición ${st.k + 1}: `) + res.stderr.slice(-1000));
        parts.push(out);
        acc += st.len;
      }

      // ---------- 2) unión + datos + música
      const list = path.join(workDir, 'lista.txt');
      fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
      const inputs = ['-f', 'concat', '-safe', '0', '-i', list];
      let idx = 1;
      const filt = [];
      let vLabel = null;
      if (ov) {
        const oi = idx++;
        inputs.push('-thread_queue_size', '1024', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${ov.W}x${ov.H}`, '-framerate', String(ov.fps), '-i', 'pipe:0');
        const n = ov.items.length;
        filt.push(`[${oi}:v]split=${n}${ov.items.map((_, k) => `[s${k}]`).join('')}`);
        let base = '0:v:0';
        ov.items.forEach((it, k) => {
          filt.push(`[s${k}]crop=${it.w}:${it.h}:${it.ax}:${it.ay}[c${k}]`);
          filt.push(`[${base}][c${k}]overlay=${it.X}:${it.Y}:eof_action=pass:format=auto[o${k}]`);
          base = `o${k}`;
        });
        filt.push(`[${base}]format=yuv420p[vout]`);
        vLabel = 'vout';
      }
      let aLabel = '0:a:0';
      if (songs.length) {
        const m = job.music;
        filt.push(`[0:a:0]aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${(m.origVolume ?? 0.2).toFixed(3)}[acam]`);
        songs.forEach((sg, k) => {
          const mi = idx++;
          const len = sg.end - sg.start;
          inputs.push('-ss', Math.max(0, sg.start).toFixed(3), '-t', len.toFixed(3), '-i', sg.path);
          const joins = songs.length > 1 ? `,afade=t=in:st=0:d=0.02,afade=t=out:st=${Math.max(0, len - 0.12).toFixed(3)}:d=0.12` : '';
          filt.push(`[${mi}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${len.toFixed(3)}${joins}[m${k}]`);
        });
        const joined = songs.length > 1 ? 'mcat' : 'm0';
        if (songs.length > 1) filt.push(`${songs.map((_, k) => `[m${k}]`).join('')}concat=n=${songs.length}:v=0:a=1[mcat]`);
        const fade = Math.max(0, Math.min(m.fadeOut || 0, total));
        filt.push(
          `[${joined}]atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS` +
            (fade > 0 ? `,afade=t=out:st=${Math.max(0, total - fade).toFixed(3)}:d=${fade.toFixed(3)}` : '') +
            `,volume=${(m.volume ?? 1).toFixed(3)}[amus]`,
          `[acam][amus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[amix]`
        );
        aLabel = 'amix';
      }
      const args = ['-y', '-hide_banner', '-nostats', '-loglevel', 'error', '-progress', 'pipe:1', ...inputs];
      if (filt.length) {
        const filterFile = path.join(workDir, 'filtro.txt');
        fs.writeFileSync(filterFile, filt.join(';\n'), 'utf8');
        args.push('-filter_complex_script', filterFile);
      }
      args.push('-map', vLabel ? `[${vLabel}]` : '0:v:0', '-map', aLabel.includes(':') ? aLabel : `[${aLabel}]`);
      if (vLabel) args.push(...final.args);
      else args.push('-c:v', 'copy', ...(job.codec === 'hevc' ? ['-tag:v', 'hvc1'] : []));
      args.push('-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-t', total.toFixed(3), job.output);
      const r = await runStep(args, (t) => report((1 - w2) + (Math.min(t, total) / total) * w2));
      let exited = false;
      r.proc.once('close', () => { exited = true; });
      phase2Resolve({
        writeFrame: (buf) =>
          new Promise((resolve) => {
            const stdin = r.proc.stdin;
            if (exited || !stdin.writable) return resolve(false);
            const onClose = () => resolve(false);
            r.proc.once('close', onClose);
            const finish = (v) => { r.proc.removeListener('close', onClose); resolve(v); };
            const ok = stdin.write(buf, (err) => { if (err) finish(false); });
            if (ok) finish(true);
            else stdin.once('drain', () => finish(true));
          }),
        end: () => { try { r.proc.stdin.end(); } catch {} }
      });
      if (!ov) r.proc.stdin.end();
      const res = await r.done;
      if (cancelled) throw new Error('Exportación cancelada');
      if (res.code !== 0) throw new Error('FFmpeg falló al unir: ' + res.stderr.slice(-1200));
      return { output: job.output, gpu: final.gpu, seconds: (Date.now() - started) / 1000 };
    } catch (e) {
      fs.rmSync(job.output, { force: true });
      phase2Resolve(null);
      throw e;
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  })();

  return {
    get proc() { return current; },
    gpu: final.gpu,
    done,
    cancel() { cancelled = true; if (current) current.kill(); },
    /** Fotogramas de los datos: esperan a que empiece la unión (paso 2). */
    async writeFrame(buf) { const p2 = await phase2; return p2 ? p2.writeFrame(buf) : false; },
    async endFrames() { const p2 = await phase2; if (p2) p2.end(); }
  };
}

/**
 * Nivel de sonido cada 0,25 s (en dB). El ruido del viento sube y baja con la velocidad:
 * sirve para comprobar si un clip está bien sincronizado con la actividad.
 */
async function audioLevels(file) {
  const r = await run(FFMPEG, [
    '-hide_banner', '-nostats', '-v', 'error', '-i', file, '-vn',
    '-af', 'aresample=8000,asetnsamples=n=2000:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-',
    '-f', 'null', '-'
  ]).done;
  if (r.code !== 0) return null;
  const out = [];
  let t = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /pts_time:([\d.]+)/.exec(line);
    if (m) { t = Number(m[1]); continue; }
    if (t != null && line.startsWith('lavfi.astats.Overall.RMS_level=')) {
      const v = Number(line.split('=')[1]);
      const i = Math.round(t / 0.25);
      out[i] = isFinite(v) ? Math.max(-90, v) : -90;
      t = null;
    }
  }
  for (let i = 0; i < out.length; i++) if (out[i] == null) out[i] = i ? out[i - 1] : -90;
  return { step: 0.25, levels: out };
}

module.exports = { FFMPEG, FFPROBE, probe, detectEncoders, makeProxy, cleanPartials, killAll, analyze, audioLevels, runExport };
