import { h, clear, toast, modal, fmtDate, meter, confirmModal, add } from '../ui.js';
import { get, post, del, patch } from '../api.js';
import { state, can, refresh } from '../store.js';

const SCOPES = [
  { id: 'documents', label: 'All documents', icon: '📄' },
  { id: 'inbox', label: 'Shared with me', icon: '📥' },
  { id: 'sent', label: 'Sent for signature', icon: '📤' },
  { id: 'templates', label: 'Templates', icon: '🧩' },
  { id: 'trash', label: 'Trash', icon: '🗑️' },
];

export function dashboard(navigate, route) {
  const scope = route.params.get('scope') || 'documents';
  const folderId = route.params.get('folder') || '';
  const main = h('div', { class: 'main' }, h('div', { class: 'empty' }, 'Loading…'));
  const side = h('aside', { class: 'sidebar' });
  const wrap = h('div', { class: 'layout' }, side, main);

  async function load() {
    const [listRes, foldersRes, statsRes, labelsRes] = await Promise.all([
      get(`/api/v1/documents?scope=${scope}${folderId ? `&folder_id=${folderId}` : ''}`),
      get('/api/v1/folders'), get('/api/v1/entities/dashboard-stats'), get('/api/v1/doc-labels'),
    ]);
    renderSide(foldersRes.folders, statsRes.stats, labelsRes.doc_labels);
    renderMain(listRes.documents);
  }

  function renderSide(folders, stats, labels) {
    clear(side);
    add(side, 
      h('button', { class: 'btn primary', style: { width: '100%', justifyContent: 'center', marginBottom: '16px' },
                    onclick: () => newDocumentModal(navigate) }, '＋ New document'),
      h('div', { class: 'side-group' },
        ...SCOPES.map((s) => h('a', {
          class: `side-item ${scope === s.id && !folderId ? 'on' : ''}`, href: `#/documents?scope=${s.id}`,
        }, h('span', {}, s.icon), h('span', {}, s.label),
           s.id === 'documents' ? h('span', { class: 'count' }, stats.documents) :
           s.id === 'templates' ? h('span', { class: 'count' }, stats.templates) :
           s.id === 'inbox' ? h('span', { class: 'count' }, stats.shared_with_me) : null))),
      h('div', { class: 'side-group' },
        h('div', { class: 'side-label' }, 'Folders'),
        ...folders.map((f) => h('a', {
          class: `side-item ${folderId === f.id ? 'on' : ''}`, href: `#/documents?scope=documents&folder=${f.id}`,
        }, h('span', { style: { color: f.color } }, '▪'), h('span', {}, f.name))),
        h('button', { class: 'side-item', onclick: newFolder }, h('span', {}, '＋'), h('span', {}, 'New folder'))),
      labels.length ? h('div', { class: 'side-group' },
        h('div', { class: 'side-label' }, 'Labels'),
        ...labels.map((l) => h('a', { class: 'side-item', href: `#/documents?scope=documents&label=${l.id}` },
          h('span', { style: { color: l.color } }, '●'), h('span', {}, l.name)))) : null,
      usagePanel());
  }

  /** Usage card. Metrics with no cap report limit null, so an entirely
   *  uncapped plan has no quota to show and the card is omitted. */
  function usagePanel() {
    const metered = [
      ['Documents completed', state.usage.documents_completed],
      ['Self-signatures', state.usage.self_signatures],
      ['Signature requests', state.usage.sign_requests],
      ['AI messages', state.usage.ai_messages],
    ].filter(([, m]) => m && m.limit != null);
    if (!metered.length) return null;
    return h('div', { class: 'card pad', style: { marginTop: '8px' } },
      h('div', { class: 'side-label', style: { padding: '0 0 8px' } }, `${state.entitlements.label} plan usage`),
      ...metered.map(([label, m]) => meter(label, m)),
      state.entitlements.plan === 'site_license' ? null
        : h('a', { class: 'btn sm', href: '#/pricing', style: { width: '100%', justifyContent: 'center' } }, 'Compare plans'));
  }

  async function newFolder() {
    const name = h('input', { type: 'text', placeholder: 'Folder name' });
    const m = modal({
      title: 'New folder', body: h('label', { class: 'field' }, h('span', {}, 'Name'), name),
      footer: [h('button', { class: 'btn primary', onclick: async () => {
        try { await post('/api/v1/folders', { name: name.value || 'New folder' }); m.close(); load(); }
        catch {}
      } }, 'Create folder')],
    });
  }

  function renderMain(docs) {
    clear(main);
    const search = h('input', { type: 'text', placeholder: 'Search documents…', style: { maxWidth: '260px' },
      oninput: debounce(async (e) => {
        const q = e.target.value.trim();
        const res = q ? await get(`/api/v1/documents?scope=${scope}&q=${encodeURIComponent(q)}`)
                      : await get(`/api/v1/documents?scope=${scope}`);
        renderGrid(res.documents);
      }, 250) });
    const gridWrap = h('div', {});
    add(main, 
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, SCOPES.find((s) => s.id === scope)?.label || 'Documents'),
          h('p', { class: 'sub' }, `${docs.length} item${docs.length === 1 ? '' : 's'}`)),
        h('div', { class: 'spacer' }), search,
        h('button', { class: 'btn', onclick: () => newDocumentModal(navigate) }, 'Upload')),
      gridWrap);

    function renderGrid(list) {
      clear(gridWrap);
      if (!list.length) {
        gridWrap.append(h('div', { class: 'empty card' },
          h('div', { class: 'big' }, '📄'),
          h('p', {}, 'Nothing here yet.'),
          h('button', { class: 'btn primary', onclick: () => newDocumentModal(navigate) }, 'Add a document')));
        return;
      }
      gridWrap.append(h('div', { class: 'grid' }, ...list.map((d) => docCard(d, navigate, load))));
    }
    renderGrid(docs);
  }

  load().catch(() => {});
  return wrap;
}

function docCard(d, navigate, reload) {
  const badge = d.state === 'completed' ? h('span', { class: 'badge good' }, 'Completed')
    : d.state === 'trashed' ? h('span', { class: 'badge bad' }, 'Trashed')
    : d.is_template ? h('span', { class: 'badge info' }, 'Template')
    : h('span', { class: 'badge' }, 'Draft');
  return h('div', { class: 'doc-card' },
    h('button', { class: 'doc-thumb', style: { border: 'none', width: '100%' },
                  onclick: () => navigate(`#/d/${d.id}`) },
      d.password_protected ? '🔒' : '📄'),
    h('div', { class: 'doc-meta' },
      h('p', { class: 'doc-title', title: d.title }, d.title),
      h('div', { class: 'doc-sub' }, `${d.page_count} page${d.page_count === 1 ? '' : 's'} · ${fmtDate(d.updated_at)}`),
      h('div', { class: 'row', style: { marginTop: '8px' } }, badge,
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn ghost sm', title: 'Delete', onclick: async () => {
          if (!await confirmModal('Move to trash?', `"${d.title}" will be moved to trash.`, 'Move to trash')) return;
          await post('/api/v1/documents/batch-delete', { ids: [d.id] });
          toast('Moved to trash'); reload();
        } }, '🗑'))));
}

export function newDocumentModal(navigate) {
  const file = h('input', { type: 'file', accept: 'application/pdf,image/*' });
  const url = h('input', { type: 'text', placeholder: 'https://example.com/form.pdf' });
  const status = h('div', { class: 'sub' });
  let m;

  const importBuffer = async (buf, filename, mime) => {
    status.textContent = 'Reading document…';
    const b64 = btoa(Array.from(new Uint8Array(buf)).map((c) => String.fromCharCode(c)).join(''));
    const { source } = await post('/api/v1/s3-direct', { filename, mime, data_base64: b64 });
    // Page geometry is read client-side with pdf.js so the server stays format-agnostic.
    let pageCount = 1, pageSizes = null;
    if (mime === 'application/pdf') {
      const pdfjs = await loadPdfjs();
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
      pageCount = pdf.numPages;
      pageSizes = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
        pageSizes.push({ width: vp.width, height: vp.height });
      }
    }
    const { document: doc } = await post('/api/v1/documents/create-with-source',
      { source_id: source.id, title: filename.replace(/\.[a-z0-9]+$/i, ''), page_count: pageCount, page_sizes: pageSizes });
    m.close();
    navigate(`#/d/${doc.id}`);
  };

  m = modal({
    title: 'New document',
    body: h('div', {},
      h('div', { class: 'tabs' },
        h('button', { class: 'on' }, 'Upload'),
      ),
      h('label', { class: 'field' }, h('span', {}, 'Choose a PDF or image'), file),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: async () => {
          const { document: doc } = await post('/api/v1/documents/create-blank', { title: 'Blank document', page_count: 1 });
          m.close(); navigate(`#/d/${doc.id}`);
        } }, '＋ Start blank'),
        can('templates') ? h('button', { class: 'btn', onclick: async () => {
          const { documents } = await get('/api/v1/documents?scope=templates');
          if (!documents.length) return toast('You have no templates yet', 'bad');
          const sel = h('select', {}, ...documents.map((d) => h('option', { value: d.id }, d.title)));
          const t = modal({ title: 'From template', body: h('label', { class: 'field' }, h('span', {}, 'Template'), sel),
            footer: [h('button', { class: 'btn primary', onclick: async () => {
              const { document: doc } = await post('/api/v1/documents/create-with-template', { template_id: sel.value });
              t.close(); m.close(); navigate(`#/d/${doc.id}`);
            } }, 'Create')] });
        } }, '🧩 From template') : null),
      h('hr', { style: { border: 'none', borderTop: '1px solid var(--border)', margin: '18px 0' } }),
      h('label', { class: 'field' }, h('span', {}, 'Or import from a URL',
        h('span', { class: 'hint' }, ' — the only cloud path that works without OAuth credentials')), url),
      h('button', { class: 'btn', onclick: async () => {
        if (!url.value) return toast('Enter a URL', 'bad');
        status.textContent = 'Fetching…';
        try {
          const res = await post('/api/v1/import-source-url-tasks', { url: url.value });
          const bin = Uint8Array.from(atob(res.data_base64), (c) => c.charCodeAt(0));
          await importBuffer(bin.buffer, url.value.split('/').pop() || 'import.pdf',
            res.content_type.includes('pdf') ? 'application/pdf' : res.content_type);
        } catch { status.textContent = ''; }
      } }, 'Import from URL'),
      h('div', { class: 'note' },
        'Google Drive, Gmail, Dropbox, OneDrive, Box and Classroom appear in Settings → Integrations. '
        + 'They need OAuth credentials, which this deployment does not have, so file pickers are unavailable.'),
      status),
  });

  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    try { await importBuffer(await f.arrayBuffer(), f.name, f.type || 'application/pdf'); }
    catch { status.textContent = ''; }
  });
  return m;
}

let pdfjsPromise = null;
export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs').then((m) => {
      m.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';
      return m;
    });
  }
  return pdfjsPromise;
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
