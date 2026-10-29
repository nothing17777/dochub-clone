import { h, clear, toast, modal, fmtDateTime, add } from '../ui.js';
import { get, post } from '../api.js';
import { loadPdfjs } from './dashboard.js';

/** Public signer experience. Authenticated by the access token in the URL;
 *  no DocHub account required. */
export function signView(navigate, route) {
  const token = route.parts[1];
  const root = h('div', { class: 'sign-shell' }, h('div', { class: 'empty' }, 'Opening document…'));
  let data = null, pdf = null;

  async function load() {
    try { data = await get(`/api/v1/sign/${token}`); }
    catch (err) {
      add(clear(root), h('div', { class: 'card pad empty' },
        h('div', { class: 'big' }, '🔒'), h('p', {}, err.message)));
      return;
    }
    if (data.verification_required) return renderVerify();
    if (data.document.source_id) {
      try {
        const pdfjs = await loadPdfjs();
        const buf = await (await fetch(`/api/v1/sources/${data.document.source_id}/blob`)).arrayBuffer();
        pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
      } catch {}
    }
    render();
  }

  function renderVerify() {
    const val = h('input', { type: 'text', placeholder: data.verification_required === 'sms' ? 'SMS code' : 'Access code' });
    add(clear(root), h('div', { class: 'card pad', style: { maxWidth: '420px', margin: '60px auto' } },
      h('h1', { style: { fontSize: '19px', marginTop: 0 } }, 'Verify to continue'),
      h('p', { class: 'sub' }, `The sender protected this document with ${data.verification_required === 'sms' ? 'an SMS code' : 'an access code'}.`),
      h('label', { class: 'field' }, h('span', {}, 'Code'), val),
      h('button', { class: 'btn primary', onclick: async () => {
        try { await post(`/api/v1/sign/${token}/verify`, { value: val.value }); load(); } catch {}
      } }, 'Continue')));
  }

  function render() {
    clear(root);
    const mine = data.formfields.filter((f) => !f.signer_role || f.signer_role === data.signer.role_name);
    const progress = h('span', { class: 'sub' });
    const updateProgress = () => {
      const req = mine.filter((f) => f.required);
      const done = req.filter((f) => f.value).length;
      progress.textContent = req.length ? `${done} of ${req.length} required fields complete` : 'No required fields';
    };

    add(root, 
      h('div', { class: 'sign-bar' },
        h('div', {}, h('strong', {}, data.document.title),
          h('div', { class: 'sub' }, `${data.sign_request.subject} · ${data.sign_request.envelope_id}`)),
        h('div', { class: 'spacer' }), progress,
        h('button', { class: 'btn', onclick: decline }, 'Decline'),
        h('button', { class: 'btn primary', onclick: finish }, '✓ Finish signing')),
      data.sign_request.message
        ? h('div', { class: 'card pad', style: { marginBottom: '14px' } },
            h('strong', {}, 'Message from the sender'), h('p', { style: { margin: '6px 0 0' } }, data.sign_request.message))
        : null,
      data.signer.state === 'signed'
        ? h('div', { class: 'card pad', style: { marginBottom: '14px', borderLeft: '3px solid var(--good)' } },
            h('strong', {}, 'You have signed this document.'))
        : null);

    const stages = h('div', {});
    add(root, stages);
    for (const page of data.document.pages) {
      const canvas = h('canvas', {});
      const layer = h('div', { class: 'ann-layer' });
      const stage = h('div', { class: 'page-stage', style: { marginBottom: '18px' } }, canvas, layer);
      add(stages, stage);
      paint(canvas, page).then(() => {
        stage.style.width = `${canvas.width}px`; stage.style.height = `${canvas.height}px`;
        overlay(layer, page, canvas.width, canvas.height, updateProgress);
      });
    }
    updateProgress();
  }

  async function paint(canvas, page) {
    const scale = Math.min(1.3, (Math.min(940, window.innerWidth - 60)) / (page.width || 612));
    canvas.width = (page.width || 612) * scale; canvas.height = (page.height || 792) * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (pdf && page.source_page_index != null) {
      const pg = await pdf.getPage(page.source_page_index + 1);
      const vp = pg.getViewport({ scale, rotation: page.rotation || 0 });
      canvas.width = vp.width; canvas.height = vp.height;
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    }
  }

  function overlay(layer, page, W, H, updateProgress) {
    clear(layer);
    for (const a of data.annotations.filter((x) => x.page_id === page.id)) {
      const d = JSON.parse(a.data || '{}');
      const node = h('div', { class: 'ann', style: {
        left: `${a.x * W}px`, top: `${a.y * H}px`, width: `${a.w * W}px`, height: `${a.h * H}px`, cursor: 'default' } });
      if (a.type === 'text' || a.type === 'date') node.append(h('div', { style: { fontSize: `${(d.size || 14)}px` } }, d.text || ''));
      else if (a.type === 'highlight') node.style.background = d.color || 'rgba(255,214,0,.42)';
      else if (a.type === 'whiteout') node.style.background = '#fff';
      else if (d.png) node.append(h('img', { src: d.png, style: { width: '100%', height: '100%', objectFit: 'contain' } }));
      else if (d.svg) node.innerHTML = d.svg;
      layer.append(node);
    }
    for (const f of data.formfields.filter((x) => x.page_id === page.id)) {
      const assigned = !f.signer_role || f.signer_role === data.signer.role_name;
      const node = h('div', { class: `ff ${f.required && assigned ? 'required' : ''} ${f.value ? 'filled' : ''}`,
        style: { left: `${f.x * W}px`, top: `${f.y * H}px`, width: `${f.w * W}px`, height: `${f.h * H}px`,
                 cursor: assigned ? 'text' : 'not-allowed', opacity: assigned ? 1 : .45 } },
        h('span', { class: 'ff-tag' }, `${f.name}${f.required ? ' *' : ''}`));
      if (!assigned || data.signer.state === 'signed') { layer.append(node); continue; }

      const save = async (value) => {
        f.value = value;
        await post(`/api/v1/sign/${token}/fields`, { formfields: [{ id: f.id, value }] }).catch(() => {});
        node.classList.toggle('filled', !!value);
        updateProgress();
      };
      if (f.type === 'signature' || f.type === 'initials') {
        node.append(h('button', { class: 'btn ghost sm', style: { width: '100%' }, onclick: async () => {
          const sig = await signerSignature(f.type);
          if (!sig) return;
          node.innerHTML = '';
          node.append(h('img', { src: sig, style: { width: '100%', height: '100%', objectFit: 'contain' } }));
          signatureImages.set(f.id, { png: sig, page_id: f.page_id, x: f.x, y: f.y, w: f.w, h: f.h });
          await save('signed');
        } }, f.type === 'initials' ? 'Initial' : 'Sign here'));
      } else if (f.type === 'checkbox') {
        node.append(h('input', { type: 'checkbox', checked: f.value === 'true',
          onchange: (e) => save(String(e.target.checked)) }));
      } else if (f.type === 'dropdown' || f.type === 'radio') {
        node.append(h('select', { onchange: (e) => save(e.target.value) }, h('option', { value: '' }, '—'),
          ...JSON.parse(f.options || '[]').map((o) => h('option', { value: o, selected: f.value === o }, o))));
      } else if (f.type === 'attachment') {
        node.append(h('input', { type: 'file', style: { fontSize: '10px' },
          onchange: (e) => save(e.target.files[0]?.name || '') }));
      } else {
        node.append(h('input', { type: f.type === 'date' ? 'date' : 'text', value: f.value || '',
          placeholder: f.placeholder || '', style: { width: '100%' },
          onchange: (e) => save(e.target.value) }));
      }
      layer.append(node);
    }
  }

  const signatureImages = new Map();

  async function finish() {
    const first = [...signatureImages.values()][0];
    try {
      const r = await post(`/api/v1/sign/${token}/complete`, first ? {
        signature_png: first.png, page_id: first.page_id,
        x: first.x, y: first.y, w: first.w, h: first.h,
      } : {});
      modal({ title: 'Signed', body: h('div', {},
        h('p', {}, 'Your signature has been recorded.'),
        r.envelope_complete ? h('p', { class: 'sub' }, 'Everyone has now signed — the sender has been notified.')
                            : h('p', { class: 'sub' }, 'Waiting on the remaining signers.')),
        footer: [h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Done')] });
    } catch {}
  }

  async function decline() {
    const reason = h('textarea', { placeholder: 'Optional reason' });
    const m = modal({ title: 'Decline to sign', body: h('label', { class: 'field' }, reason),
      footer: [h('button', { class: 'btn danger', onclick: async () => {
        await post(`/api/v1/sign/${token}/decline`, { reason: reason.value });
        m.close(); toast('You declined this request'); location.reload();
      } }, 'Decline')] });
  }

  load();
  return root;
}

/** Signers have no account, so their signature is captured in-page only. */
function signerSignature(kind) {
  return new Promise((resolve) => {
    const canvas = h('canvas', { class: 'sigpad', width: 640, height: 200, style: { height: '160px' } });
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.strokeStyle = '#16202f';
    let drawing = false, dirty = false;
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return [(e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height)];
    };
    canvas.addEventListener('pointerdown', (e) => { drawing = dirty = true; ctx.beginPath(); ctx.moveTo(...pos(e)); });
    canvas.addEventListener('pointermove', (e) => { if (drawing) { ctx.lineTo(...pos(e)); ctx.stroke(); } });
    canvas.addEventListener('pointerup', () => { drawing = false; });
    const m = modal({ title: kind === 'initials' ? 'Your initials' : 'Your signature', wide: true,
      body: h('div', {}, canvas, h('p', { class: 'sub' }, 'Draw inside the box, then confirm.')),
      footer: [
        h('button', { class: 'btn ghost', onclick: () => { ctx.clearRect(0, 0, 640, 200); dirty = false; } }, 'Clear'),
        h('button', { class: 'btn primary', onclick: () => {
          if (!dirty) return toast('Draw your signature first', 'bad');
          m.close(); resolve(canvas.toDataURL('image/png'));
        } }, 'Apply'),
      ], onClose: () => resolve(null) });
  });
}
