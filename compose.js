// Page composer: turns a book into finished page images (full pages or a
// fold-and-staple booklet), and writes them to a PDF. No libraries needed.

const DPI = 200; // 8.5x11 page = 1700 x 2200 px, plenty for line art
const FONT = '"Fredoka", "Comic Sans MS", "Segoe Print", system-ui, sans-serif';
const GAP_IN = 0.25;

const FORMATS = {
  full: { pageW: 8.5, pageH: 11, sheetW: 8.5, sheetH: 11, margin: 0.5, captionPt: 18, scale: 1 },
  booklet: { pageW: 5.5, pageH: 8.5, sheetW: 11, sheetH: 8.5, margin: 0.4, captionPt: 13, scale: 0.66 },
};

// Boxes for 1-4 pictures inside an area
export function cellRects(n, x, y, w, h, gap) {
  const half = (len) => (len - gap) / 2;
  if (n <= 1) return [{ x, y, w, h }];
  if (n === 2) {
    if (h >= w) return [{ x, y, w, h: half(h) }, { x, y: y + half(h) + gap, w, h: half(h) }];
    return [{ x, y, w: half(w), h }, { x: x + half(w) + gap, y, w: half(w), h }];
  }
  if (n === 3) {
    const bh = half(h);
    return [
      { x, y, w, h: bh },
      { x, y: y + bh + gap, w: half(w), h: bh },
      { x: x + half(w) + gap, y: y + bh + gap, w: half(w), h: bh },
    ];
  }
  const cw = half(w), ch = half(h);
  return [
    { x, y, w: cw, h: ch }, { x: x + cw + gap, y, w: cw, h: ch },
    { x, y: y + ch + gap, w: cw, h: ch }, { x: x + cw + gap, y: y + ch + gap, w: cw, h: ch },
  ];
}

// Shape (width / height) of the box picture #index gets on a full page
export function cellAspect(n, index) {
  const f = FORMATS.full;
  const r = cellRects(n, 0, 0, f.pageW - 2 * f.margin, f.pageH - 2 * f.margin, GAP_IN)[index] || { w: 3, h: 4 };
  return r.w / r.h;
}

function blankCanvas(w, h) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  return c;
}

function drawContain(ctx, img, r) {
  const s = Math.min(r.w / img.width, r.h / img.height);
  const w = img.width * s, h = img.height * s;
  ctx.drawImage(img, r.x + (r.w - w) / 2, r.y + (r.h - h) / 2, w, h);
}

// Shrink text to fit one line (down to 60%), then cut with an ellipsis
function fitLine(ctx, text, maxW, size, weight = 500) {
  let s = size;
  ctx.font = `${weight} ${s}px ${FONT}`;
  while (ctx.measureText(text).width > maxW && s > size * 0.6) {
    s *= 0.94;
    ctx.font = `${weight} ${s}px ${FONT}`;
  }
  let t = text;
  while (ctx.measureText(t).width > maxW && t.length > 1) t = t.slice(0, -2) + '…';
  return t;
}

function wrapLines(ctx, text, maxW) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

const isWide = (p) => (p.artW || p.w) > (p.artH || p.h) * 1.05;

async function composeSlot(photos, W, H, f, rotateWide) {
  if (photos.length === 1 && rotateWide && isWide(photos[0])) {
    // Lay the page out sideways, then turn it so the picture's top faces the spine
    const inner = await composeSlot(photos, H, W, f, false);
    const c = blankCanvas(W, H);
    const ctx = c.getContext('2d');
    ctx.translate(0, H);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(inner, 0, 0);
    return c;
  }
  const c = blankCanvas(W, H);
  const ctx = c.getContext('2d');
  const m = f.margin * DPI, gap = GAP_IN * DPI * (f.scale < 1 ? 0.7 : 1);
  const rects = cellRects(photos.length, m, m, W - 2 * m, H - 2 * m, gap);
  const capPx = ((photos.length === 1 ? f.captionPt : f.captionPt * 0.72) / 72) * DPI;
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i], r = rects[i];
    let box = r;
    if (p.caption) {
      const band = capPx * 1.7;
      box = { ...r, h: r.h - band };
      ctx.fillStyle = '#000';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const t = fitLine(ctx, p.caption, r.w, capPx);
      ctx.fillText(t, r.x + r.w / 2, r.y + r.h - band / 2);
    }
    const bmp = await createImageBitmap(p.artBlob);
    drawContain(ctx, bmp, box);
    bmp.close();
  }
  return c;
}

async function composeCover(book, firstPhoto, W, H, f) {
  const c = blankCanvas(W, H);
  const ctx = c.getContext('2d');
  const k = f.scale;
  const m = f.margin * DPI, border = 0.12 * DPI * k;
  ctx.lineWidth = border;
  ctx.strokeStyle = '#000';
  ctx.beginPath();
  ctx.roundRect(m + border / 2, m + border / 2, W - 2 * m - border, H - 2 * m - border, 0.3 * DPI * k);
  ctx.stroke();

  const pad = m + border + 0.45 * DPI * k;
  const innerW = W - 2 * pad;
  let y = pad;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  // Title: white letters with a thick black outline, so kids can color them in
  let size = (46 / 72) * DPI * k;
  ctx.font = `700 ${size}px ${FONT}`;
  let lines = wrapLines(ctx, book.title || 'My Coloring Book', innerW);
  while (lines.length > 3 && size > 20) {
    size *= 0.9;
    ctx.font = `700 ${size}px ${FONT}`;
    lines = wrapLines(ctx, book.title || 'My Coloring Book', innerW);
  }
  ctx.lineJoin = 'round';
  ctx.lineWidth = size * 0.12;
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#fff';
  for (const line of lines) {
    ctx.strokeText(line, W / 2, y);
    ctx.fillText(line, W / 2, y);
    y += size * 1.12;
  }

  // Bottom: name line and subtitle
  const nameSize = (16 / 72) * DPI * k, subSize = (20 / 72) * DPI * k;
  let bottom = H - pad;
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'bottom';
  ctx.font = `500 ${nameSize}px ${FONT}`;
  ctx.fillText(fitLine(ctx, 'This book belongs to: ____________________', innerW, nameSize), W / 2, bottom);
  bottom -= nameSize * 2;
  if (book.subtitle) {
    ctx.fillText(fitLine(ctx, book.subtitle, innerW, subSize), W / 2, bottom);
    bottom -= subSize * 1.8;
  }

  if (firstPhoto) {
    const top = y + size * 0.3;
    const bmp = await createImageBitmap(firstPhoto.artBlob);
    drawContain(ctx, bmp, { x: pad, y: top, w: innerW, h: Math.max(10, bottom - top) });
    bmp.close();
  }
  return c;
}

const toJpeg = (c) => c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });

/**
 * Render a whole book. format: 'full' (8.5x11 pages) or 'booklet'
 * (two 5.5x8.5 pages per landscape sheet, in fold-and-staple order).
 * Returns { sheetW, sheetH (inches), sheets: [{ blob, w, h }], pageCount }.
 */
export async function buildBook(book, getPhoto, format = 'full', onProgress = () => {}) {
  try {
    await Promise.all([document.fonts.load(`700 40px Fredoka`), document.fonts.load(`500 20px Fredoka`)]);
  } catch { /* fall back to system fonts */ }
  const f = FORMATS[format];
  const W = Math.round(f.pageW * DPI), H = Math.round(f.pageH * DPI);
  const slots = book.slots
    .map((s) => s.photoIds.map(getPhoto).filter((p) => p && p.artBlob))
    .filter((a) => a.length);

  // Logical pages: functions that draw them (null = blank page)
  const pages = [];
  if (book.cover) {
    pages.push(() => composeCover(book, slots[0] && slots[0][0], W, H, f));
    if (book.blanks || format === 'booklet') pages.push(null); // inside of the cover
  }
  for (const s of slots) {
    pages.push(() => composeSlot(s, W, H, f, book.rotate));
    if (book.blanks) pages.push(null);
  }
  const render = async (pg) => (pg ? pg() : blankCanvas(W, H));

  const sheets = [];
  if (format === 'full') {
    for (let i = 0; i < pages.length; i++) {
      onProgress(i, pages.length);
      sheets.push({ blob: await toJpeg(await render(pages[i])), w: W, h: H });
    }
    return { sheetW: f.sheetW, sheetH: f.sheetH, sheets, pageCount: pages.length };
  }

  // Booklet: pad to a multiple of 4, then pair pages for saddle stitching
  while (pages.length % 4) pages.push(null);
  const N = pages.length;
  const sides = [];
  for (let i = 0; i < N / 4; i++) {
    sides.push([N - 1 - 2 * i, 2 * i]); // front of sheet
    sides.push([2 * i + 1, N - 2 - 2 * i]); // back of sheet
  }
  for (let s = 0; s < sides.length; s++) {
    onProgress(s, sides.length);
    const sheet = blankCanvas(W * 2, H);
    const ctx = sheet.getContext('2d');
    ctx.drawImage(await render(pages[sides[s][0]]), 0, 0);
    ctx.drawImage(await render(pages[sides[s][1]]), W, 0);
    // tiny fold marks at top and bottom center
    ctx.strokeStyle = '#999';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W, 0); ctx.lineTo(W, 0.15 * DPI);
    ctx.moveTo(W, H); ctx.lineTo(W, H - 0.15 * DPI);
    ctx.stroke();
    sheets.push({ blob: await toJpeg(sheet), w: W * 2, h: H });
  }
  return { sheetW: f.sheetW, sheetH: f.sheetH, sheets, pageCount: N };
}

// Minimal PDF writer: one full-page JPEG per page
export async function makePdf({ sheetW, sheetH, sheets }) {
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let len = 0;
  const push = (x) => {
    const b = typeof x === 'string' ? enc.encode(x) : x;
    parts.push(b);
    len += b.length;
  };
  const obj = (id, ...body) => {
    offsets[id] = len;
    push(`${id} 0 obj\n`);
    body.forEach(push);
    push('\nendobj\n');
  };
  const wPt = sheetW * 72, hPt = sheetH * 72;
  const n = sheets.length;
  const pageId = (i) => 3 + i * 3;

  push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // %PDF-1.4 + binary marker
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${sheets.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] >>`);
  for (let i = 0; i < n; i++) {
    const s = sheets[i];
    const p = pageId(i), content = p + 1, img = p + 2;
    obj(p, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${content} 0 R >>`);
    const stream = `q ${wPt} 0 0 ${hPt} 0 0 cm /Im0 Do Q`;
    obj(content, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const bytes = new Uint8Array(await s.blob.arrayBuffer());
    obj(img,
      `<< /Type /XObject /Subtype /Image /Width ${s.w} /Height ${s.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`,
      bytes,
      '\nendstream');
  }
  const count = 2 + n * 3;
  const xref = len;
  push(`xref\n0 ${count + 1}\n0000000000 65535 f \n`);
  for (let id = 1; id <= count; id++) push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
