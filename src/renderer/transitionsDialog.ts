import { store } from './store';
import type { TransitionType } from './types';
import { $, h } from './util';

export const TRANSITIONS: [TransitionType, string][] = [
  ['none', 'Sin transición (corte seco)'],
  ['fade', 'Fundido cruzado'],
  ['dissolve', 'Disolución'],
  ['fadeblack', 'Fundido a negro'],
  ['fadewhite', 'Fundido a blanco (destello)'],
  ['slideleft', 'Deslizar'],
  ['wipeleft', 'Barrido'],
  ['circleopen', 'Círculo'],
  ['zoomin', 'Zoom'],
  ['radial', 'Radial'],
  ['random', 'Variadas (una distinta en cada corte)']
];

export function openTransitionsDialog() {
  const t = store.transitions;
  const dlg = h('div', { class: 'modal-back' });
  dlg.innerHTML = `
  <div class="modal">
    <h2>⧉ Transiciones</h2>
    <div class="form">
      <label>Entre momentos
        <select id="tr-type">${TRANSITIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      </label>
      <label>Duración de cada transición: <b id="tr-dur-v"></b>
        <input type="range" id="tr-dur" min="0.2" max="1.5" step="0.1">
      </label>
      <label class="check"><input type="checkbox" id="tr-ends"> Fundido desde negro al empezar y a negro al terminar</label>
      <p class="muted small">Cada transición se centra en el corte: el vídeo dura lo mismo y, con música, el cambio de escena
        sigue cayendo en el pulso. Se aplican al exportar; en la vista previa se ven como cortes (marcados con ◆ en la línea de tiempo).
        Si un momento es muy corto, su transición se acorta sola.</p>
    </div>
    <div class="modal-actions"><button id="tr-ok" class="primary">Listo</button></div>
  </div>`;
  document.body.append(dlg);
  const type = $<HTMLSelectElement>('#tr-type', dlg);
  const dur = $<HTMLInputElement>('#tr-dur', dlg);
  const ends = $<HTMLInputElement>('#tr-ends', dlg);
  type.value = t.type;
  dur.value = String(t.duration);
  ends.checked = t.fadeEnds;
  const show = () => {
    $('#tr-dur-v', dlg).textContent = `${Number(dur.value).toFixed(1).replace('.', ',')} s`;
    dur.disabled = type.value === 'none';
  };
  show();
  const save = () => {
    store.transitions = { type: type.value as TransitionType, duration: Number(dur.value), fadeEnds: ends.checked };
    store.emit('transitions');
    show();
  };
  type.onchange = save;
  dur.oninput = save;
  ends.onchange = save;
  $('#tr-ok', dlg).onclick = () => dlg.remove();
}
