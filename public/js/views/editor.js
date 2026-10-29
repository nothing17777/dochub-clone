import { h, clear, toast, modal, confirmModal, fmtDateTime, avatar, meter, add } from '../ui.js';
import { get, post, patch } from '../api.js';
import { state, can, connectCable, showPaywall } from '../store.js';
import { loadPdfjs } from './dashboard.js';
import { signaturePad } from './signature.js';
import { sendForSignatureModal } from './send.js';

const TOOLS = [
  { id: 'select', icon: '⬚', label: 'Select' },
  { id: 'text', icon: 'T', label: 'Text' },
  { id: 'image', icon: '🖼', label: 'Image' },
  { id: 'draw', icon: '✎', label: 'Draw' },
  { id: 'highlight', icon: '▰', label: 'Highlight' },
  { id: 'underline', icon: 'U̲', label: 'Underline' },
  { id: 'strikeout', icon: 'S̶', label: 'Strike' },
  { id: 'whiteout', icon: '▢', label: 'Whiteout', feature: 'pdf_markup_advanced' },
  { id: 'stamp', icon: '🏷', label: 'Stamp', feature: 'stamps' },
  { id: 'signature', icon: '✍', label: 'Sign' },
  { id: 'initials', icon: '✒', label: 'Initials' },
  { id: 'date', icon: '📅', label: 'Date' },
  { id: 'note', icon: '💬', label: 'Note' },
  { id: 'line', icon: '／', label: 'Line' },
  { id: 'rect', icon: '▭', label: 'Box' },
];

const FIELD_TYPES = [
  ['text', 'Text'], ['signature', 'Signature'], ['initials', 'Initials'], ['date', 'Date'],
  ['checkbox', 'Checkbox'], ['radio', 'Radio'], ['dropdown', 'Dropdown'],
  ['image', 'Image'], ['attachment', 'Attachment'],
];

export function editor(navigate, route) {
  const docId = route.parts[1];
  const root = h('div', {}, h('div', { class: 'empty' }, 'Opening document…'));

  const ed = {
    doc: null, pages: [], annotations: [], formfields: [], activities: [], comments: [], signRequests: [],
    sourceUrl: null, pdf: null, scale: 1.25, tool: 'select', current: 0, selected: null,
    mode: 'markup', // markup | fields
    dirty: new Map(), tab: 'props',
  };

  async function load() {
    const res = await get(`/api/v1/documents/${docId}`).catch(async (err) => {
      if (err.payload?.password_required) {
        const pw = await askPassword(docId);
        if (pw) return get(`/api/v1/documents/${docId}`);
      }
      throw err;
    });
    Object.assign(ed, {
      doc: res.document, pages: res.document.pages, annotations: res.annotations,
      formfields: res.formfields, activities: res.activities, comments: res.comments,
      signRequests: res.sign_requests,
    });
    if (res.document.source_id) ed.sourceUrl = `/api/v1/sources/${res.document.source_id}/blob`;
    if (ed.sourceUrl) {
      try {
        const pdfjs = await loadPdfjs();
        const data = await (await fetch(ed.sourceUrl)).arrayBuffer();
        ed.pdf = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
      } catch { toast('Could not render the source file; showing blank pages', 'bad'); }
    }
    render();
    connectCable(docId, {
      'annotations.changed': async (p) => { if (p.by === state.user.id) return; await reloadLight(); },
      'formfields.changed': async (p) => { if (p.by === state.user.id) return; await reloadLight(); },
      'activity': async () => { const r = await get(`/api/v1/documents/${docId}`); ed.activities = r.activities; if (ed.tab === 'activity') renderInspector(); },
    });
  }

  async function reloadLight() {
    const r = await get(`/api/v1/documents/${docId}`);
    ed.annotations = r.annotations; ed.formfields = r.formfields;
    ed.pages = r.document.pages; ed.comments = r.comments;
    renderStage(); renderInspector();
  }

  // ---------- persistence ----------
  async function saveAnnotations({ created = [], updated = [], deleted = [] }) {
    const r = await post('/api/v1/annotations/update-many',
      { document_id: docId, created, updated, deleted });
    ed.annotations = r.annotations;
  }
  const saveFields = async (fields) => {
    const r = await post('/api/v1/formfields/update-many', { document_id: docId, formfields: fields });
    ed.formfields = r.formfields;
  };

  // ---------- shell ----------
  let stageHost, thumbHost, inspectorHost, headHost;
  function render() {
    clear(root);
    headHost = h('div', { class: 'editor-head' });
    thumbHost = h('aside', { class: 'thumbs' });
    stageHost = h('div', { class: 'canvas-wrap' });
    inspectorHost = h('aside', { class: 'inspector' });
    add(root, headHost,
      h('div', { class: 'toolbar' }, ...toolbarItems()),
      h('div', { class: 'editor' }, thumbHost, stageHost, inspectorHost));
    renderHead(); renderThumbs(); renderStage(); renderInspector();
  }

  function renderHead() {
    clear(headHost);
    const name = h('div', { class: 'doc-name', contenteditable: 'true' }, ed.doc.title);
    name.addEventListener('blur', async () => {
      const t = name.textContent.trim();
      if (t && t !== ed.doc.title) { await patch(`/api/v1/documents/${docId}`, { title: t }); ed.doc.title = t; toast('Renamed'); }
    });
    add(headHost, 
      h('a', { class: 'btn ghost sm', href: '#/documents' }, '← Documents'),
      name,
      ed.doc.state === 'completed' ? h('span', { class: 'badge good' }, 'Completed') : null,
      ed.doc.certified_at ? h('span', { class: 'badge info', title: ed.doc.certificate_hash }, 'Certified') : null,
      ed.doc.password_protected ? h('span', { class: 'badge warn' }, '🔒 Protected') : null,
      h('div', { class: 'spacer' }),
      h('div', { class: 'zoom' },
        h('button', { class: 'btn ghost sm', onclick: () => { ed.scale = Math.max(0.4, ed.scale - 0.15); renderStage(); } }, '−'),
        h('span', { class: 'sub' }, `${Math.round(ed.scale * 80)}%`),
        h('button', { class: 'btn ghost sm', onclick: () => { ed.scale = Math.min(3, ed.scale + 0.15); renderStage(); } }, '＋')),
      h('button', { class: 'btn sm', onclick: exportPdf }, '⤓ Download'),
      h('button', { class: 'btn sm', onclick: () => sendForSignatureModal(ed, reloadLight) }, '✍ Send for signature'),
      h('button', { class: 'btn primary sm', onclick: completeDoc }, '✓ Complete & save'));
  }

  function toolbarItems() {
    const items = [
      h('button', { class: `tool ${ed.mode === 'markup' ? 'on' : ''}`, onclick: () => { ed.mode = 'markup'; render(); } },
        h('span', { class: 'ic' }, '✏️'), 'Markup'),
      h('button', { class: `tool ${ed.mode === 'fields' ? 'on' : ''}`, onclick: () => { ed.mode = 'fields'; render(); } },
        h('span', { class: 'ic' }, '🧾'), 'Fields'),
      h('div', { class: 'tool-sep' }),
    ];
    if (ed.mode === 'markup') {
      for (const t of TOOLS) {
        const locked = t.feature && !can(t.feature);
        items.push(h('button', {
          class: `tool ${ed.tool === t.id ? 'on' : ''} ${locked ? 'locked' : ''}`,
          title: locked ? `${t.label} — upgrade required` : t.label,
          onclick: () => {
            if (locked) return showPaywall({ message: `${t.label} is a paid feature`, feature: t.feature, required_plan: t.feature === 'stamps' ? 'basic' : 'basic' });
            ed.tool = t.id; renderStage(); refreshToolbar();
          },
        }, h('span', { class: 'ic' }, t.icon), locked ? `${t.label} 🔒` : t.label));
      }
    } else {
      for (const [id, label] of FIELD_TYPES) {
        const locked = id === 'attachment' && !can('attachment_fields');
        items.push(h('button', {
          class: `tool ${ed.tool === `field:${id}` ? 'on' : ''} ${locked ? 'locked' : ''}`,
          onclick: () => {
            if (locked) return showPaywall({ message: 'Attachment fields are a Pro feature', feature: 'attachment_fields', required_plan: 'pro' });
            ed.tool = `field:${id}`; refreshToolbar();
          },
        }, h('span', { class: 'ic' }, '▭'), locked ? `${label} 🔒` : label));
      }
      items.push(h('div', { class: 'tool-sep' }),
        h('button', { class: 'tool', onclick: () => { ed.tool = 'select'; refreshToolbar(); } },
          h('span', { class: 'ic' }, '⬚'), 'Select'));
    }
    return items;
  }
  function refreshToolbar() {
    const bar = root.querySelector('.toolbar');
    clear(bar).append(...toolbarItems());
  }

  // ---------- thumbnails ----------
  async function renderThumbs() {
    clear(thumbHost);
    for (const [i, p] of ed.pages.entries()) {
      const canvas = h('canvas', { width: 100, height: 130 });
      const box = h('div', { class: `thumb ${i === ed.current ? 'on' : ''}`, onclick: () => {
        ed.current = i; renderStage(); renderThumbs();
        stageHost.querySelector(`[data-page-index="${i}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } }, canvas, h('span', { class: 'thumb-n' }, i + 1));
      const tools = h('div', { class: 'thumb-tools' },
        h('button', { title: 'Rotate', onclick: async (e) => { e.stopPropagation(); await rotate(p); } }, '↻'),
        h('button', { title: 'Duplicate', onclick: async (e) => {
          e.stopPropagation();
          const r = await post('/api/v1/pages/duplicate', { page_id: p.id });
          ed.pages = r.pages; renderThumbs(); renderStage();
        } }, '⧉'),
        h('button', { title: 'Move up', onclick: async (e) => { e.stopPropagation(); await move(i, -1); } }, '↑'),
        h('button', { title: 'Move down', onclick: async (e) => { e.stopPropagation(); await move(i, 1); } }, '↓'),
        h('button', { title: 'Delete page', onclick: async (e) => {
          e.stopPropagation();
          if (ed.pages.length === 1) return toast('A document needs at least one page', 'bad');
          if (!await confirmModal('Delete page?', `Page ${i + 1} will be removed.`, 'Delete')) return;
          const r = await post('/api/v1/pages/update-many', { document_id: docId, pages: [{ id: p.id, deleted: true }] });
          ed.pages = r.pages; ed.current = 0; renderThumbs(); renderStage();
        } }, '🗑'));
      thumbHost.append(h('div', {}, box, tools));
      paintPage(canvas, p, 100 / (p.width || 612)).catch(() => {});
    }
    thumbHost.append(h('button', { class: 'btn sm', style: { width: '100%', justifyContent: 'center' },
      onclick: async () => {
        const r = await post('/api/v1/pages/insert-blank', { document_id: docId, position: ed.pages.length });
        ed.pages = r.pages; renderThumbs(); renderStage();
      } }, '＋ Blank page'));
  }

  const rotate = async (p) => {
    const r = await post('/api/v1/pages/update-many',
      { document_id: docId, pages: [{ id: p.id, rotation: ((p.rotation || 0) + 90) % 360 }] });
    ed.pages = r.pages; renderThumbs(); renderStage();
  };
  const move = async (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= ed.pages.length) return;
    const a = ed.pages[i], b = ed.pages[j];
    const r = await post('/api/v1/pages/update-many',
      { document_id: docId, pages: [{ id: a.id, position: b.position }, { id: b.id, position: a.position }] });
    ed.pages = r.pages; ed.current = j; renderThumbs(); renderStage();
  };

  // ---------- page painting ----------
  async function paintPage(canvas, page, scale) {
    const w = (page.width || 612) * scale, hh = (page.height || 792) * scale;
    const rot = page.rotation || 0;
    const swap = rot % 180 !== 0;
    canvas.width = Math.round(swap ? hh : w);
    canvas.height = Math.round(swap ? w : hh);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (ed.pdf && page.source_page_index != null && page.source_page_index < ed.pdf.numPages) {
      const pg = await ed.pdf.getPage(page.source_page_index + 1);
      const viewport = pg.getViewport({ scale, rotation: rot });
      canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
      await pg.render({ canvasContext: ctx, viewport }).promise;
    } else {
      ctx.strokeStyle = '#eceff4'; ctx.lineWidth = 1;
      for (let y = 36 * scale; y < canvas.height; y += 28 * scale) {
        ctx.beginPath(); ctx.moveTo(30 * scale, y); ctx.lineTo(canvas.width - 30 * scale, y); ctx.stroke();
      }
    }
  }

  // ---------- stage ----------
  function renderStage() {
    clear(stageHost);
    ed.pages.forEach((page, idx) => {
      const canvas = h('canvas', {});
      const annLayer = h('div', { class: 'ann-layer' });
      const stage = h('div', { class: 'page-stage', 'data-page-index': idx },
        canvas, annLayer);
      stage.addEventListener('mousedown', (e) => onStageDown(e, page, stage, idx));
      stageHost.append(stage);
      paintPage(canvas, page, ed.scale).then(() => {
        stage.style.width = `${canvas.width}px`;
        stage.style.height = `${canvas.height}px`;
        paintAnnotations(annLayer, page, canvas.width, canvas.height);
      }).catch(() => {});
    });
  }

  function paintAnnotations(layer, page, pw, ph) {
    clear(layer);
    for (const a of ed.annotations.filter((x) => x.page_id === page.id)) layer.append(annNode(a, pw, ph));
    if (ed.mode === 'fields' || ed.formfields.length) {
      for (const f of ed.formfields.filter((x) => x.page_id === page.id)) layer.append(fieldNode(f, pw, ph));
    }
  }

  const px = (v, total) => `${v * total}px`;

  function annNode(a, pw, ph) {
    const d = JSON.parse(a.data || '{}');
    const node = h('div', {
      class: `ann ${ed.selected === a.id ? 'sel' : ''}`,
      style: { left: px(a.x, pw), top: px(a.y, ph), width: a.w ? px(a.w, pw) : 'auto', height: a.h ? px(a.h, ph) : 'auto' },
    });
    const inner = (() => {
      switch (a.type) {
        case 'text': {
          const t = h('div', { class: 'ann-text', style: {
            fontSize: `${(d.size || 14) * ed.scale}px`, color: d.color || '#16202f',
            fontFamily: d.font || 'Helvetica, Arial, sans-serif', fontWeight: d.bold ? '700' : '400',
            fontStyle: d.italic ? 'italic' : 'normal',
          } }, d.text || 'Text');
          t.addEventListener('dblclick', () => {
            t.contentEditable = 'true'; t.focus();
            t.addEventListener('blur', async () => {
              t.contentEditable = 'false';
              await saveAnnotations({ updated: [{ id: a.id, data: { ...d, text: t.textContent } }] });
            }, { once: true });
          });
          return t;
        }
        case 'highlight': return h('div', { style: { width: '100%', height: '100%',
          background: d.color || 'rgba(255,214,0,.42)', borderRadius: '2px' } });
        case 'whiteout': return h('div', { style: { width: '100%', height: '100%', background: '#fff' } });
        case 'underline': return h('div', { style: { width: '100%', height: '100%',
          borderBottom: `${Math.max(1, 2 * ed.scale)}px solid ${d.color || '#16202f'}` } });
        case 'strikeout': return h('div', { style: { width: '100%', height: '100%',
          borderTop: `${Math.max(1, 2 * ed.scale)}px solid ${d.color || '#f04438'}`,
          transform: 'translateY(50%)' } });
        case 'rect': return h('div', { style: { width: '100%', height: '100%',
          border: `${Math.max(1, 2 * ed.scale)}px solid ${d.color || '#f04438'}`, borderRadius: '2px' } });
        case 'line': return h('div', { style: { width: '100%', height: '0',
          borderTop: `${Math.max(1, 2 * ed.scale)}px solid ${d.color || '#16202f'}`, marginTop: px(a.h / 2, ph) } });
        case 'draw': return h('div', { html: `<svg viewBox="0 0 ${d.vw || 100} ${d.vh || 100}" width="100%" height="100%" preserveAspectRatio="none"><path d="${d.path || ''}" fill="none" stroke="${d.color || '#16202f'}" stroke-width="${d.width || 2}" stroke-linecap="round" stroke-linejoin="round"/></svg>` });
        case 'stamp': return h('div', { html: d.svg || '', style: { width: '100%', height: '100%' } });
        case 'signature': case 'initials':
          return d.png ? h('img', { src: d.png, style: { width: '100%', height: '100%', objectFit: 'contain' } })
                       : h('div', { html: d.svg || '', style: { width: '100%', height: '100%' } });
        case 'image': return h('img', { src: d.src, style: { width: '100%', height: '100%', objectFit: 'contain' } });
        case 'date': return h('div', { class: 'ann-text', style: { fontSize: `${13 * ed.scale}px` } }, d.text || '');
        case 'note': return h('div', { title: d.text || '', style: { fontSize: `${18 * ed.scale}px` } }, '💬');
        default: return h('div', {}, a.type);
      }
    })();
    node.append(inner);
    node.addEventListener('mousedown', (e) => {
      if (ed.tool !== 'select') return;
      e.stopPropagation();
      ed.selected = a.id;
      root.querySelectorAll('.ann.sel').forEach((n) => n.classList.remove('sel'));
      node.classList.add('sel');
      renderInspector();
      dragMove(e, node, a, pw, ph);
    });
    if (a.type === 'note') node.addEventListener('dblclick', () => noteModal(a, d));
    node.append(
      h('button', { class: 'del', onclick: async (e) => {
        e.stopPropagation();
        await saveAnnotations({ deleted: [a.id] });
        ed.selected = null; renderStage();
      } }, '×'),
      h('div', { class: 'handle', onmousedown: (e) => { e.stopPropagation(); dragResize(e, node, a, pw, ph); } }));
    return node;
  }

  function fieldNode(f, pw, ph) {
    const filled = !!f.value;
    const node = h('div', {
      class: `ff ${f.required ? 'required' : ''} ${filled ? 'filled' : ''}`,
      style: { left: px(f.x, pw), top: px(f.y, ph), width: px(f.w, pw), height: px(f.h, ph) },
    }, h('span', { class: 'ff-tag' }, `${f.name}${f.required ? ' *' : ''}${f.signer_role ? ` · ${f.signer_role}` : ''}`));

    const control = (() => {
      if (f.type === 'checkbox') return h('input', { type: 'checkbox', checked: f.value === 'true',
        onchange: (e) => saveFields([{ id: f.id, value: String(e.target.checked) }]).then(renderStage) });
      if (f.type === 'dropdown' || f.type === 'radio') {
        const opts = JSON.parse(f.options || '[]');
        return h('select', { onchange: (e) => saveFields([{ id: f.id, value: e.target.value }]).then(renderStage) },
          h('option', { value: '' }, '—'), ...opts.map((o) => h('option', { value: o, selected: f.value === o }, o)));
      }
      if (f.type === 'signature' || f.type === 'initials') {
        return h('button', { class: 'btn ghost sm', style: { width: '100%' }, onclick: async (e) => {
          e.stopPropagation();
          const sig = await signaturePad({ kind: f.type });
          if (!sig) return;
          await post(`/api/v1/documents/${docId}/self-sign`, {
            signature_id: sig.id, page_id: f.page_id, x: f.x, y: f.y, w: f.w, h: f.h, field_id: f.id,
          }).catch(() => {});
          await reloadLight();
        } }, filled ? 'Signed' : `Click to ${f.type === 'initials' ? 'initial' : 'sign'}`);
      }
      if (f.type === 'attachment') {
        return h('input', { type: 'file', style: { fontSize: '10px' }, onchange: async (e) => {
          const file = e.target.files[0]; if (!file) return;
          await saveFields([{ id: f.id, value: file.name }]);
          toast(`Attached ${file.name}`); renderStage();
        } });
      }
      return h('input', {
        type: f.type === 'date' ? 'date' : 'text', value: f.value || '', placeholder: f.placeholder || '',
        style: { width: '100%', fontSize: `${Math.max(9, f.font_size * ed.scale * 0.8)}px` },
        onchange: (e) => saveFields([{ id: f.id, value: e.target.value }]).catch(() => {}),
      });
    })();
    node.append(control);
    if (ed.mode === 'fields') {
      node.addEventListener('mousedown', (e) => {
        if (e.target !== node && e.target.tagName !== 'SPAN') return;
        e.stopPropagation(); ed.selected = f.id; renderInspector(); dragMove(e, node, f, pw, ph, 'field');
      });
      node.addEventListener('dblclick', (e) => { e.stopPropagation(); fieldSettings(f); });
      node.append(h('div', { class: 'handle', onmousedown: (e) => { e.stopPropagation(); dragResize(e, node, f, pw, ph, 'field'); } }));
    }
    return node;
  }

  // ---------- interaction ----------
  function dragMove(e, node, item, pw, ph, kind = 'ann') {
    const sx = e.clientX, sy = e.clientY, ox = item.x, oy = item.y;
    const onMove = (ev) => {
      item.x = Math.max(0, Math.min(1, ox + (ev.clientX - sx) / pw));
      item.y = Math.max(0, Math.min(1, oy + (ev.clientY - sy) / ph));
      node.style.left = px(item.x, pw); node.style.top = px(item.y, ph);
    };
    const onUp = async () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (kind === 'field') await saveFields([{ id: item.id, x: item.x, y: item.y }]);
      else await saveAnnotations({ updated: [{ id: item.id, x: item.x, y: item.y }] });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function dragResize(e, node, item, pw, ph, kind = 'ann') {
    const sx = e.clientX, sy = e.clientY, ow = item.w || 0.1, oh = item.h || 0.05;
    const onMove = (ev) => {
      item.w = Math.max(0.01, ow + (ev.clientX - sx) / pw);
      item.h = Math.max(0.008, oh + (ev.clientY - sy) / ph);
      node.style.width = px(item.w, pw); node.style.height = px(item.h, ph);
    };
    const onUp = async () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (kind === 'field') await saveFields([{ id: item.id, w: item.w, h: item.h }]);
      else await saveAnnotations({ updated: [{ id: item.id, w: item.w, h: item.h }] });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  async function onStageDown(e, page, stage, idx) {
    if (ed.tool === 'select') { ed.selected = null; root.querySelectorAll('.ann.sel').forEach((n) => n.classList.remove('sel')); return; }
    ed.current = idx;
    const rect = stage.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width, y = (e.clientY - rect.top) / rect.height;

    if (ed.tool.startsWith('field:')) {
      const type = ed.tool.split(':')[1];
      const n = ed.formfields.length + 1;
      const base = { page_id: page.id, type, name: `${type}_${n}`, x, y,
                     w: type === 'checkbox' ? 0.03 : 0.22, h: type === 'signature' ? 0.06 : 0.035 };
      if (type === 'dropdown' || type === 'radio') base.options = ['Option 1', 'Option 2'];
      const r = await post('/api/v1/formfields/create-many', { document_id: docId, formfields: [base] }).catch(() => null);
      if (r) { ed.formfields = r.formfields; renderStage(); }
      return;
    }

    if (ed.tool === 'draw') return freehand(e, page, stage);

    // drag-to-size markup tools
    const sized = ['highlight', 'underline', 'strikeout', 'whiteout', 'rect', 'line'];
    if (sized.includes(ed.tool)) return dragCreate(e, page, stage, ed.tool);

    const created = await buildAnnotation(ed.tool, page, x, y);
    if (!created) return;
    await saveAnnotations({ created: [created] });
    renderStage();
  }

  async function buildAnnotation(tool, page, x, y) {
    if (tool === 'text') return { page_id: page.id, type: 'text', x, y, w: 0.25, h: 0.03,
      data: { text: 'Type here', size: 14, color: '#16202f', font: 'Helvetica, Arial, sans-serif' } };
    if (tool === 'date') return { page_id: page.id, type: 'date', x, y, w: 0.14, h: 0.025,
      data: { text: new Date().toLocaleDateString() } };
    if (tool === 'note') return { page_id: page.id, type: 'note', x, y, w: 0.03, h: 0.03, data: { text: '' } };
    if (tool === 'image') {
      const src = await pickImage();
      if (!src) return null;
      return { page_id: page.id, type: 'image', x, y, w: 0.3, h: 0.2, data: { src } };
    }
    if (tool === 'stamp') {
      const svg = await pickStamp();
      if (!svg) return null;
      return { page_id: page.id, type: 'stamp', x, y, w: 0.24, h: 0.06, data: { svg } };
    }
    if (tool === 'signature' || tool === 'initials') {
      const sig = await signaturePad({ kind: tool });
      if (!sig) return null;
      // Self-signing is metered server-side, so route through the dedicated endpoint.
      await post(`/api/v1/documents/${docId}/self-sign`, {
        signature_id: sig.id, page_id: page.id, x, y,
        w: tool === 'initials' ? 0.08 : 0.2, h: 0.055,
      }).catch(() => {});
      await reloadLight();
      return null;
    }
    return null;
  }

  function dragCreate(e, page, stage, tool) {
    const rect = stage.getBoundingClientRect();
    const x0 = (e.clientX - rect.left) / rect.width, y0 = (e.clientY - rect.top) / rect.height;
    const ghost = h('div', { style: {
      position: 'absolute', left: `${x0 * rect.width}px`, top: `${y0 * rect.height}px`,
      border: '1px dashed var(--brand)', pointerEvents: 'none',
    } });
    stage.append(ghost);
    const onMove = (ev) => {
      const w = (ev.clientX - rect.left) / rect.width - x0, hh = (ev.clientY - rect.top) / rect.height - y0;
      ghost.style.width = `${Math.abs(w) * rect.width}px`;
      ghost.style.height = `${Math.abs(hh) * rect.height}px`;
      ghost.style.left = `${(w < 0 ? x0 + w : x0) * rect.width}px`;
      ghost.style.top = `${(hh < 0 ? y0 + hh : y0) * rect.height}px`;
    };
    const onUp = async (ev) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      ghost.remove();
      let w = (ev.clientX - rect.left) / rect.width - x0;
      let hh = (ev.clientY - rect.top) / rect.height - y0;
      let x = x0, y = y0;
      if (w < 0) { x += w; w = -w; }
      if (hh < 0) { y += hh; hh = -hh; }
      if (w < 0.004) w = 0.18;
      if (hh < 0.004) hh = tool === 'line' || tool === 'underline' || tool === 'strikeout' ? 0.012 : 0.03;
      const colors = { highlight: 'rgba(255,214,0,.42)', strikeout: '#f04438', rect: '#f04438' };
      await saveAnnotations({ created: [{ page_id: page.id, type: tool, x, y, w, h: hh,
        data: { color: colors[tool] || '#16202f' } }] });
      renderStage();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function freehand(e, page, stage) {
    const rect = stage.getBoundingClientRect();
    const pts = [];
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    Object.assign(svg.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#16202f');
    path.setAttribute('stroke-width', '2'); path.setAttribute('stroke-linecap', 'round');
    svg.append(path); stage.append(svg);
    const add = (ev) => {
      pts.push([ev.clientX - rect.left, ev.clientY - rect.top]);
      path.setAttribute('d', pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' '));
    };
    add(e);
    const onUp = async () => {
      document.removeEventListener('mousemove', add);
      document.removeEventListener('mouseup', onUp);
      svg.remove();
      if (pts.length < 2) return;
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const minX = Math.min(...xs), minY = Math.min(...ys);
      const w = Math.max(4, Math.max(...xs) - minX), hh = Math.max(4, Math.max(...ys) - minY);
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${(p[0] - minX).toFixed(1)} ${(p[1] - minY).toFixed(1)}`).join(' ');
      await saveAnnotations({ created: [{ page_id: page.id, type: 'draw',
        x: minX / rect.width, y: minY / rect.height, w: w / rect.width, h: hh / rect.height,
        data: { path: d, vw: w, vh: hh, color: '#16202f', width: 2 } }] });
      renderStage();
    };
    document.addEventListener('mousemove', add);
    document.addEventListener('mouseup', onUp);
  }

  // ---------- inspector ----------
  function renderInspector() {
    clear(inspectorHost);
    const tabs = [['props', 'Info'], ['fields', 'Fields'], ['comments', 'Comments'], ['ai', 'AI'], ['share', 'Share'], ['activity', 'Audit']];
    add(inspectorHost, h('div', { class: 'insp-tabs' },
      ...tabs.map(([id, label]) => h('button', { class: ed.tab === id ? 'on' : '',
        onclick: () => { ed.tab = id; renderInspector(); } }, label))));
    const body = h('div', { class: 'insp-body' });
    add(inspectorHost, body);
    ({ props: inspProps, fields: inspFields, comments: inspComments,
       ai: inspAi, share: inspShare, activity: inspActivity })[ed.tab](body);
  }

  function inspProps(body) {
    const sel = ed.annotations.find((a) => a.id === ed.selected);
    add(body, h('h3', {}, 'Document'),
      h('table', {}, h('tbody', {},
        row('Pages', ed.pages.length), row('State', ed.doc.state),
        row('Annotations', ed.annotations.length), row('Fields', ed.formfields.length),
        row('Updated', fmtDateTime(ed.doc.updated_at)),
        row('Certified', ed.doc.certified_at ? fmtDateTime(ed.doc.certified_at) : 'No'))),
      h('div', { class: 'row', style: { marginTop: '12px' } },
        h('button', { class: 'btn sm', onclick: certify }, '🔏 Certify'),
        h('button', { class: 'btn sm', onclick: passwordModal }, '🔒 Password'),
        h('button', { class: 'btn sm', onclick: faxModal }, '📠 Fax'),
        can('templates') ? h('button', { class: 'btn sm', onclick: async () => {
          await post(`/api/v1/documents/${docId}/save-as-template`, {}).catch(() => {});
          toast('Saved as template', 'good');
        } }, '🧩 Save as template') : null,
        h('button', { class: 'btn sm', onclick: () => exportOther('field_values') }, '⤓ Field CSV'),
        h('button', { class: 'btn sm', onclick: () => exportOther('audit') }, '⤓ Audit JSON')));

    if (sel) {
      const d = JSON.parse(sel.data || '{}');
      add(body, h('h3', { style: { marginTop: '18px' } }, `Selected: ${sel.type}`));
      if (['text', 'date'].includes(sel.type)) {
        const size = h('input', { type: 'number', value: d.size || 14, min: 6, max: 72 });
        const color = h('input', { type: 'color', value: d.color || '#16202f' });
        const font = h('select', {}, ...['Helvetica, Arial, sans-serif', 'Georgia, serif', 'Courier New, monospace',
          'Caveat, cursive'].map((f) => h('option', { value: f, selected: d.font === f }, f.split(',')[0])));
        const apply = async () => {
          await saveAnnotations({ updated: [{ id: sel.id,
            data: { ...d, size: Number(size.value), color: color.value, font: font.value } }] });
          renderStage();
        };
        size.onchange = color.onchange = font.onchange = apply;
        add(body, h('label', { class: 'field' }, h('span', {}, 'Size'), size),
          h('label', { class: 'field' }, h('span', {}, 'Colour'), color),
          h('label', { class: 'field' }, h('span', {}, 'Font'), font));
      }
      if (['highlight', 'rect', 'line', 'underline', 'strikeout', 'draw'].includes(sel.type)) {
        const color = h('input', { type: 'color', value: (d.color || '#16202f').startsWith('rgba') ? '#ffd600' : d.color });
        color.onchange = async () => {
          await saveAnnotations({ updated: [{ id: sel.id, data: { ...d, color: color.value } }] });
          renderStage();
        };
        add(body, h('label', { class: 'field' }, h('span', {}, 'Colour'), color));
      }
      add(body, h('button', { class: 'btn danger sm', onclick: async () => {
        await saveAnnotations({ deleted: [sel.id] }); ed.selected = null; renderStage(); renderInspector();
      } }, 'Delete element'));
    }
  }

  function inspFields(body) {
    add(body, h('h3', {}, `Form fields (${ed.formfields.length})`));
    if (!ed.formfields.length) {
      add(body, h('p', { class: 'sub' }, 'Switch to the Fields tool above, then click the page to place a field.'));
    }
    add(body, h('table', {}, h('tbody', {}, ...ed.formfields.map((f) => h('tr', {},
      h('td', {}, h('button', { class: 'btn ghost sm', onclick: () => fieldSettings(f) }, f.name)),
      h('td', {}, h('span', { class: 'badge' }, f.type)),
      h('td', {}, f.required ? h('span', { class: 'badge warn' }, 'Req') : ''),
      h('td', {}, h('button', { class: 'btn ghost sm', onclick: async () => {
        await post('/api/v1/formfields/delete-many', { document_id: docId, ids: [f.id] });
        ed.formfields = ed.formfields.filter((x) => x.id !== f.id); renderStage(); renderInspector();
      } }, '🗑')))))));
  }

  function inspComments(body) {
    add(body, h('h3', {}, 'Comments'));
    const input = h('textarea', { placeholder: 'Add a comment. Use @email to mention someone.' });
    add(body, h('div', { class: 'chat' }, ...ed.comments.map((c) => h('div', { class: 'msg assistant' },
      c.body, h('div', { class: 'msg-meta' }, fmtDateTime(c.created_at), c.resolved ? ' · resolved' : '')))),
      h('label', { class: 'field', style: { marginTop: '10px' } }, input),
      h('button', { class: 'btn primary sm', onclick: async () => {
        if (!input.value.trim()) return;
        await post('/api/v1/comments', { document_id: docId, body: input.value });
        input.value = ''; await reloadLight(); ed.tab = 'comments'; renderInspector();
      } }, 'Comment'));
  }

  function inspAi(body) {
    const eligible = can('ai_basic');
    add(body, h('h3', {}, 'DocHub Intelligence'));
    if (!eligible) {
      add(body, h('p', { class: 'sub' }, 'Your plan does not include the assistant.'),
        h('a', { class: 'btn primary sm', href: '#/pricing' }, 'See plans'));
      return;
    }
    const log = h('div', { class: 'chat' });
    const input = h('textarea', { placeholder: 'Ask about this document…', style: { minHeight: '60px' } });
    const pageText = async () => {
      if (!ed.pdf) return '';
      const chunks = [];
      for (let i = 1; i <= ed.pdf.numPages; i++) {
        const tc = await (await ed.pdf.getPage(i)).getTextContent();
        chunks.push(tc.items.map((it) => it.str).join(' '));
      }
      return chunks.join('\n\n');
    };
    const run = async (question, transform) => {
      log.append(h('div', { class: 'msg user' }, question || transform));
      const thinking = h('div', { class: 'msg assistant' }, '…');
      log.append(thinking);
      try {
        const res = await post('/api/v1/document-assistant-messages', {
          document_id: docId, question: question || '',
          transform: transform || null, page_text: await pageText(),
        });
        clear(thinking).append(res.answer,
          h('div', { class: 'msg-meta' }, `via ${res.provider}`));
      } catch { thinking.remove(); }
    };
    add(body, 
      h('div', { class: 'chip-row' },
        ...[['summarize', 'Summarize'], ['key_points', 'Key points'], ['explain', 'Explain'],
            ['risks', 'Risks & deadlines'], ['extract_fields', 'Find blanks']]
          .map(([t, label]) => h('button', { class: 'chip', onclick: () => run(null, t) }, label))),
      log,
      h('label', { class: 'field', style: { marginTop: '10px' } }, input),
      h('button', { class: 'btn primary sm', onclick: () => {
        const q = input.value.trim(); if (!q) return; input.value = ''; run(q, null);
      } }, 'Ask'),
      state.ai && !state.ai.credentials_present
        ? h('div', { class: 'note' }, `No model credentials in this deployment: answers come from the local extractive fallback. Set ANTHROPIC_API_KEY to use ${state.ai.model}.`)
        : null,
      meter('AI messages this month', state.usage.ai_messages));
  }

  function inspShare(body) {
    const emails = h('input', { type: 'text', placeholder: 'a@example.com, b@example.com' });
    const role = h('select', {}, h('option', { value: 'collaborator' }, 'Can edit'),
      h('option', { value: 'viewer' }, 'Can view'));
    add(body, h('h3', {}, 'Collaborators'),
      h('table', {}, h('tbody', {}, ...(ed.doc.roles || []).map((r) => h('tr', {},
        h('td', {}, r.email), h('td', {}, h('span', { class: 'badge' }, r.role)),
        h('td', {}, h('button', { class: 'btn ghost sm', onclick: async () => {
          await fetch(`/api/v1/document-roles/${r.id}`, { method: 'DELETE' });
          await reloadLight(); const d = await get(`/api/v1/documents/${docId}`); ed.doc = d.document; renderInspector();
        } }, '×')))))),
      h('label', { class: 'field', style: { marginTop: '12px' } }, h('span', {}, 'Invite by email'), emails),
      h('label', { class: 'field' }, h('span', {}, 'Permission'), role),
      h('button', { class: 'btn primary sm', onclick: async () => {
        const list = emails.value.split(',').map((s) => s.trim()).filter(Boolean);
        if (!list.length) return;
        try {
          await post('/api/v1/document-roles/create-with-emails',
            { document_id: docId, emails: list, role: role.value });
          emails.value = '';
          const d = await get(`/api/v1/documents/${docId}`); ed.doc = d.document;
          toast('Invitations recorded', 'good'); renderInspector();
        } catch {}
      } }, 'Share'),
      meter('Collaborators allowed', { used: (ed.doc.roles || []).length, limit: state.entitlements.limits.collaborators === null ? null : state.entitlements.limits.collaborators }),
      h('div', { class: 'note' }, 'Email delivery is recorded locally in this deployment (Settings → Email log), not sent.'));
  }

  function inspActivity(body) {
    add(body, h('h3', {}, 'Audit trail'),
      h('table', {}, h('tbody', {}, ...ed.activities.map((a) => h('tr', {},
        h('td', {}, h('div', {}, a.action), h('div', { class: 'sub', style: { fontSize: '11px' } },
          a.actor_email || '—')),
        h('td', { style: { whiteSpace: 'nowrap', fontSize: '11px' } }, fmtDateTime(a.created_at)))))),
      ...ed.signRequests.map((sr) => h('div', { class: 'card pad', style: { marginTop: '12px' } },
        h('strong', {}, sr.envelope_id), h('div', { class: 'sub' }, `${sr.mode} · ${sr.state}`),
        h('table', {}, h('tbody', {}, ...sr.signers.map((s) => h('tr', {},
          h('td', {}, s.email),
          h('td', {}, h('span', { class: `badge ${s.state === 'signed' ? 'good' : s.state === 'declined' ? 'bad' : 'warn'}` }, s.state)))))),
        sr.state !== 'completed' ? h('button', { class: 'btn sm', onclick: async () => {
          await post('/api/v1/sign-requests/resend-email', { sign_request_id: sr.id });
          toast('Reminder recorded', 'good');
        } }, 'Resend') : null)));
  }

  const row = (k, v) => h('tr', {}, h('td', { style: { color: 'var(--text-faint)' } }, k), h('td', {}, String(v)));

  // ---------- actions ----------
  async function completeDoc() {
    try {
      const r = await post(`/api/v1/documents/${docId}/complete`, {});
      ed.doc = r.document;
      toast('Document completed and saved', 'good');
      renderHead(); renderInspector();
      const p = await get('/api/v1/users/show-initial-payload');
      state.usage = p.usage;
    } catch {}
  }

  async function certify() {
    try {
      const r = await post(`/api/v1/documents/${docId}/certify`, {});
      ed.doc.certified_at = r.certified_at; ed.doc.certificate_hash = r.certificate_hash;
      toast('Certified', 'good'); renderHead(); renderInspector();
    } catch {}
  }

  function passwordModal() {
    const pw = h('input', { type: 'password', placeholder: 'New password (blank to remove)' });
    const m = modal({ title: 'Document password',
      body: h('div', {}, h('label', { class: 'field' }, h('span', {}, 'Password'), pw),
        h('p', { class: 'sub' }, 'Viewers other than you must enter this to open the document.')),
      footer: [h('button', { class: 'btn primary', onclick: async () => {
        try {
          const r = await post(`/api/v1/documents/${docId}/password`, { password: pw.value || null });
          ed.doc.password_protected = r.password_protected;
          m.close(); toast(r.password_protected ? 'Password set' : 'Password removed', 'good'); renderHead();
        } catch {}
      } }, 'Save')] });
  }

  function faxModal() {
    const num = h('input', { type: 'tel', placeholder: '+15551234567' });
    const m = modal({ title: 'Send by fax',
      body: h('div', {}, h('label', { class: 'field' }, h('span', {}, 'Destination fax number'), num),
        h('div', { class: 'note' }, 'Fax is a Pro feature (35 pages/month). No fax carrier is configured in this deployment, so the send is recorded and marked failed with no_carrier_configured.')),
      footer: [h('button', { class: 'btn primary', onclick: async () => {
        try {
          const r = await post('/api/v1/outbound-faxes', { document_id: docId, to_number: num.value });
          m.close();
          toast(r.outbound_fax.state === 'failed'
            ? `Recorded, not sent: ${r.outbound_fax.error}` : 'Fax queued',
            r.outbound_fax.state === 'failed' ? 'bad' : 'good');
        } catch {}
      } }, 'Send fax')] });
  }

  async function exportOther(kind) {
    try {
      const r = await post('/api/v1/export-tasks', { document_id: docId, kind });
      if (!r.content) return toast(r.note || 'Export queued');
      download(new Blob([r.content], { type: 'text/plain' }), r.filename);
    } catch {}
  }

  /** Flatten the rendered pages plus annotations into a downloadable PDF. */
  async function exportPdf() {
    toast('Building PDF…');
    try {
      const { PDFDocument } = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.esm.min.js');
      const out = await PDFDocument.create();
      for (const [i, page] of ed.pages.entries()) {
        // Rasterise at 2x so annotations are baked in exactly as shown.
        const canvas = document.createElement('canvas');
        await paintPage(canvas, page, 2);
        const layer = h('div', { class: 'ann-layer' });
        document.body.append(layer);
        layer.style.cssText = `position:fixed;left:-99999px;width:${canvas.width}px;height:${canvas.height}px`;
        paintAnnotations(layer, page, canvas.width, canvas.height);
        await rasteriseOverlay(canvas, layer, page);
        layer.remove();
        const png = await out.embedPng(canvas.toDataURL('image/png'));
        const p = out.addPage([canvas.width / 2, canvas.height / 2]);
        p.drawImage(png, { x: 0, y: 0, width: canvas.width / 2, height: canvas.height / 2 });
      }
      download(new Blob([await out.save()], { type: 'application/pdf' }), `${ed.doc.title}.pdf`);
      toast('Downloaded', 'good');
    } catch (err) {
      toast(`Export failed: ${err.message}`, 'bad');
    }
  }

  /** Draw annotation + field values onto the page canvas for export. */
  async function rasteriseOverlay(canvas, layer, page) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    for (const a of ed.annotations.filter((x) => x.page_id === page.id)) {
      const d = JSON.parse(a.data || '{}');
      const x = a.x * W, y = a.y * H, w = a.w * W, hh = a.h * H;
      ctx.save();
      switch (a.type) {
        case 'highlight': ctx.fillStyle = d.color || 'rgba(255,214,0,.42)'; ctx.fillRect(x, y, w, hh); break;
        case 'whiteout': ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, hh); break;
        case 'rect': ctx.strokeStyle = d.color || '#f04438'; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, hh); break;
        case 'underline': ctx.strokeStyle = d.color || '#16202f'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(x, y + hh); ctx.lineTo(x + w, y + hh); ctx.stroke(); break;
        case 'strikeout': ctx.strokeStyle = d.color || '#f04438'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(x, y + hh / 2); ctx.lineTo(x + w, y + hh / 2); ctx.stroke(); break;
        case 'line': ctx.strokeStyle = d.color || '#16202f'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(x, y + hh / 2); ctx.lineTo(x + w, y + hh / 2); ctx.stroke(); break;
        case 'text': case 'date':
          ctx.fillStyle = d.color || '#16202f';
          ctx.font = `${d.bold ? '700 ' : ''}${(d.size || 14) * 2}px ${d.font || 'Helvetica'}`;
          ctx.textBaseline = 'top';
          (d.text || '').split('\n').forEach((line, i) => ctx.fillText(line, x, y + i * (d.size || 14) * 2.4));
          break;
        case 'draw': case 'stamp': case 'signature': case 'initials': case 'image': {
          const markup = a.type === 'draw'
            ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${d.vw || 100} ${d.vh || 100}" width="${w}" height="${hh}"><path d="${d.path}" fill="none" stroke="${d.color || '#16202f'}" stroke-width="${d.width || 2}" stroke-linecap="round"/></svg>`
            : a.type === 'stamp' ? d.svg : (d.png || d.src || d.svg);
          await drawImageSource(ctx, markup, x, y, w, hh);
          break;
        }
        case 'note':
          ctx.fillStyle = '#f79009'; ctx.beginPath();
          ctx.arc(x + w / 2, y + hh / 2, Math.max(6, w / 2), 0, Math.PI * 2); ctx.fill();
          break;
      }
      ctx.restore();
    }
    for (const f of ed.formfields.filter((x) => x.page_id === page.id)) {
      if (!f.value) continue;
      ctx.save();
      ctx.fillStyle = '#16202f';
      ctx.font = `${f.font_size * 2}px Helvetica`;
      ctx.textBaseline = 'middle';
      const text = f.type === 'checkbox' ? (f.value === 'true' ? '✓' : '') : f.value;
      ctx.fillText(String(text), f.x * W + 4, f.y * H + (f.h * H) / 2);
      ctx.restore();
    }
  }

  function drawImageSource(ctx, src, x, y, w, hh) {
    return new Promise((resolve) => {
      if (!src) return resolve();
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, x, y, w, hh); resolve(); };
      img.onerror = () => resolve();
      img.src = src.trim().startsWith('<svg')
        ? `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(src)))}` : src;
    });
  }

  function noteModal(a, d) {
    const t = h('textarea', { value: d.text || '' });
    const m = modal({ title: 'Note', body: h('label', { class: 'field' }, t),
      footer: [h('button', { class: 'btn primary', onclick: async () => {
        await saveAnnotations({ updated: [{ id: a.id, data: { ...d, text: t.value } }] });
        m.close(); renderStage();
      } }, 'Save')] });
  }

  function fieldSettings(f) {
    const name = h('input', { type: 'text', value: f.name });
    const required = h('input', { type: 'checkbox', checked: !!f.required });
    const readonly = h('input', { type: 'checkbox', checked: !!f.readonly });
    const placeholder = h('input', { type: 'text', value: f.placeholder || '' });
    const role = h('input', { type: 'text', value: f.signer_role || '', placeholder: 'e.g. Signer 1' });
    const validation = h('select', {}, ...['none', 'email', 'number', 'phone', 'zip', 'date', 'ssn', 'regex']
      .map((v) => h('option', { value: v, selected: f.validation === v }, v)));
    const pattern = h('input', { type: 'text', value: f.validation_pattern || '', placeholder: '^[A-Z]{3}$' });
    const options = h('input', { type: 'text', value: JSON.parse(f.options || '[]').join(', ') });
    const smart = h('select', {}, ...['', 'signer.email', 'signer.name', 'date.today', 'sender.name', 'sender.email']
      .map((v) => h('option', { value: v, selected: f.smart_field === v }, v || '— none —')));
    const m = modal({ title: `Field: ${f.name}`, body: h('div', {},
      h('label', { class: 'field' }, h('span', {}, 'Name'), name),
      h('label', { class: 'field' }, h('span', {}, 'Placeholder'), placeholder),
      h('label', { class: 'field' }, h('span', {}, 'Assigned signer role'), role),
      h('label', { class: 'field' }, h('span', {}, 'Validation',
        can('advanced_validation') ? null : h('span', { class: 'hint' }, ' — Pro')), validation),
      h('label', { class: 'field' }, h('span', {}, 'Pattern (regex validation)'), pattern),
      ['dropdown', 'radio'].includes(f.type)
        ? h('label', { class: 'field' }, h('span', {}, 'Options (comma separated)'), options) : null,
      h('label', { class: 'field' }, h('span', {}, 'Smart field (auto-fill)'), smart),
      h('label', { class: 'check' }, required, h('span', {}, 'Required')),
      h('label', { class: 'check' }, readonly, h('span', {}, 'Read only'))),
      footer: [h('button', { class: 'btn primary', onclick: async () => {
        try {
          await saveFields([{ id: f.id, name: name.value, placeholder: placeholder.value,
            required: required.checked, validation: validation.value,
            signer_role: role.value || null,
            options: ['dropdown', 'radio'].includes(f.type)
              ? options.value.split(',').map((s) => s.trim()).filter(Boolean) : undefined }]);
          m.close(); renderStage(); renderInspector();
        } catch {}
      } }, 'Save field')] });
  }

  load().catch(() => { add(clear(root), h('div', { class: 'empty' }, 'Could not open this document.')); });
  return root;
}

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function pickImage() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'image/*' });
    input.onchange = () => {
      const f = input.files[0];
      if (!f) return resolve(null);
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.readAsDataURL(f);
    };
    input.click();
  });
}

async function pickStamp() {
  const { stamps, categories } = await get('/api/v1/stamps');
  return new Promise((resolve) => {
    let cat = categories[0];
    const grid = h('div', { class: 'stamp-grid' });
    const paint = () => {
      clear(grid);
      for (const s of stamps.filter((x) => x.category === cat).slice(0, 180)) {
        grid.append(h('button', { html: s.svg, title: s.name,
          onclick: () => { m.close(); resolve(s.svg); } }));
      }
    };
    const m = modal({ title: `Stamps (${stamps.length})`, wide: true,
      body: h('div', {},
        h('div', { class: 'tabs' }, ...categories.map((c) => h('button', {
          class: c === cat ? 'on' : '', onclick: (e) => {
            cat = c; m.el.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('on'));
            e.target.classList.add('on'); paint();
          } }, c))),
        grid),
      onClose: () => resolve(null) });
    paint();
  });
}

function askPassword(docId) {
  return new Promise((resolve) => {
    const pw = h('input', { type: 'password' });
    const m = modal({ title: 'Password required',
      body: h('label', { class: 'field' }, h('span', {}, 'This document is protected'), pw),
      footer: [h('button', { class: 'btn primary', onclick: async () => {
        try { await post(`/api/v1/documents/${docId}/unlock`, { password: pw.value }); m.close(); resolve(true); }
        catch {}
      } }, 'Unlock')], onClose: () => resolve(false) });
  });
}
