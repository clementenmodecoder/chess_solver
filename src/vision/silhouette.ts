/** Silhouette normalization and matching, shared by the runtime classifier and
 *  the offline template generator so both go through the identical transform. */

export const TEMPLATE_SIZE = 32;

export interface NormalizedSilhouette {
  /** TEMPLATE_SIZE^2 coverage values in 0..1, aspect-preserving, centered. */
  grid: Float32Array;
  /** Bounding-box height relative to the cell size. */
  relHeight: number;
  /** Bounding-box width relative to the cell size. */
  relWidth: number;
  /** Fraction of cell area covered by the silhouette. */
  fill: number;
}

/**
 * Normalize a soft mask (values 0..1, w*h) into a TEMPLATE_SIZE^2 grid:
 * crop to the mask bounding box, scale preserving aspect ratio and center.
 * Returns null when the mask is (near) empty.
 */
export function normalizeSilhouette(mask: Float32Array, w: number, h: number): NormalizedSilhouette | null {
  const S = TEMPLATE_SIZE;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  let mass = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = mask[y * w + x];
      if (v > 0.3) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        mass += v;
      }
    }
  }
  if (maxX < 0) return null;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  if (bw < 3 || bh < 3) return null;

  const scale = S / Math.max(bw, bh);
  const tw = Math.max(1, Math.round(bw * scale));
  const th = Math.max(1, Math.round(bh * scale));
  const ox = (S - tw) >> 1;
  const oy = (S - th) >> 1;
  const grid = new Float32Array(S * S);

  // Area-average sampling from the source bounding box into the target grid.
  for (let ty = 0; ty < th; ty++) {
    const sy0 = minY + (ty / th) * bh;
    const sy1 = minY + ((ty + 1) / th) * bh;
    const iy0 = Math.floor(sy0), iy1 = Math.min(maxY + 1, Math.max(iy0 + 1, Math.ceil(sy1)));
    for (let tx = 0; tx < tw; tx++) {
      const sx0 = minX + (tx / tw) * bw;
      const sx1 = minX + ((tx + 1) / tw) * bw;
      const ix0 = Math.floor(sx0), ix1 = Math.min(maxX + 1, Math.max(ix0 + 1, Math.ceil(sx1)));
      let sum = 0, n = 0;
      for (let sy = iy0; sy < iy1; sy++) {
        for (let sx = ix0; sx < ix1; sx++) {
          sum += mask[sy * w + sx];
          n++;
        }
      }
      grid[(oy + ty) * S + (ox + tx)] = n ? sum / n : 0;
    }
  }

  const cellArea = w * h;
  return {
    grid,
    relHeight: bh / Math.max(w, h),
    relWidth: bw / Math.max(w, h),
    fill: mass / cellArea,
  };
}

/** Soft Jaccard similarity between two normalized grids (0..1). */
export function silhouetteSimilarity(a: Float32Array, b: Float32Array): number {
  let inter = 0, union = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i], bv = b[i];
    inter += av < bv ? av : bv;
    union += av > bv ? av : bv;
  }
  return union > 0 ? inter / union : 0;
}

/** Keep only the largest 8-connected component of a soft mask (>0.3), plus
 *  any pixels within `mergeDist` of it. Drops small satellites such as
 *  coordinate labels, move dots or capture-hint rings that share the cell. */
export function largestComponent(mask: Float32Array, w: number, h: number): Float32Array {
  const labels = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let nLabels = 0;
  const sizes: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (labels[start] !== -1 || mask[start] <= 0.3) continue;
    const label = nLabels++;
    let size = 0;
    let head = 0, tail = 0;
    labels[start] = label;
    queue[tail++] = start;
    while (head < tail) {
      const i = queue[head++];
      size += mask[i];
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (labels[ni] === -1 && mask[ni] > 0.3) {
            labels[ni] = label;
            queue[tail++] = ni;
          }
        }
      }
    }
    sizes.push(size);
  }
  if (nLabels <= 1) return mask;
  let bestLabel = 0;
  for (let l = 1; l < nLabels; l++) if (sizes[l] > sizes[bestLabel]) bestLabel = l;
  // Also keep components at least 40% of the winner: a piece rendered with a
  // detached base or crown must not lose parts.
  const keep = new Uint8Array(nLabels);
  for (let l = 0; l < nLabels; l++) keep[l] = sizes[l] >= sizes[bestLabel] * 0.4 ? 1 : 0;
  const out = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    out[i] = labels[i] >= 0 && keep[labels[i]] ? mask[i] : 0;
  }
  return out;
}

/** Binary erosion (4-neighborhood, `iterations` rounds) of a soft mask
 *  thresholded at 0.5. Used to strip piece outlines before sampling the fill
 *  color. Returns a Uint8 mask (1 = interior). */
export function erodeMask(mask: Float32Array, w: number, h: number, iterations: number): Uint8Array {
  let cur = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) cur[i] = mask[i] > 0.5 ? 1 : 0;
  for (let it = 0; it < iterations; it++) {
    const next = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (cur[i] && cur[i - 1] && cur[i + 1] && cur[i - w] && cur[i + w]) next[i] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

/** Binary dilation (4-neighborhood, `iterations` rounds). */
export function dilateMask(mask: Uint8Array, w: number, h: number, iterations: number): Uint8Array {
  let cur = mask;
  for (let it = 0; it < iterations; it++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (
          cur[i] ||
          (x > 0 && cur[i - 1]) ||
          (x < w - 1 && cur[i + 1]) ||
          (y > 0 && cur[i - w]) ||
          (y < h - 1 && cur[i + w])
        ) {
          next[i] = 1;
        }
      }
    }
    cur = next;
  }
  return cur;
}

/** Morphological opening used as a support filter: everything that survives
 *  erode(r)+dilate(r+1) keeps its original soft value, the rest is zeroed.
 *  Cuts thin texture streaks (wood grain) and the bridges they form between
 *  pieces and coordinate labels, while leaving piece bodies intact. */
export function morphOpenSupport(mask: Float32Array, w: number, h: number, r: number): Float32Array {
  const eroded = erodeMask(mask, w, h, r);
  const support = dilateMask(eroded, w, h, r + 1);
  const out = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = support[i] ? mask[i] : 0;
  return out;
}

/** Fill enclosed holes in a soft mask: any region not reachable from the cell
 *  border through "background" pixels is considered piece interior.
 *  This makes silhouettes robust when a piece's fill color matches the square
 *  (e.g. white piece on a light square, where only the outline is visible). */
export function fillHoles(mask: Float32Array, w: number, h: number): Float32Array {
  const BG_MAX = 0.3;
  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  const push = (i: number) => {
    if (!visited[i] && mask[i] <= BG_MAX) {
      visited[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + (w - 1));
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  const out = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    out[i] = mask[i] > BG_MAX ? mask[i] : visited[i] ? mask[i] : 1;
  }
  return out;
}
