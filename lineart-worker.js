// Line-art engine. Runs entirely in the browser (no server, no cost).
// Pipeline: grayscale -> contrast stretch -> Difference-of-Gaussians edge
// detection -> threshold -> remove small specks -> thicken lines -> soften edges.

self.onmessage = (e) => {
  const { id, width, height, data, mask, opts } = e.data;
  try {
    const out = lineArt(new Uint8ClampedArray(data), width, height, opts, mask && new Uint8Array(mask));
    self.postMessage({ id, width, height, data: out.buffer }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};

function lineArt(rgba, w, h, o, subjMask) {
  const n = w * h;
  // Settings are tuned for a ~2000px image; scale spatial params to actual size.
  const scale = Math.max(w, h) / 2000;

  // 1. Grayscale
  let g = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  }

  // 2. Contrast stretch (1st..99th percentile) so dim/hazy photos behave like crisp ones
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[g[i] | 0]++;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.01) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.01) { hi = v; break; } }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < n; i++) {
    const v = ((g[i] - lo) / range) * 255;
    g[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }

  // 3. Difference of Gaussians. "Simplify" sets the scale: bigger scale ignores
  //    fine texture (grass, hair, fabric) and keeps only bigger shapes.
  const simplify = o.simplify; // 1..10
  const sigma = (0.7 + simplify * 0.38) * scale;
  const g1 = gaussian(g, w, h, sigma);
  const g2 = gaussian(g, w, h, sigma * 1.6);
  // Positive response = dark side of an edge (where an outline belongs)
  const resp = g2;
  for (let i = 0; i < n; i++) resp[i] = g2[i] - g1[i];

  // Subject weighting (people/pets found by the AI model). Background lines are
  // faded ("soft") or dropped ("remove"). Mask is expanded and feathered so
  // outlines right at the subject's edge survive.
  let weight = null;
  const bgMode = subjMask ? o.background : 'keep';
  if (bgMode === 'soft' || bgMode === 'remove') {
    let m = new Float32Array(n);
    for (let i = 0; i < n; i++) m[i] = subjMask[i] / 255;
    m = gaussian(m, w, h, 14 * scale);
    weight = m;
    const floor = bgMode === 'soft' ? 0.6 : 0;
    for (let i = 0; i < n; i++) {
      const v = Math.min(1, m[i] * 2.2);
      weight[i] = floor + (1 - floor) * v;
    }
  }

  // 4. Adaptive threshold: "Detail" picks roughly what share of the page becomes
  //    line, so dim and bright photos behave alike. With a subject mask, the
  //    share is measured over the subject so people get the full detail.
  const detail = o.detail; // 1..10
  const share = 0.012 + (detail - 1) * 0.009;
  const BINS = 2000, BMAX = 100;
  const rh = new Uint32Array(BINS);
  let counted = 0;
  for (let i = 0; i < n; i++) {
    if (bgMode === 'remove' && weight[i] < 0.9) continue;
    counted++;
    const v = resp[i];
    if (v > 0) rh[Math.min(BINS - 1, (v / BMAX * BINS) | 0)]++;
  }
  if (weight) for (let i = 0; i < n; i++) resp[i] *= weight[i];
  let target = Math.max(1, counted) * share, k = BINS - 1;
  for (acc = 0; k > 0; k--) { acc += rh[k]; if (acc >= target) break; }
  const hiThr = Math.max(0.9, (k / BINS) * BMAX);
  const loThr = hiThr * 0.45;

  // 5. Hysteresis (like Canny): keep faint edge pixels only when they connect to
  //    strong ones. Gives continuous outlines without picking up noise.
  const mask = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  for (let i = 0; i < n; i++) if (resp[i] > hiThr) { mask[i] = 1; stack[sp++] = i; }
  while (sp > 0) {
    const p = stack[--sp];
    const x = p % w, y = (p / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        const q = ny * w + nx;
        if (!mask[q] && resp[q] > loThr) { mask[q] = 1; stack[sp++] = q; }
      }
    }
  }

  // 6. Remove specks: connected line fragments smaller than minArea pixels
  const cleanup = o.cleanup; // 0..10
  const minArea = Math.round(cleanup * cleanup * 6 * scale * scale);
  if (minArea > 1) removeSmall(mask, w, h, minArea);

  // 7. Thicken lines (crayon-friendly)
  const radius = (o.thickness - 1) * 0.9 * scale; // thickness 1..8
  const ink = radius >= 0.6 ? dilate(mask, w, h, radius) : toFloat(mask);

  // 8. Soften the hard pixel edges a touch so print looks smooth
  const soft = gaussian(ink, w, h, 0.7 * Math.max(1, scale));

  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    let a = soft[i] * 1.6; // bias toward solid black
    if (a > 1) a = 1;
    const v = 255 - a * 255;
    out[j] = out[j + 1] = out[j + 2] = v;
    out[j + 3] = 255;
  }
  return out;
}

function toFloat(mask) {
  const f = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) f[i] = mask[i];
  return f;
}

// Gaussian approximation via 3 box blurs (fast, O(n) regardless of sigma)
function gaussian(src, w, h, sigma) {
  if (sigma < 0.3) return src.slice();
  const boxes = boxesForGauss(sigma, 3);
  let a = src.slice(), b = new Float32Array(src.length);
  for (const bx of boxes) {
    const r = (bx - 1) / 2;
    boxH(a, b, w, h, r);
    boxV(b, a, w, h, r);
  }
  return a;
}

function boxesForGauss(sigma, n) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

function boxH(src, dst, w, h, r) {
  if (r < 1) { dst.set(src); return; }
  const iarr = 1 / (r + r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const fv = src[row];
    let val = (r + 1) * fv;
    for (let x = 0; x < r; x++) val += src[row + Math.min(x, w - 1)];
    for (let x = 0; x < w; x++) {
      val += src[row + Math.min(x + r, w - 1)] - (x - r - 1 >= 0 ? src[row + x - r - 1] : fv);
      dst[row + x] = val * iarr;
    }
  }
}

function boxV(src, dst, w, h, r) {
  if (r < 1) { dst.set(src); return; }
  const iarr = 1 / (r + r + 1);
  for (let x = 0; x < w; x++) {
    const fv = src[x];
    let val = (r + 1) * fv;
    for (let y = 0; y < r; y++) val += src[Math.min(y, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      val += src[Math.min(y + r, h - 1) * w + x] - (y - r - 1 >= 0 ? src[(y - r - 1) * w + x] : fv);
      dst[y * w + x] = val * iarr;
    }
  }
}

function removeSmall(mask, w, h, minArea) {
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let head = 0, tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const p = queue[head++];
      const x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (mask[q] && !seen[q]) { seen[q] = 1; queue[tail++] = q; }
        }
      }
    }
    if (tail < minArea) for (let i = 0; i < tail; i++) mask[queue[i]] = 0;
  }
}

function dilate(mask, w, h, r) {
  const out = new Float32Array(mask.length);
  const R = Math.ceil(r);
  const offs = [];
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++)
      if (dx * dx + dy * dy <= r * r + 0.25) offs.push(dx, dy);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let k = 0; k < offs.length; k += 2) {
        const nx = x + offs[k], ny = y + offs[k + 1];
        if (nx >= 0 && ny >= 0 && nx < w && ny < h) out[ny * w + nx] = 1;
      }
    }
  }
  return out;
}
