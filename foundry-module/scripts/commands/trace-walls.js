/**
 * Taverne: traces wall paths from a map image.
 *
 * 1. Load the image (scene background by default) at a working resolution.
 * 2. Build a mask: flood fill from seed points (colour close to the seed, or no hard edge
 *    between neighbours), or a luminance threshold, or a list of colours.
 * 3. Clean it: morphological close/open, drop small islands, fill small holes.
 * 4. Marching squares on the mask, link the segments into loops, simplify them
 *    (Ramer-Douglas-Peucker), cut them where they run along the image border.
 * Returns paths in scene pixels (map top-left origin), ready for create_walls, and a preview.
 */

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error(`Cannot load image ${src}`));
  img.src = src;
});

function boxBlur(rgb, w, h, r) {
  if (r <= 0) return rgb;
  const out = new Float32Array(rgb.length);
  const tmp = new Float32Array(rgb.length);
  for (let y = 0; y < h; y++) for (let c = 0; c < 3; c++) {
    let acc = 0, n = 0;
    for (let x = -r; x < w + r; x++) {
      if (x + r < w) { acc += rgb[(y * w + x + r) * 3 + c]; n++; }
      if (x - r - 1 >= 0) { acc -= rgb[(y * w + x - r - 1) * 3 + c]; n--; }
      if (x >= 0 && x < w) tmp[(y * w + x) * 3 + c] = acc / n;
    }
  }
  for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    let acc = 0, n = 0;
    for (let y = -r; y < h + r; y++) {
      if (y + r < h) { acc += tmp[((y + r) * w + x) * 3 + c]; n++; }
      if (y - r - 1 >= 0) { acc -= tmp[((y - r - 1) * w + x) * 3 + c]; n--; }
      if (y >= 0 && y < h) out[(y * w + x) * 3 + c] = acc / n;
    }
  }
  return out;
}

const dist = (a, i, b, j) => Math.hypot(a[i] - b[j], a[i + 1] - b[j + 1], a[i + 2] - b[j + 2]);

/** Square-kernel dilate (op = 1) or erode (op = 0), separable. */
function morph(mask, w, h, r, dilate) {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  const want = dilate ? 1 : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = dilate ? 0 : 1;
    for (let k = -r; k <= r && v !== want; k++) { const xx = x + k; if (xx >= 0 && xx < w && mask[y * w + xx] === want) v = want; }
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = dilate ? 0 : 1;
    for (let k = -r; k <= r && v !== want; k++) { const yy = y + k; if (yy >= 0 && yy < h && tmp[yy * w + x] === want) v = want; }
    out[y * w + x] = v;
  }
  return out;
}

/** Labels 4-connected components of value `v`; returns [labels, sizes, touchesBorder]. */
function components(mask, w, h, v) {
  const labels = new Int32Array(mask.length).fill(-1);
  const sizes = []; const border = [];
  const stack = [];
  for (let s = 0; s < mask.length; s++) {
    if (mask[s] !== v || labels[s] !== -1) continue;
    const id = sizes.length; let size = 0; let touches = false;
    labels[s] = id; stack.push(s);
    while (stack.length) {
      const p = stack.pop(); size++;
      const x = p % w, y = (p - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && mask[q] === v && labels[q] === -1) { labels[q] = id; stack.push(q); }
      }
    }
    sizes.push(size); border.push(touches);
  }
  return [labels, sizes, border];
}

/** Marching squares on a 0/1 mask; returns closed loops of [x, y] in mask pixel space. */
function marchingSquares(mask, w, h) {
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x]);
  const segs = new Map(); // key "x,y" of start -> list of end keys
  const add = (a, b) => { const k = `${a[0]},${a[1]}`; if (!segs.has(k)) segs.set(k, []); segs.get(k).push(b); };
  // Edge midpoints of the cell whose top-left sample is (x, y), in doubled coordinates.
  for (let y = -1; y < h; y++) for (let x = -1; x < w; x++) {
    const tl = at(x, y), tr = at(x + 1, y), br = at(x + 1, y + 1), bl = at(x, y + 1);
    const c = tl * 8 + tr * 4 + br * 2 + bl;
    if (c === 0 || c === 15) continue;
    const T = [2 * x + 1, 2 * y], R = [2 * x + 2, 2 * y + 1], B = [2 * x + 1, 2 * y + 2], L = [2 * x, 2 * y + 1];
    // Oriented so the inside (1) stays on the same side.
    const table = {
      1: [[L, B]], 2: [[B, R]], 3: [[L, R]], 4: [[R, T]], 5: [[L, T], [R, B]], 6: [[B, T]], 7: [[L, T]],
      8: [[T, L]], 9: [[T, B]], 10: [[T, R], [B, L]], 11: [[T, R]], 12: [[R, L]], 13: [[R, B]], 14: [[B, L]],
    };
    for (const [a, b] of table[c]) add(a, b);
  }
  const loops = [];
  for (const [startKey] of segs) {
    while (segs.get(startKey)?.length) {
      const loop = [];
      let key = startKey;
      for (let guard = 0; guard < 1e6; guard++) {
        const [px, py] = key.split(',').map(Number);
        loop.push([px / 2 - 0.5 + 0.5, py / 2 - 0.5 + 0.5]);
        const nexts = segs.get(key);
        if (!nexts?.length) break;
        const n = nexts.pop();
        key = `${n[0]},${n[1]}`;
        if (key === startKey) break;
      }
      if (loop.length > 2) loops.push(loop);
    }
  }
  return loops;
}

function rdp(points, eps) {
  if (points.length < 3) return points;
  const [ax, ay] = points[0], [bx, by] = points[points.length - 1];
  const len = Math.hypot(bx - ax, by - ay) || 1e-9;
  let max = 0, idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    const d = len < 1e-6 ? Math.hypot(px - ax, py - ay) : Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
    if (d > max) { max = d; idx = i; }
  }
  if (max <= eps) return [points[0], points[points.length - 1]];
  return [...rdp(points.slice(0, idx + 1), eps).slice(0, -1), ...rdp(points.slice(idx), eps)];
}

/** Simplifies a closed loop: split at the two farthest-apart points, RDP each half. */
function simplifyLoop(loop, eps) {
  let far = 0, best = 0;
  for (let i = 0; i < loop.length; i++) { const d = Math.hypot(loop[i][0] - loop[0][0], loop[i][1] - loop[0][1]); if (d > best) { best = d; far = i; } }
  const a = rdp(loop.slice(0, far + 1), eps);
  const b = rdp([...loop.slice(far), loop[0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/** Splits segments longer than maxLen (keeps straight runs, but gives more vertices to tweak). */
function densify(points, maxLen, closed) {
  if (!maxLen) return points;
  const out = [];
  const n = points.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = points[i], b = points[(i + 1) % n];
    out.push(a);
    const steps = Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxLen);
    for (let s = 1; s <= steps; s++) { const t = s / (steps + 1); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  if (!closed) out.push(points[n - 1]);
  return out;
}

/**
 * @param {object} p
 * @param {string} [p.src]            image path (default: the scene background)
 * @param {string} [p.sceneId]
 * @param {'flood'|'edge'|'dark'|'light'|'colors'} [p.mode='flood']
 * @param {number[][]} [p.seeds]       seed points in scene pixels (flood/edge; optional filter for others)
 * @param {number} [p.tolerance=40]    colour distance (0-441) for flood/colors, gradient for edge
 * @param {number} [p.threshold=60]    luminance 0-255 for dark/light
 * @param {string[]} [p.colors]        hex colours for mode colors
 * @param {number} [p.workSize=1024]   working resolution (longest side)
 * @param {number} [p.blur=2] [p.close=2] [p.open=1]  in working pixels
 * @param {number} [p.minArea=0.0005]  islands smaller than this fraction of the image are dropped
 * @param {number} [p.maxHole=0.002]   holes smaller than this fraction are filled (0 keeps all)
 * @param {number} [p.epsilon=6]       simplification tolerance in scene pixels
 * @param {number} [p.maxSegment]      split segments longer than this (scene pixels)
 * @param {boolean} [p.skipBorder=true] open the loops where they follow the image border
 * @param {boolean} [p.invert=false]   trace the complement of the mask
 */
export async function traceWalls(p = {}) {
  const scene = p.sceneId ? game.scenes.get(p.sceneId) : canvas.scene;
  if (!scene) throw new Error('Scene not found');
  const src = p.src ?? scene.background?.src;
  if (!src) throw new Error('No image: pass src or give the scene a background');
  const img = await loadImage(src.startsWith('http') || src.startsWith('/') ? src : `/${src}`);
  const workSize = Math.min(p.workSize ?? 1024, 2048);
  const k = Math.min(1, workSize / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  let rgb = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { rgb[i * 3] = px[i * 4]; rgb[i * 3 + 1] = px[i * 4 + 1]; rgb[i * 3 + 2] = px[i * 4 + 2]; }
  rgb = boxBlur(rgb, w, h, p.blur ?? 2);

  // Scene pixels <-> working pixels.
  const sx = scene.width / w, sy = scene.height / h;
  const toWork = ([x, y]) => [Math.max(0, Math.min(w - 1, Math.round(x / sx))), Math.max(0, Math.min(h - 1, Math.round(y / sy)))];
  const seeds = (p.seeds ?? []).map(toWork);
  const mode = p.mode ?? 'flood';
  const tol = p.tolerance ?? 40;
  let mask = new Uint8Array(w * h);

  if (mode === 'flood' || mode === 'edge') {
    if (!seeds.length) throw new Error(`mode ${mode} needs seeds`);
    const stack = [];
    for (const [x, y] of seeds) {
      const s = y * w + x;
      const ref = [rgb[s * 3], rgb[s * 3 + 1], rgb[s * 3 + 2]];
      stack.push(s); mask[s] = 1;
      while (stack.length) {
        const q = stack.pop();
        const qx = q % w, qy = (q - qx) / w;
        for (const n of [qx > 0 ? q - 1 : -1, qx < w - 1 ? q + 1 : -1, qy > 0 ? q - w : -1, qy < h - 1 ? q + w : -1]) {
          if (n < 0 || mask[n]) continue;
          const ok = mode === 'flood' ? dist(rgb, n * 3, ref, 0) <= tol : dist(rgb, n * 3, rgb, q * 3) <= tol;
          if (ok) { mask[n] = 1; stack.push(n); }
        }
      }
    }
  } else if (mode === 'dark' || mode === 'light') {
    const t = p.threshold ?? 60;
    for (let i = 0; i < w * h; i++) {
      const lum = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
      mask[i] = (mode === 'dark' ? lum < t : lum > t) ? 1 : 0;
    }
  } else if (mode === 'colors') {
    const refs = (p.colors ?? []).map((c) => { const n = Number.parseInt(c.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; });
    if (!refs.length) throw new Error('mode colors needs colors');
    for (let i = 0; i < w * h; i++) mask[i] = refs.some((r) => dist(rgb, i * 3, r, 0) <= tol) ? 1 : 0;
  } else throw new Error(`Unknown mode ${mode}`);

  // Clean up.
  const close = p.close ?? 2, open = p.open ?? 1;
  mask = morph(morph(mask, w, h, close, true), w, h, close, false);
  mask = morph(morph(mask, w, h, open, false), w, h, open, true);
  const minArea = (p.minArea ?? 0.0005) * w * h;
  {
    const [labels, sizes] = components(mask, w, h, 1);
    const keepSeeded = new Set(seeds.map(([x, y]) => labels[y * w + x]).filter((l) => l >= 0));
    const restrict = seeds.length > 0 && mode !== 'flood' && mode !== 'edge';
    for (let i = 0; i < mask.length; i++) {
      const l = labels[i];
      if (l < 0) continue;
      if (sizes[l] < minArea && !keepSeeded.has(l)) mask[i] = 0;
      else if (restrict && !keepSeeded.has(l)) mask[i] = 0;
    }
  }
  const maxHole = (p.maxHole ?? 0.002) * w * h;
  if (maxHole > 0) {
    const [labels, sizes, border] = components(mask, w, h, 0);
    for (let i = 0; i < mask.length; i++) { const l = labels[i]; if (l >= 0 && !border[l] && sizes[l] < maxHole) mask[i] = 1; }
  }
  if (p.invert) for (let i = 0; i < mask.length; i++) mask[i] = mask[i] ? 0 : 1;

  // Contours.
  const eps = (p.epsilon ?? 6) / sx;
  const loops = marchingSquares(mask, w, h);
  const onBorder = ([x, y]) => x <= 0.6 || y <= 0.6 || x >= w - 1.6 || y >= h - 1.6;
  const paths = [];
  let area = 0;
  for (let i = 0; i < mask.length; i++) area += mask[i];
  for (const loop of loops) {
    const skip = p.skipBorder !== false;
    if (!skip || !loop.some(onBorder)) {
      const simple = simplifyLoop(loop, eps);
      if (simple.length >= 3) paths.push({ closed: true, points: simple });
      continue;
    }
    // Rotate so we start on a border point, then cut into runs that stay off the border.
    const start = loop.findIndex(onBorder);
    const rot = [...loop.slice(start), ...loop.slice(0, start)];
    let run = [];
    for (const pt of [...rot, rot[0]]) {
      if (onBorder(pt)) { if (run.length >= 2) paths.push({ closed: false, points: rdp(run, eps) }); run = [pt]; }
      else run.push(pt);
    }
    if (run.length >= 2) paths.push({ closed: false, points: rdp(run, eps) });
  }
  const scenePaths = paths
    .map((path) => ({ closed: path.closed, points: densify(path.points.map(([x, y]) => [Math.round(x * sx), Math.round(y * sy)]), p.maxSegment, path.closed) }))
    .filter((path) => path.points.length >= 2);

  // Preview: image, tinted mask, traced paths, seeds.
  const pv = document.createElement('canvas'); pv.width = w; pv.height = h;
  const g = pv.getContext('2d');
  g.drawImage(img, 0, 0, w, h);
  const tint = g.getImageData(0, 0, w, h);
  for (let i = 0; i < w * h; i++) if (mask[i]) { tint.data[i * 4] = tint.data[i * 4] * 0.6 + 0 * 0.4; tint.data[i * 4 + 1] = tint.data[i * 4 + 1] * 0.6 + 255 * 0.4; tint.data[i * 4 + 2] = tint.data[i * 4 + 2] * 0.6 + 120 * 0.4; }
  g.putImageData(tint, 0, 0);
  g.lineWidth = Math.max(2, w / 500); g.strokeStyle = '#ff2d2d';
  let segments = 0;
  for (const path of scenePaths) {
    g.beginPath();
    path.points.forEach(([x, y], i) => (i ? g.lineTo(x / sx, y / sy) : g.moveTo(x / sx, y / sy)));
    if (path.closed) g.closePath();
    g.stroke();
    g.fillStyle = '#ffffff';
    for (const [x, y] of path.points) g.fillRect(x / sx - 1.5, y / sy - 1.5, 3, 3);
    segments += path.points.length - (path.closed ? 0 : 1);
  }
  g.fillStyle = '#ffe600';
  for (const [x, y] of seeds) { g.beginPath(); g.arc(x, y, Math.max(4, w / 200), 0, Math.PI * 2); g.fill(); }
  return {
    paths: scenePaths,
    stats: { loops: loops.length, paths: scenePaths.length, segments, coverage: area / (w * h), work: [w, h], image: [img.naturalWidth, img.naturalHeight], scene: [scene.width, scene.height] },
    image: pv.toDataURL('image/jpeg', 0.8).replace(/^data:[^;]+;base64,/, ''),
    mimeType: 'image/jpeg',
  };
}
