// Colorbook — all processing and storage happens locally in the browser.
import { buildBook, makePdf, cellAspect } from './compose.js';

const MAX_SIDE = 2400; // ~220 DPI across an 11" page: crisp lines when printed
const MAX_UPSCALE = 2.5; // small crops get enlarged so lines stay smooth
const DEFAULT_OPTS = { detail: 6, simplify: 4, thickness: 3, cleanup: 4, background: 'keep' };
const PRESETS = {
  toddler: { detail: 4, simplify: 6, thickness: 5.5, cleanup: 8, background: 'remove' },
  kids: { ...DEFAULT_OPTS, background: 'soft' },
  detailed: { detail: 8, simplify: 2.5, thickness: 2, cleanup: 2.5, background: 'keep' },
};
const SLIDERS = ['detail', 'simplify', 'thickness', 'cleanup'];
const SPINES = ['#ff6b6b', '#4dabf7', '#51cf66', '#9775fa', '#ff922b', '#ffd43b'];
const PAGE_ASPECT = 7.5 / 10; // printable area of a letter page with 1/2" margins
const FULL = { x: 0, y: 0, w: 1, h: 1 };

const $ = (id) => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// ---------------------------------------------------------------- storage
const db = await new Promise((resolve, reject) => {
  const req = indexedDB.open('coloring-book-maker', 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore('books', { keyPath: 'id' });
    req.result.createObjectStore('pages', { keyPath: 'id' });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r && r.result);
    t.onerror = () => reject(t.error);
  });
}
const dbAll = (store) => tx(store, 'readonly', (s) => s.getAll());
const dbPut = (store, v) => tx(store, 'readwrite', (s) => s.put(v));
const dbDel = (store, id) => tx(store, 'readwrite', (s) => s.delete(id));

function savePage(p) {
  const { _gen, ...rest } = p; // strip in-memory-only fields
  return dbPut('pages', rest);
}
function saveBook(b) {
  b.updated = Date.now();
  return dbPut('books', b);
}

// ---------------------------------------------------------------- state
const state = { books: [], pages: new Map(), bookId: null, pageId: null };
const book = () => state.books.find((b) => b.id === state.bookId);
const page = () => state.pages.get(state.pageId);

const urls = new Map(); // `${pageId}:kind` -> { blob, url }
function blobUrl(id, kind, blob) {
  const key = `${id}:${kind}`;
  const cached = urls.get(key);
  if (cached && cached.blob === blob) return cached.url;
  if (cached) URL.revokeObjectURL(cached.url);
  if (!blob) { urls.delete(key); return ''; }
  const url = URL.createObjectURL(blob);
  urls.set(key, { blob, url });
  return url;
}
const artUrl = (p) => blobUrl(p.id, 'art', p.artBlob);

// ---------------------------------------------------------------- geometry (rotate + crop)
const rotOf = (p) => p.rot || 0;
const cropOf = (p) => p.crop || FULL;

function orient(bmp, rot) {
  if (!rot) return bmp;
  const swap = rot % 180 !== 0;
  const c = new OffscreenCanvas(swap ? bmp.height : bmp.width, swap ? bmp.width : bmp.height);
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
  return c;
}

// Size of the processed page image for this photo's rotation + crop
function outputSize(p) {
  const swap = rotOf(p) % 180 !== 0;
  const rw = swap ? p.h : p.w, rh = swap ? p.w : p.h;
  const cr = cropOf(p);
  const cw = cr.w * rw, ch = cr.h * rh;
  const s = Math.min(MAX_UPSCALE, MAX_SIDE / Math.max(cw, ch));
  return [Math.max(1, Math.round(cw * s)), Math.max(1, Math.round(ch * s))];
}

// Draw any-resolution version of the photo (or its mask) rotated + cropped into W x H
function renderOriented(bmp, p, W, H) {
  const o = orient(bmp, rotOf(p));
  const cr = cropOf(p);
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(o, cr.x * o.width, cr.y * o.height, cr.w * o.width, cr.h * o.height, 0, 0, W, H);
  return c;
}

// Cropped photo shown under the compare slider (kept in memory only)
const previews = new Map(); // pageId -> { key, blob }
async function srcPreviewUrl(p) {
  const key = JSON.stringify([rotOf(p), cropOf(p), p.srcBlob.size]);
  let pv = previews.get(p.id);
  if (!pv || pv.key !== key) {
    const [W, H] = outputSize(p);
    const s = Math.min(1, 1400 / Math.max(W, H));
    const bmp = await createImageBitmap(p.srcBlob);
    const c = renderOriented(bmp, p, Math.round(W * s), Math.round(H * s));
    bmp.close();
    pv = { key, blob: await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 }) };
    previews.set(p.id, pv);
  }
  return blobUrl(p.id, 'preview', pv.blob);
}

// ---------------------------------------------------------------- worker
const worker = new Worker('lineart-worker.js');
const jobs = new Map();
let jobSeq = 0;
worker.onmessage = (e) => {
  const job = jobs.get(e.data.id);
  jobs.delete(e.data.id);
  if (!job) return;
  if (e.data.error) job.reject(new Error(e.data.error));
  else job.resolve(e.data);
};
function runWorker(imageData, opts, mask) {
  const id = ++jobSeq;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject });
    const transfer = [imageData.data.buffer];
    if (mask) transfer.push(mask.buffer);
    worker.postMessage(
      { id, width: imageData.width, height: imageData.height, data: imageData.data.buffer, mask: mask && mask.buffer, opts },
      transfer
    );
  });
}

// Subject mask (people/pets) from the AI model. It runs on the cropped picture,
// so cropping in on someone also makes the people-finder more accurate.
// Saved per crop. p.maskBlob: null = nothing found.
let segmentModule = null;
async function getMask(p, W, H) {
  const key = JSON.stringify([rotOf(p), cropOf(p)]);
  if (p.maskBlob === undefined || p.maskKey !== key) {
    if (state.pageId === p.id) $('bgNote').textContent = 'Finding people & pets… (first time downloads a ~3 MB helper)';
    segmentModule ||= await import('./segment.js');
    const src = await createImageBitmap(p.srcBlob);
    const s = Math.min(1, 1024 / Math.max(W, H));
    const c = renderOriented(src, p, Math.round(W * s), Math.round(H * s));
    src.close();
    p.maskBlob = await segmentModule.subjectMask(await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 }));
    p.maskKey = key;
    await savePage(p);
  }
  if (!p.maskBlob) return null;
  const bmp = await createImageBitmap(p.maskBlob);
  const c = new OffscreenCanvas(W, H);
  c.getContext('2d').drawImage(bmp, 0, 0, W, H);
  bmp.close();
  const d = c.getContext('2d').getImageData(0, 0, W, H).data;
  const m = new Uint8Array(W * H);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4];
  return m;
}

// One page at a time; a newer request for the same page cancels older ones.
let chain = Promise.resolve();
let activeJobs = 0;
function processPage(p) {
  p._gen = (p._gen || 0) + 1;
  const gen = p._gen;
  const stale = () => gen !== p._gen || !state.pages.has(p.id);
  activeJobs++;
  updateBusy();
  chain = chain.then(async () => {
    if (stale()) return;
    try {
      const [W, H] = outputSize(p);
      const opts = { ...DEFAULT_OPTS, ...p.opts };
      let mask = null;
      if (opts.background !== 'keep') {
        try { mask = await getMask(p, W, H); }
        catch (err) {
          console.error(err);
          toast('Could not load the people-finder (offline?). Keeping the whole background.', 5000);
        }
        if (stale()) return;
      }
      if (state.pageId === p.id) renderBgNote();
      const bmp = await createImageBitmap(p.srcBlob);
      const c = renderOriented(bmp, p, W, H);
      bmp.close();
      const ctx = c.getContext('2d');
      const res = await runWorker(ctx.getImageData(0, 0, W, H), opts, mask);
      if (stale()) return;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(res.data), W, H), 0, 0);
      p.rawBlob = await c.convertToBlob({ type: 'image/png' });
      p.artW = W;
      p.artH = H;
      await applyStrokes(p);
      await savePage(p);
      if (view === 'editor') {
        renderPageList();
        if (state.pageId === p.id) renderStage();
      }
    } catch (err) {
      console.error(err);
      toast('Could not process a photo: ' + err.message);
    }
  }).finally(() => { activeJobs--; updateBusy(); });
  return chain;
}
function updateBusy() { $('busy').hidden = activeJobs === 0; }

// Touch-up strokes are stored as vectors (normalized 0..1) and drawn over the
// generated line art, so they survive style changes.
function drawStroke(ctx, s, W, H) {
  ctx.strokeStyle = ctx.fillStyle = s.tool === 'pen' ? '#000' : '#fff';
  ctx.lineWidth = Math.max(1, s.size * W);
  ctx.lineCap = ctx.lineJoin = 'round';
  const pts = s.pts;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0][0] * W, pts[0][1] * H, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0][0] * W, pts[0][1] * H);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * W, pts[i][1] * H);
  ctx.stroke();
}

async function applyStrokes(p) {
  if (!p.rawBlob) p.rawBlob = p.artBlob; // pages made before touch-ups existed
  if (!p.strokes || !p.strokes.length) { p.artBlob = p.rawBlob; return; }
  const bmp = await createImageBitmap(p.rawBlob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  for (const s of p.strokes) drawStroke(ctx, s, c.width, c.height);
  p.artBlob = await c.convertToBlob({ type: 'image/png' });
}

// ---------------------------------------------------------------- book structure
// A book is a list of slots (printed pages); each slot holds 1-4 photos.
const allPhotoIds = (b) => b.slots.flatMap((s) => s.photoIds);
const slotOf = (pid, b = book()) => b && b.slots.find((s) => s.photoIds.includes(pid));
const firstPhotoId = (b) => (b.slots[0] && b.slots[0].photoIds[0]) || null;
function migrateBook(b) {
  if (!b.slots) {
    b.slots = (b.pageIds || []).map((id) => ({ id: uid(), photoIds: [id] }));
    delete b.pageIds;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- adding photos
async function addFiles(files) {
  const b = book();
  const imgs = [...files].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
  if (!imgs.length) return;
  toast(`Adding ${imgs.length} photo${imgs.length > 1 ? 's' : ''}…`);
  let added = 0;
  for (const file of imgs) {
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      toast(`Couldn't open "${file.name}". iPhone HEIC photos need to be saved as JPEG first.`, 6000);
      continue;
    }
    const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const p = {
      id: uid(), bookId: b.id, name: file.name, w, h, rot: 0, crop: null,
      srcBlob: await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 }),
      artBlob: null, rawBlob: null, strokes: [], caption: '', opts: { ...DEFAULT_OPTS, ...(b.lastOpts || {}) },
    };
    state.pages.set(p.id, p);
    b.slots.push({ id: uid(), photoIds: [p.id] });
    await savePage(p);
    await saveBook(b);
    if (!state.pageId) state.pageId = p.id;
    added++;
    renderEditorAll();
    processPage(p);
  }
  if (added) toast(`Added ${added} photo${added > 1 ? 's' : ''}! Drawing the lines…`);
}

// ---------------------------------------------------------------- books
async function newBook(title = 'Our Family Coloring Book') {
  const b = {
    id: uid(), title, subtitle: '', slots: [], cover: true, rotate: true, blanks: false,
    lastOpts: { ...DEFAULT_OPTS }, created: Date.now(), color: SPINES[state.books.length % SPINES.length],
  };
  state.books.push(b);
  await saveBook(b);
  return b;
}

// ---------------------------------------------------------------- views / routing
let view = 'home';
function route() {
  const m = location.hash.match(/^#book\/(.+)$/);
  const b = m && state.books.find((x) => x.id === m[1]);
  if (b) {
    if (state.bookId !== b.id) {
      state.bookId = b.id;
      state.pageId = firstPhotoId(b);
    }
    view = 'editor';
    $('home').hidden = true;
    $('editorView').hidden = false;
    renderEditorAll();
  } else {
    view = 'home';
    $('editorView').hidden = true;
    $('home').hidden = false;
    renderHome();
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
const openBook = (id) => { location.hash = `#book/${id}`; };

// ---------------------------------------------------------------- render: home
function renderHome() {
  const shelf = $('shelf');
  shelf.innerHTML = '';
  const nb = document.createElement('button');
  nb.className = 'book-card new-book';
  nb.innerHTML = '<div class="book-cover"><div class="plus">＋<small>New book</small></div></div><div class="book-meta"><b>Start a new book</b><span>Add photos next</span></div>';
  nb.onclick = startNewBook;
  shelf.appendChild(nb);

  const books = [...state.books].sort((a, b) => (b.updated || b.created) - (a.updated || a.created));
  for (const b of books) {
    const card = document.createElement('button');
    card.className = 'book-card';
    const cover = document.createElement('div');
    cover.className = 'book-cover';
    cover.style.setProperty('--spine', b.color || SPINES[0]);
    const first = allPhotoIds(b).map((id) => state.pages.get(id)).find((p) => p && p.artBlob);
    if (first) {
      const img = document.createElement('img');
      img.src = artUrl(first);
      img.alt = '';
      cover.appendChild(img);
    } else {
      cover.insertAdjacentHTML('beforeend', '<div class="no-art">🖍️</div>');
    }
    const t = document.createElement('div');
    t.className = 'cover-title';
    t.textContent = b.title || 'Untitled';
    cover.appendChild(t);
    const meta = document.createElement('div');
    meta.className = 'book-meta';
    const name = document.createElement('b');
    name.textContent = b.title || 'Untitled';
    const count = document.createElement('span');
    const n = b.slots.length;
    count.textContent = `${n} page${n === 1 ? '' : 's'}`;
    meta.append(name, count);
    card.append(cover, meta);
    card.onclick = () => openBook(b.id);
    shelf.appendChild(card);
  }
}

async function startNewBook() {
  const b = await newBook();
  openBook(b.id);
  setTimeout(() => { $('bookTitle').focus(); $('bookTitle').select(); }, 50);
}

// ---------------------------------------------------------------- render: editor
function renderEditorAll() {
  if (view !== 'editor') return;
  const b = book();
  $('bookTitle').value = b.title;
  renderPageList();
  renderEditor();
}

function renderPageList() {
  const b = book();
  const list = $('pageList');
  list.innerHTML = '';
  $('pageCount').textContent = b.slots.length ? `(${b.slots.length})` : '';
  const thumb = (p) => {
    if (p.artBlob) {
      const img = document.createElement('img');
      img.src = artUrl(p);
      img.alt = '';
      img.draggable = false;
      return img;
    }
    const s = document.createElement('span');
    s.className = 'pending';
    s.innerHTML = '🖍️<br>Drawing…';
    return s;
  };
  b.slots.forEach((slot, i) => {
    const photos = slot.photoIds.map((id) => state.pages.get(id)).filter(Boolean);
    if (!photos.length) return;
    const li = document.createElement('li');
    li.dataset.id = slot.id;
    li.draggable = true;
    li.className = slot.photoIds.includes(state.pageId) ? 'selected' : '';
    li.title = photos.map((p) => p.name).join(', ');
    li.innerHTML = `<span class="num">${i + 1}</span>`;
    if (photos.length === 1) li.appendChild(thumb(photos[0]));
    else {
      const grid = document.createElement('div');
      grid.className = `grid n${photos.length}`;
      for (const p of photos) {
        const cell = document.createElement('div');
        if (p.id === state.pageId) cell.className = 'on';
        cell.appendChild(thumb(p));
        grid.appendChild(cell);
      }
      li.appendChild(grid);
    }
    li.onclick = () => {
      if (!slot.photoIds.includes(state.pageId)) state.pageId = slot.photoIds[0];
      renderPageList();
      renderEditor();
    };
    list.appendChild(li);
  });
}

function renderCollageBar() {
  const b = book();
  const p = page();
  const slot = p && slotOf(p.id);
  const multi = slot && slot.photoIds.length > 1;
  $('collageBar').hidden = !multi;
  const idx = slot ? b.slots.indexOf(slot) : -1;
  const next = b.slots[idx + 1];
  const canCombine = slot && next && slot.photoIds.length + next.photoIds.length <= 4;
  $('combineBtn').hidden = !canCombine;
  if (!multi) return;
  $('collageCount').textContent = slot.photoIds.length;
  const chips = $('collageChips');
  chips.innerHTML = '';
  slot.photoIds.forEach((id, i) => {
    const c = document.createElement('button');
    c.className = 'chip' + (id === p.id ? ' on' : '');
    c.textContent = `Picture ${i + 1}`;
    c.onclick = () => { state.pageId = id; renderPageList(); renderEditor(); };
    chips.appendChild(c);
  });
}

function renderEditor() {
  const p = page();
  $('emptyState').hidden = !!p;
  $('pageEditor').hidden = !p;
  $('controls').style.visibility = p ? '' : 'hidden';
  if (!p) return;
  for (const k of SLIDERS) {
    $(k).value = p.opts[k];
    $(k + 'Out').textContent = p.opts[k];
  }
  $('caption').value = p.caption || '';
  const bg = p.opts.background || 'keep';
  document.querySelectorAll('input[name=background]').forEach((r) => (r.checked = r.value === bg));
  renderBgNote();
  renderCollageBar();
  renderStage();
}

// Size the before/after frame to the page's exact shape, as large as fits
function fitCompare() {
  const p = page();
  const st = $('stage');
  if (!p || !st.clientWidth) return;
  const [aw, ah] = outputSize(p);
  const pad = 32;
  const s = Math.min((st.clientWidth - pad) / aw, (st.clientHeight - pad) / ah);
  compare.style.width = Math.max(1, Math.floor(aw * s)) + 'px';
  compare.style.height = Math.max(1, Math.floor(ah * s)) + 'px';
}

let stageToken = 0;
async function renderStage() {
  const p = page();
  if (!p) return;
  fitCompare();
  const token = ++stageToken;
  const art = artUrl(p);
  if (art) $('artImg').src = art;
  else $('artImg').removeAttribute('src');
  const src = await srcPreviewUrl(p);
  if (token === stageToken) $('srcImg').src = src;
}

function renderBgNote() {
  const p = page();
  const bg = (p && p.opts.background) || 'keep';
  $('bgNote').textContent = p && bg !== 'keep' && p.maskBlob === null
    ? 'No people or pets found here, so the whole picture is kept.' : '';
}

let toastTimer;
function toast(msg, ms = 3000) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------- events: home / book
$('heroNewBtn').onclick = startNewBook;
$('backBtn').onclick = () => { location.hash = ''; };
$('fileInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };

$('bookTitle').addEventListener('input', () => {
  const b = book();
  b.title = $('bookTitle').value;
  saveBook(b);
});

$('bookSettingsBtn').onclick = () => {
  const b = book();
  $('bookSubtitle').value = b.subtitle || '';
  $('optCover').checked = b.cover;
  $('optRotate').checked = b.rotate;
  $('optBlanks').checked = b.blanks;
  $('bookDialog').showModal();
};
$('bookDoneBtn').onclick = () => $('bookDialog').close();
$('bookDialog').addEventListener('close', () => {
  const b = book();
  if (!b) return;
  b.subtitle = $('bookSubtitle').value;
  b.cover = $('optCover').checked;
  b.rotate = $('optRotate').checked;
  b.blanks = $('optBlanks').checked;
  saveBook(b);
});
$('deleteBookBtn').onclick = async () => {
  const b = book();
  if (!confirm(`Delete "${b.title}" and its ${b.slots.length} page(s)? This can't be undone.\n\nTip: use "Back up" first if you might want it later.`)) return;
  $('bookDialog').close();
  for (const id of allPhotoIds(b)) { state.pages.delete(id); await dbDel('pages', id); }
  await dbDel('books', b.id);
  state.books = state.books.filter((x) => x.id !== b.id);
  state.bookId = null;
  location.hash = '';
};

// ---------------------------------------------------------------- events: page settings
let sliderTimer;
for (const k of SLIDERS) {
  $(k).addEventListener('input', () => {
    const p = page();
    if (!p) return;
    p.opts[k] = Number($(k).value);
    $(k + 'Out').textContent = p.opts[k];
    book().lastOpts = { ...p.opts };
    clearTimeout(sliderTimer);
    sliderTimer = setTimeout(() => { processPage(p); saveBook(book()); }, 250);
  });
}

document.querySelectorAll('input[name=background]').forEach((r) => {
  r.addEventListener('change', () => {
    const p = page();
    if (!p || !r.checked) return;
    p.opts.background = r.value;
    book().lastOpts = { ...p.opts };
    saveBook(book());
    processPage(p);
  });
});

document.querySelectorAll('[data-preset]').forEach((btn) => {
  btn.onclick = () => {
    const p = page();
    if (!p) return;
    p.opts = { ...PRESETS[btn.dataset.preset] };
    book().lastOpts = { ...p.opts };
    saveBook(book());
    renderEditor();
    processPage(p);
  };
});

$('caption').addEventListener('input', () => {
  const p = page();
  if (!p) return;
  p.caption = $('caption').value;
  savePage(p);
});

$('applyAllBtn').onclick = () => {
  const p = page();
  if (!p) return;
  let n = 0;
  for (const id of allPhotoIds(book())) {
    const q = state.pages.get(id);
    if (!q || q === p) continue;
    q.opts = { ...p.opts };
    processPage(q);
    n++;
  }
  toast(n ? `Restyling ${n} other picture${n === 1 ? '' : 's'}…` : 'This is the only picture so far.');
};

// Collages: pull the next page's pictures onto this page, or split them apart
$('combineBtn').onclick = async () => {
  const b = book();
  const slot = slotOf(state.pageId);
  const i = b.slots.indexOf(slot);
  const next = b.slots[i + 1];
  if (!next || slot.photoIds.length + next.photoIds.length > 4) return;
  slot.photoIds.push(...next.photoIds);
  b.slots.splice(i + 1, 1);
  await saveBook(b);
  renderPageList();
  renderEditor();
  toast(`${slot.photoIds.length} pictures now share page ${i + 1}. Crop each one to "Fill its box" for the best fit.`, 4500);
};
$('splitBtn').onclick = async () => {
  const b = book();
  const slot = slotOf(state.pageId);
  const i = b.slots.indexOf(slot);
  const rest = slot.photoIds.slice(1).map((id) => ({ id: uid(), photoIds: [id] }));
  slot.photoIds = slot.photoIds.slice(0, 1);
  b.slots.splice(i + 1, 0, ...rest);
  await saveBook(b);
  renderPageList();
  renderEditor();
};

$('downloadPngBtn').onclick = () => {
  const p = page();
  if (!p || !p.artBlob) return;
  const a = document.createElement('a');
  a.href = artUrl(p);
  a.download = (p.name || 'page').replace(/\.[^.]+$/, '') + '-coloring.png';
  a.click();
};

$('removePageBtn').onclick = async () => {
  const p = page();
  if (!p || !confirm('Remove this picture from the book?')) return;
  const b = book();
  const slot = slotOf(p.id);
  const idx = b.slots.indexOf(slot);
  slot.photoIds = slot.photoIds.filter((id) => id !== p.id);
  if (!slot.photoIds.length) b.slots.splice(idx, 1);
  state.pages.delete(p.id);
  await dbDel('pages', p.id);
  await saveBook(b);
  const s = slot.photoIds.length ? slot : b.slots[Math.min(idx, b.slots.length - 1)];
  state.pageId = (s && s.photoIds[0]) || null;
  renderEditorAll();
};

// Before/after compare slider
const compare = $('compare');
$('compareRange').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  compare.style.setProperty('--pos', v + '%');
  compare.querySelector('.tag-l').style.opacity = v > 12 ? 1 : 0;
  compare.querySelector('.tag-r').style.opacity = v < 88 ? 1 : 0;
});
compare.querySelector('.tag-l').style.opacity = 0;
new ResizeObserver(fitCompare).observe($('stage'));

// ---------------------------------------------------------------- page reordering
let dragId = null;
const list = $('pageList');
list.addEventListener('dragstart', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  dragId = li.dataset.id;
  li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
});
list.addEventListener('dragend', () => {
  dragId = null;
  list.querySelectorAll('li').forEach((li) => li.classList.remove('dragging', 'drop-before'));
});
list.addEventListener('dragover', (e) => {
  if (!dragId) return;
  e.preventDefault();
  list.querySelectorAll('li').forEach((li) => li.classList.remove('drop-before'));
  const li = e.target.closest('li');
  if (li && li.dataset.id !== dragId) li.classList.add('drop-before');
});
list.addEventListener('drop', (e) => {
  if (!dragId) return;
  e.preventDefault();
  e.stopPropagation();
  const li = e.target.closest('li');
  const b = book();
  const from = b.slots.findIndex((s) => s.id === dragId);
  const [moved] = b.slots.splice(from, 1);
  let to = li ? b.slots.findIndex((s) => s.id === li.dataset.id) : b.slots.length;
  if (to < 0) to = b.slots.length;
  b.slots.splice(to, 0, moved);
  saveBook(b);
  renderPageList();
});

// Drop photo files anywhere (on the home page this starts a new book)
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('dropOverlay').hidden = false; } });
window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').hidden = true;
  const files = [...e.dataTransfer.files];
  if (view === 'home') {
    const b = await newBook();
    state.bookId = b.id;
    state.pageId = null;
    openBook(b.id);
  }
  addFiles(files);
});

// ---------------------------------------------------------------- crop & rotate
const crop = { p: null, rot: 0, rect: { ...FULL }, shape: 'free', drag: null };
const cropImg = $('cropImg'), cropBox = $('cropBox');

// In a collage, "fill" means the shape of that picture's box on the page
function shapeAspect(shape) {
  const slot = crop.p && slotOf(crop.p.id);
  if (slot && slot.photoIds.length > 1) {
    return shape === 'free' ? null : cellAspect(slot.photoIds.length, slot.photoIds.indexOf(crop.p.id));
  }
  return shape === 'portrait' ? PAGE_ASPECT : shape === 'landscape' ? 1 / PAGE_ASPECT : null;
}
function setupShapeLabels() {
  const slot = slotOf(crop.p.id);
  const multi = slot && slot.photoIds.length > 1;
  const [tall, wide] = document.querySelectorAll('input[name=cropShape]');
  tall.parentElement.lastChild.textContent = multi ? ' ▣ Fill its box' : ' ▯ Fill page (tall)';
  wide.parentElement.hidden = multi;
  if (multi && crop.shape === 'landscape') crop.shape = 'portrait';
}

async function loadCropImage() {
  const bmp = await createImageBitmap(crop.p.srcBlob);
  const o = orient(bmp, crop.rot);
  const s = Math.min(1, 1600 / Math.max(o.width, o.height));
  const c = new OffscreenCanvas(Math.round(o.width * s), Math.round(o.height * s));
  c.getContext('2d').drawImage(o, 0, 0, c.width, c.height);
  bmp.close();
  cropImg.src = blobUrl(crop.p.id, 'crop', await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 }));
  await cropImg.decode();
}

// Largest centered rect of the chosen shape (normalized coords)
function fitRect(shape) {
  const a = shapeAspect(shape);
  if (!a) return { ...FULL };
  const W = cropImg.naturalWidth, H = cropImg.naturalHeight;
  let w = W, h = W / a;
  if (h > H) { h = H; w = H * a; }
  return { x: (W - w) / 2 / W, y: (H - h) / 2 / H, w: w / W, h: h / H };
}

function drawCropBox() {
  const W = cropImg.clientWidth, H = cropImg.clientHeight, r = crop.rect;
  Object.assign(cropBox.style, {
    left: r.x * W + 'px', top: r.y * H + 'px', width: r.w * W + 'px', height: r.h * H + 'px',
  });
}

function setShapeRadios() {
  document.querySelectorAll('input[name=cropShape]').forEach((el) => (el.checked = el.value === crop.shape));
}

$('cropBtn').onclick = async () => {
  const p = page();
  if (!p) return;
  Object.assign(crop, { p, rot: rotOf(p), rect: { ...cropOf(p) }, shape: p.cropShape || 'free' });
  setupShapeLabels();
  setShapeRadios();
  $('cropDialog').showModal();
  await loadCropImage();
  drawCropBox();
};

document.querySelectorAll('input[name=cropShape]').forEach((el) => {
  el.addEventListener('change', () => {
    if (!el.checked) return;
    crop.shape = el.value;
    if (crop.shape !== 'free') crop.rect = fitRect(crop.shape);
    drawCropBox();
  });
});

async function rotateCrop(delta) {
  crop.rot = (crop.rot + delta + 360) % 360;
  await loadCropImage();
  crop.rect = fitRect(crop.shape);
  drawCropBox();
}
$('rotLeftBtn').onclick = () => rotateCrop(-90);
$('rotRightBtn').onclick = () => rotateCrop(90);
$('cropResetBtn').onclick = async () => {
  crop.rot = 0;
  crop.shape = 'free';
  setShapeRadios();
  await loadCropImage();
  crop.rect = { ...FULL };
  drawCropBox();
};
$('cropCancelBtn').onclick = () => $('cropDialog').close();
$('cropApplyBtn').onclick = () => {
  const p = crop.p;
  const r = crop.rect;
  const isFull = r.x < 0.002 && r.y < 0.002 && r.w > 0.996 && r.h > 0.996;
  const newCrop = isFull ? null : { ...r };
  const changed = crop.rot !== rotOf(p) || JSON.stringify(newCrop) !== JSON.stringify(p.crop || null);
  if (changed && p.strokes && p.strokes.length) {
    if (!confirm('Changing the crop will clear your touch-ups on this picture. Continue?')) return;
    p.strokes = [];
  }
  p.rot = crop.rot;
  p.crop = newCrop;
  p.cropShape = crop.shape;
  $('cropDialog').close();
  savePage(p);
  renderStage();
  processPage(p);
};
window.addEventListener('resize', () => { if ($('cropDialog').open) drawCropBox(); });

// Dragging the crop box (move) or its corners (resize), in display pixels
$('cropInner').addEventListener('pointerdown', (e) => {
  const handle = e.target.dataset.h || (e.target === cropBox ? 'move' : null);
  if (!handle) return;
  e.preventDefault();
  const W = cropImg.clientWidth, H = cropImg.clientHeight, r = crop.rect;
  crop.drag = {
    handle, sx: e.clientX, sy: e.clientY, W, H,
    start: { x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H },
  };
  e.currentTarget.setPointerCapture(e.pointerId);
});
$('cropInner').addEventListener('pointermove', (e) => {
  const d = crop.drag;
  if (!d) return;
  const { W, H, start: s } = d;
  const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
  let x, y, w, h;
  if (d.handle === 'move') {
    w = s.w; h = s.h;
    x = Math.min(Math.max(0, s.x + dx), W - w);
    y = Math.min(Math.max(0, s.y + dy), H - h);
  } else {
    const a = shapeAspect(crop.shape);
    const west = d.handle.includes('w'), north = d.handle.includes('n');
    const ax = west ? s.x + s.w : s.x; // anchor = opposite corner
    const ay = north ? s.y + s.h : s.y;
    const px = (west ? s.x : s.x + s.w) + dx;
    const py = (north ? s.y : s.y + s.h) + dy;
    w = Math.max(30, west ? ax - px : px - ax);
    h = Math.max(30, north ? ay - py : py - ay);
    if (a) { if (w / h > a) h = w / a; else w = h * a; }
    const maxW = west ? ax : W - ax, maxH = north ? ay : H - ay;
    if (w > maxW) { w = maxW; if (a) h = w / a; }
    if (h > maxH) { h = maxH; if (a) w = h * a; }
    x = west ? ax - w : ax;
    y = north ? ay - h : ay;
  }
  crop.rect = { x: x / W, y: y / H, w: w / W, h: h / H };
  drawCropBox();
});
const endDrag = () => { crop.drag = null; };
$('cropInner').addEventListener('pointerup', endDrag);
$('cropInner').addEventListener('pointercancel', endDrag);

// ---------------------------------------------------------------- print / PDF
const fmt = () => document.querySelector('input[name=format]:checked').value;
const slug = (s) => (s || 'coloring-book').trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').toLowerCase() || 'coloring-book';

function updateExportSummary() {
  const b = book();
  const n = b.slots.filter((s) => s.photoIds.some((id) => state.pages.get(id)?.artBlob)).length;
  let pages = n * (b.blanks ? 2 : 1) + (b.cover ? 1 : 0) + (b.cover && b.blanks ? 1 : 0);
  let text;
  if (fmt() === 'booklet') {
    if (b.cover && !b.blanks) pages += 1; // blank inside cover
    const padded = Math.ceil(pages / 4) * 4;
    text = `${padded} booklet pages on ${padded / 4} sheet${padded / 4 === 1 ? '' : 's'} of paper (printed on both sides)`;
  } else {
    text = `${pages} page${pages === 1 ? '' : 's'} of 8.5 × 11 paper`;
  }
  $('exportSummary').textContent = text;
  $('bookletTip').hidden = fmt() !== 'booklet';
}

$('printBtn').onclick = () => {
  if (!allPhotoIds(book()).length) { toast('Add some photos first.'); return; }
  $('exportProgress').hidden = true;
  updateExportSummary();
  $('exportDialog').showModal();
};
document.querySelectorAll('input[name=format]').forEach((r) => r.addEventListener('change', updateExportSummary));
$('exportCancelBtn').onclick = () => $('exportDialog').close();

let exporting = false;
async function renderBook() {
  if (activeJobs > 0) {
    $('exportProgress').hidden = false;
    $('exportProgress').textContent = 'Finishing the line drawings first…';
    await chain;
  }
  $('exportProgress').hidden = false;
  return buildBook(book(), (id) => state.pages.get(id), fmt(), (i, n) => {
    $('exportProgress').textContent = `Making page ${i + 1} of ${n}…`;
  });
}

async function runExport(kind) {
  if (exporting) return;
  exporting = true;
  $('pdfBtn').disabled = $('printNowBtn').disabled = true;
  try {
    const out = await renderBook();
    const b = book();
    if (kind === 'pdf') {
      $('exportProgress').textContent = 'Saving PDF…';
      const pdf = await makePdf(out);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(pdf);
      a.download = `${slug(b.title)}${fmt() === 'booklet' ? '-booklet' : ''}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      $('exportProgress').textContent = `Done! ${(pdf.size / 1048576).toFixed(1)} MB PDF downloaded.`;
    } else {
      const root = $('printRoot');
      root.innerHTML = '';
      $('pageSizeStyle')?.remove();
      const st = document.createElement('style');
      st.id = 'pageSizeStyle';
      st.textContent = `@page { size: ${out.sheetW}in ${out.sheetH}in; margin: 0; } .ppage { width: ${out.sheetW}in; height: ${out.sheetH}in; }`;
      document.head.appendChild(st);
      const imgs = out.sheets.map((s) => {
        const d = document.createElement('div');
        d.className = 'ppage';
        const img = document.createElement('img');
        img.src = URL.createObjectURL(s.blob);
        d.appendChild(img);
        root.appendChild(d);
        return img;
      });
      await Promise.all(imgs.map((i) => i.decode().catch(() => {})));
      $('exportProgress').textContent = 'Opening the print window… Set margins to None and scale to 100%.';
      document.title = b.title || 'Coloring Book';
      window.print();
      document.title = 'Colorbook';
    }
  } catch (err) {
    console.error(err);
    $('exportProgress').textContent = 'Something went wrong: ' + err.message;
  } finally {
    exporting = false;
    $('pdfBtn').disabled = $('printNowBtn').disabled = false;
  }
}
$('pdfBtn').onclick = () => runExport('pdf');
$('printNowBtn').onclick = () => runExport('print');
window.addEventListener('afterprint', () => {
  $('printRoot').querySelectorAll('img').forEach((i) => URL.revokeObjectURL(i.src));
  $('printRoot').innerHTML = '';
});

// ---------------------------------------------------------------- touch-up brush
const touch = { p: null, base: null, strokes: [], cur: null };
const tcv = $('touchCanvas');
const tctx = tcv.getContext('2d');
const touchTool = () => document.querySelector('input[name=touchTool]:checked').value;
const touchSize = () => {
  const v = Number($('touchSize').value);
  return touchTool() === 'pen' ? 0.0012 * v : 0.0045 * v; // fraction of picture width
};

function touchRedraw() {
  tctx.drawImage(touch.base, 0, 0);
  for (const s of touch.strokes) drawStroke(tctx, s, tcv.width, tcv.height);
}

$('touchBtn').onclick = async () => {
  const p = page();
  if (!p) return;
  if (!p.rawBlob && p.artBlob) p.rawBlob = p.artBlob;
  if (!p.rawBlob || activeJobs > 0) { toast('Still drawing. Try again in a moment.'); return; }
  touch.p = p;
  touch.base = await createImageBitmap(p.rawBlob);
  touch.strokes = (p.strokes || []).map((s) => ({ ...s, pts: s.pts.slice() }));
  tcv.width = touch.base.width;
  tcv.height = touch.base.height;
  touchRedraw();
  $('touchDialog').showModal();
};

function touchPoint(e) {
  const r = tcv.getBoundingClientRect();
  return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
}
tcv.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  tcv.setPointerCapture(e.pointerId);
  touch.cur = { tool: touchTool(), size: touchSize(), pts: [touchPoint(e)] };
  touch.strokes.push(touch.cur);
  drawStroke(tctx, touch.cur, tcv.width, tcv.height);
});
tcv.addEventListener('pointermove', (e) => {
  const s = touch.cur;
  if (!s) return;
  const pt = touchPoint(e);
  const last = s.pts[s.pts.length - 1];
  s.pts.push(pt);
  drawStroke(tctx, { ...s, pts: [last, pt] }, tcv.width, tcv.height);
});
const touchEnd = () => {
  if (touch.cur) touch.cur.pts = touch.cur.pts.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]);
  touch.cur = null;
};
tcv.addEventListener('pointerup', touchEnd);
tcv.addEventListener('pointercancel', touchEnd);

$('touchUndoBtn').onclick = () => { touch.strokes.pop(); touchRedraw(); };
$('touchClearBtn').onclick = () => {
  if (touch.strokes.length && !confirm('Remove all touch-ups on this picture?')) return;
  touch.strokes = [];
  touchRedraw();
};
$('touchDialog').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); $('touchUndoBtn').click(); }
});
$('touchCancelBtn').onclick = () => $('touchDialog').close();
$('touchDialog').addEventListener('close', () => { touch.base?.close(); touch.base = null; });
$('touchDoneBtn').onclick = async () => {
  const p = touch.p;
  p.strokes = touch.strokes;
  $('touchDialog').close();
  await applyStrokes(p);
  await savePage(p);
  renderPageList();
  if (page() === p) renderStage();
};

// ---------------------------------------------------------------- backup & restore
const blobToDataUrl = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

$('exportBookBtn').onclick = async () => {
  const b = book();
  const photos = allPhotoIds(b).map((id) => state.pages.get(id)).filter(Boolean);
  toast('Packing up your book…');
  const data = {
    app: 'colorbook', version: 1, exported: new Date().toISOString(),
    book: {
      title: b.title, subtitle: b.subtitle, cover: b.cover, rotate: b.rotate, blanks: b.blanks,
      lastOpts: b.lastOpts, color: b.color, slots: b.slots.map((s) => s.photoIds),
    },
    photos: await Promise.all(photos.map(async (p) => ({
      id: p.id, name: p.name, w: p.w, h: p.h, rot: p.rot || 0, crop: p.crop || null, cropShape: p.cropShape || 'free',
      caption: p.caption || '', opts: p.opts, strokes: p.strokes || [],
      src: await blobToDataUrl(p.srcBlob),
      mask: p.maskBlob ? await blobToDataUrl(p.maskBlob) : p.maskBlob === null ? null : undefined,
      maskKey: p.maskKey,
    }))),
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${slug(b.title)}.colorbook`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  toast(`Backup saved (${(blob.size / 1048576).toFixed(1)} MB).`);
};

async function restoreBackup(data) {
  if (data.app !== 'colorbook' || !data.book || !Array.isArray(data.photos)) throw new Error('not a Colorbook backup');
  const b = await newBook(data.book.title || 'Restored book');
  Object.assign(b, {
    subtitle: data.book.subtitle || '', cover: data.book.cover !== false, rotate: data.book.rotate !== false,
    blanks: !!data.book.blanks, lastOpts: { ...DEFAULT_OPTS, ...(data.book.lastOpts || {}) }, color: data.book.color || b.color,
  });
  const idMap = new Map();
  const fresh = [];
  for (const ph of data.photos) {
    try {
      const p = {
        id: uid(), bookId: b.id, name: ph.name || 'photo.jpg', w: ph.w, h: ph.h, rot: ph.rot || 0, crop: ph.crop || null,
        cropShape: ph.cropShape || 'free', caption: ph.caption || '', opts: { ...DEFAULT_OPTS, ...(ph.opts || {}) },
        strokes: Array.isArray(ph.strokes) ? ph.strokes : [], artBlob: null, rawBlob: null,
        srcBlob: await (await fetch(ph.src)).blob(),
      };
      if (ph.mask) { p.maskBlob = await (await fetch(ph.mask)).blob(); p.maskKey = ph.maskKey; }
      else if (ph.mask === null) { p.maskBlob = null; p.maskKey = ph.maskKey; }
      idMap.set(ph.id, p.id);
      state.pages.set(p.id, p);
      await savePage(p);
      fresh.push(p);
    } catch (err) {
      console.error('Skipping a photo in the backup', err);
    }
  }
  b.slots = (data.book.slots || [])
    .map((ids) => ({ id: uid(), photoIds: ids.map((id) => idMap.get(id)).filter(Boolean) }))
    .filter((s) => s.photoIds.length);
  await saveBook(b);
  state.bookId = null;
  openBook(b.id);
  fresh.forEach(processPage);
  return { b, count: fresh.length };
}

$('importInput').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    toast('Restoring your book…');
    const { b, count } = await restoreBackup(JSON.parse(await file.text()));
    toast(`Restored "${b.title}" with ${count} picture${count === 1 ? '' : 's'}. Redrawing the lines…`, 4500);
  } catch (err) {
    toast(`That file isn't a Colorbook backup (${err.message}).`, 5000);
  }
};

// ---------------------------------------------------------------- startup
state.books = await dbAll('books');
for (const p of await dbAll('pages')) state.pages.set(p.id, p);
for (const b of state.books) if (migrateBook(b)) await saveBook(b);
state.books.sort((a, b) => a.created - b.created);
route();
for (const p of state.pages.values()) if (!p.artBlob) processPage(p);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

window.__cbm = { state, addFiles, processPage, buildBook, makePdf, restoreBackup }; // debug/test hook
