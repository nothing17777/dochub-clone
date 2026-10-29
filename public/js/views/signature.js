import { h, modal, toast, clear, add } from '../ui.js';
import { get, post } from '../api.js';

const SCRIPT_FONTS = ['Caveat', 'Dancing Script', 'Great Vibes', 'Satisfy'];

/** Draw / type / upload a signature, then persist it to the signature library.
 *  Resolves with the stored signature row, or null if cancelled. */
export function signaturePad({ kind = 'signature' } = {}) {
  return new Promise(async (resolve) => {
    const existing = await get('/api/v1/signatures').catch(() => ({ signatures: [] }));
    const mine = existing.signatures.filter((s) => s.kind === kind);
    let tab = mine.length ? 'saved' : 'draw';

    const body = h('div', {});
    const render = () => {
      clear(body);
      add(body, h('div', { class: 'tabs' },
        ...[['saved', `Saved (${mine.length})`], ['draw', 'Draw'], ['type', 'Type'], ['upload', 'Upload']]
          .map(([id, label]) => h('button', { class: tab === id ? 'on' : '',
            onclick: () => { tab = id; render(); } }, label))));
      if (tab === 'saved') return renderSaved();
      if (tab === 'draw') return renderDraw();
      if (tab === 'type') return renderType();
      return renderUpload();
    };

    const finish = async (payload) => {
      try {
        const { signature } = await post('/api/v1/signatures/create-with-svg-data', { kind, ...payload });
        m.close(); resolve(signature);
      } catch { /* toast shown */ }
    };

    function renderSaved() {
      if (!mine.length) return add(body, h('p', { class: 'sub' }, 'Nothing saved yet.'));
      add(body, h('div', { class: 'stamp-grid' }, ...mine.map((s) => h('button', {
        onclick: () => { m.close(); resolve(s); },
      }, s.png_data ? h('img', { src: s.png_data, style: { width: '100%' } })
                    : h('div', { html: s.svg_data })))));
    }

    function renderDraw() {
      const canvas = h('canvas', { class: 'sigpad', width: 640, height: 200,
                                   style: { height: '160px' } });
      const ctx = canvas.getContext('2d');
      ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#16202f';
      let drawing = false, dirty = false;
      const pos = (e) => {
        const r = canvas.getBoundingClientRect();
        const p = e.touches?.[0] || e;
        return [(p.clientX - r.left) * (canvas.width / r.width), (p.clientY - r.top) * (canvas.height / r.height)];
      };
      const start = (e) => { e.preventDefault(); drawing = true; dirty = true; ctx.beginPath(); ctx.moveTo(...pos(e)); };
      const move = (e) => { if (!drawing) return; e.preventDefault(); ctx.lineTo(...pos(e)); ctx.stroke(); };
      const end = () => { drawing = false; };
      canvas.addEventListener('pointerdown', start);
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', end);
      canvas.addEventListener('pointerleave', end);
      add(body, canvas,
        h('p', { class: 'sub' }, 'Draw with a mouse, trackpad or touchscreen.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; } }, 'Clear'),
          h('button', { class: 'btn primary sm', onclick: () => {
            if (!dirty) return toast('Draw your signature first', 'bad');
            finish({ png_data: canvas.toDataURL('image/png'), method: 'draw' });
          } }, 'Use this signature')));
    }

    function renderType() {
      const text = h('input', { type: 'text', placeholder: 'Your name' });
      let font = SCRIPT_FONTS[0];
      const preview = h('div', { style: { fontSize: '40px', padding: '14px 4px', minHeight: '70px' } });
      const paint = () => { preview.style.fontFamily = `"${font}", cursive`; preview.textContent = text.value || 'Your name'; };
      text.oninput = paint;
      add(body, 
        h('link', { rel: 'stylesheet',
          href: `https://fonts.googleapis.com/css2?${SCRIPT_FONTS.map((f) => `family=${f.replace(/ /g, '+')}`).join('&')}&display=swap` }),
        h('label', { class: 'field' }, h('span', {}, 'Type your name'), text),
        h('div', { class: 'chip-row' }, ...SCRIPT_FONTS.map((f) => h('button', { class: 'chip',
          style: { fontFamily: `"${f}", cursive`, fontSize: '16px' },
          onclick: () => { font = f; paint(); } }, f))),
        preview,
        h('button', { class: 'btn primary sm', onclick: () => {
          if (!text.value.trim()) return toast('Type your name first', 'bad');
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 110" width="420" height="110">`
            + `<text x="10" y="74" font-family="${font}, cursive" font-size="58" fill="#16202f">`
            + `${text.value.replace(/[<>&]/g, '')}</text></svg>`;
          finish({ svg_data: svg, method: 'type', font });
        } }, 'Use this signature'));
      paint();
    }

    function renderUpload() {
      const file = h('input', { type: 'file', accept: 'image/*' });
      file.onchange = () => {
        const f = file.files[0]; if (!f) return;
        const fr = new FileReader();
        fr.onload = () => finish({ png_data: fr.result, method: 'upload' });
        fr.readAsDataURL(f);
      };
      add(body, h('label', { class: 'field' }, h('span', {}, 'Upload a PNG or JPG of your signature'), file),
        h('p', { class: 'sub' }, 'A transparent PNG works best.'));
    }

    const m = modal({
      title: kind === 'initials' ? 'Your initials' : 'Your signature',
      body, wide: true, onClose: () => resolve(null),
    });
    render();
  });
}
