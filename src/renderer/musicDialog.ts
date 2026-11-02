import { store } from './store';
import { $, fmtTime, h, toast } from './util';

/** Abre el selector (permite varias canciones a la vez) y las añade a la lista. */
export async function chooseMusic(): Promise<boolean> {
  if (window.api.isTablet) {
    // en la tablet las añade el PC (ver tabletApi)
    const before = store.songs.length;
    await window.api.openMusic();
    return store.songs.length > before;
  }
  const paths = await window.api.openMusic();
  if (!paths.length) return false;
  const t = toast('Analizando el ritmo…', 'info', 120000);
  const added = await store.addSongs(paths, (msg) => (t.textContent = msg));
  t.remove();
  if (added.length) {
    toast(added.length === 1
      ? `🎵 ${added[0].name}: ${fmtTime(added[0].duration)} · ${Math.round(added[0].bpm)} BPM`
      : `🎵 ${added.length} canciones añadidas · ${fmtTime(store.musicLength())} de música`, 'ok', 4000);
  } else if (paths.length) toast('Esas canciones ya estaban en la lista', 'info', 3000);
  return added.length > 0;
}

/** "1:23,4" o "83.4" → segundos */
function parseTime(v: string): number | null {
  const t = v.trim().replace(',', '.');
  const m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return /^\d+(?:\.\d+)?$/.test(t) ? Number(t) : null;
}
const fmtT = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

export async function openMusicDialog() {
  if (!store.songs.length && !(await chooseMusic())) return;
  const dlg = h('div', { class: 'modal-back' });
  dlg.innerHTML = `
  <div class="modal wide">
    <h2>🎵 Música</h2>
    <p class="muted small">Suenan seguidas, en este orden, las canciones marcadas. Puedes recortar el principio y el final de cada una.</p>
    <div id="mu-list" class="song-list"></div>
    <div class="row gap">
      <button id="mu-add">＋ Añadir canciones…</button>
      <button id="mu-all" class="chip">Marcar todas</button>
      <button id="mu-none" class="chip">Desmarcar todas</button>
      <span class="spacer"></span>
      <span id="mu-total" class="mono"></span>
    </div>
    <div class="form mt">
      <label>Volumen de la música: <b id="mu-vol-v"></b><input type="range" id="mu-vol" min="0" max="100"></label>
      <label>Sonido de la cámara mientras suena: <b id="mu-orig-v"></b><input type="range" id="mu-orig" min="0" max="100"></label>
      <label>Fundido al final: <b id="mu-fade-v"></b><input type="range" id="mu-fade" min="0" max="10" step="0.5"></label>
      <p class="muted small">Para que el resumen dure lo mismo que la música y corte al ritmo, usa <b>✨ Highlights automáticos</b>.</p>
    </div>
    <div class="modal-actions">
      <button id="mu-remove" class="danger">Quitar toda la música</button>
      <span class="spacer"></span>
      <button id="mu-ok" class="primary">Listo</button>
    </div>
  </div>`;
  document.body.append(dlg);
  const inp = (id: string) => $<HTMLInputElement>(id, dlg);
  const changed = () => { store.emit('music'); renderTotals(); };

  function renderTotals() {
    const act = store.activeSongs();
    $('#mu-total', dlg).textContent = act.length
      ? `${act.length} de ${store.songs.length} marcadas · ${fmtTime(store.musicLength())}`
      : 'Ninguna marcada';
    const st = store.musicSettings;
    inp('#mu-vol').value = String(Math.round(st.volume * 100));
    inp('#mu-orig').value = String(Math.round(st.origVolume * 100));
    inp('#mu-fade').value = String(st.fadeOut);
    $('#mu-vol-v', dlg).textContent = `${inp('#mu-vol').value} %`;
    $('#mu-orig-v', dlg).textContent = `${inp('#mu-orig').value} %`;
    $('#mu-fade-v', dlg).textContent = `${st.fadeOut} s`;
  }

  function renderList() {
    const list = $('#mu-list', dlg);
    list.innerHTML = '';
    if (!store.songs.length) list.append(h('div', { class: 'muted pad' }, 'No hay canciones. Pulsa «Añadir canciones…».'));
    store.songs.forEach((s, i) => {
      const chk = h('input', { type: 'checkbox' }) as HTMLInputElement;
      chk.checked = s.enabled;
      chk.onchange = () => { s.enabled = chk.checked; row.classList.toggle('off', !s.enabled); changed(); };
      const timeInput = (val: number, on: (v: number) => void) => {
        const t = h('input', { type: 'text', class: 'num time-in', value: fmtT(val), title: 'minutos:segundos' }) as HTMLInputElement;
        t.onchange = () => {
          const v = parseTime(t.value);
          if (v == null) { t.value = fmtT(val); return; }
          on(v);
          renderList();
          changed();
        };
        return t;
      };
      const from = timeInput(s.start, (v) => (s.start = Math.max(0, Math.min(v, s.end - 1))));
      const to = timeInput(s.end, (v) => (s.end = Math.min(s.duration, Math.max(v, s.start + 1))));
      const btn = (txt: string, title: string, fn: () => void, disabled = false) => {
        const b = h('button', { class: 'mini', title, disabled }, txt);
        b.onclick = fn;
        return b;
      };
      const row = h('div', { class: 'song' + (s.enabled ? '' : ' off') },
        h('label', { class: 'check' }, chk),
        h('div', { class: 'song-main' },
          h('div', { class: 'song-name', title: s.path }, s.name),
          h('div', { class: 'muted small' }, `${Math.round(s.bpm)} BPM · ${fmtTime(s.duration)} · se usa ${fmtTime(s.end - s.start)}`)),
        h('div', { class: 'song-range' }, 'de', from, 'a', to),
        btn('↑', 'Subir', () => { [store.songs[i - 1], store.songs[i]] = [store.songs[i], store.songs[i - 1]]; renderList(); changed(); }, i === 0),
        btn('↓', 'Bajar', () => { [store.songs[i + 1], store.songs[i]] = [store.songs[i], store.songs[i + 1]]; renderList(); changed(); }, i === store.songs.length - 1),
        btn('×', 'Quitar de la lista', () => { store.songs.splice(i, 1); renderList(); changed(); })
      );
      list.append(row);
    });
    renderTotals();
  }
  renderList();

  $('#mu-add', dlg).onclick = async () => { if (await chooseMusic()) renderList(); };
  $('#mu-all', dlg).onclick = () => { store.songs.forEach((s) => (s.enabled = true)); renderList(); changed(); };
  $('#mu-none', dlg).onclick = () => { store.songs.forEach((s) => (s.enabled = false)); renderList(); changed(); };
  inp('#mu-vol').oninput = () => { store.musicSettings.volume = Number(inp('#mu-vol').value) / 100; changed(); };
  inp('#mu-orig').oninput = () => { store.musicSettings.origVolume = Number(inp('#mu-orig').value) / 100; changed(); };
  inp('#mu-fade').oninput = () => { store.musicSettings.fadeOut = Number(inp('#mu-fade').value); changed(); };
  $('#mu-remove', dlg).onclick = async () => {
    if ((await window.api.confirm('¿Quitar todas las canciones del proyecto?', ['Quitar', 'Cancelar'])) !== 0) return;
    store.songs = [];
    store.emit('music');
    dlg.remove();
  };
  $('#mu-ok', dlg).onclick = () => dlg.remove();
}
