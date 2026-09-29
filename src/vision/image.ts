import type { RGBAImage, Rect } from './types';

export function makeImage(width: number, height: number): RGBAImage {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

export function crop(img: RGBAImage, rect: Rect): RGBAImage {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(img.width, Math.round(rect.x + rect.w));
  const y1 = Math.min(img.height, Math.round(rect.y + rect.h));
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const out = makeImage(w, h);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * img.width + x0) * 4;
    out.data.set(img.data.subarray(src, src + w * 4), y * w * 4);
  }
  return out;
}

/** Box-filter downscale so the longest side is at most maxDim. Returns scale applied. */
export function downscale(img: RGBAImage, maxDim: number): { img: RGBAImage; scale: number } {
  const longest = Math.max(img.width, img.height);
  if (longest <= maxDim) return { img, scale: 1 };
  const scale = maxDim / longest;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = makeImage(w, h);
  const { data } = img;
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y / h) * img.height);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) / h) * img.height));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x / w) * img.width);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) / w) * img.width));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let i = (sy * img.width + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++, i += 4) {
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
      }
      const o = (y * w + x) * 4;
      out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n; out.data[o + 3] = 255;
    }
  }
  return { img: out, scale: w / img.width };
}

export function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function colorDist(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** Per-channel summed-area tables for O(1) rectangle means. */
export interface IntegralImage {
  width: number;
  height: number;
  r: Float64Array;
  g: Float64Array;
  b: Float64Array;
}

export function buildIntegral(img: RGBAImage): IntegralImage {
  const w = img.width, h = img.height, W = w + 1;
  const r = new Float64Array(W * (h + 1));
  const g = new Float64Array(W * (h + 1));
  const b = new Float64Array(W * (h + 1));
  const d = img.data;
  for (let y = 0; y < h; y++) {
    let rowR = 0, rowG = 0, rowB = 0;
    const above = y * W, cur = (y + 1) * W;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rowR += d[i]; rowG += d[i + 1]; rowB += d[i + 2];
      r[cur + x + 1] = r[above + x + 1] + rowR;
      g[cur + x + 1] = g[above + x + 1] + rowG;
      b[cur + x + 1] = b[above + x + 1] + rowB;
    }
  }
  return { width: w, height: h, r, g, b };
}

/** Mean color of [x0,x1) x [y0,y1) clamped to image bounds. */
export function rectMean(it: IntegralImage, x0: number, y0: number, x1: number, y1: number): [number, number, number] {
  x0 = Math.max(0, Math.min(it.width, Math.round(x0)));
  x1 = Math.max(0, Math.min(it.width, Math.round(x1)));
  y0 = Math.max(0, Math.min(it.height, Math.round(y0)));
  y1 = Math.max(0, Math.min(it.height, Math.round(y1)));
  if (x1 <= x0 || y1 <= y0) return [0, 0, 0];
  const W = it.width + 1;
  const area = (x1 - x0) * (y1 - y0);
  const sum = (t: Float64Array) => t[y1 * W + x1] - t[y0 * W + x1] - t[y1 * W + x0] + t[y0 * W + x0];
  return [sum(it.r) / area, sum(it.g) / area, sum(it.b) / area];
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Component-wise median of a list of RGB colors. */
export function medianColor(colors: [number, number, number][]): [number, number, number] {
  return [
    median(colors.map((c) => c[0])),
    median(colors.map((c) => c[1])),
    median(colors.map((c) => c[2])),
  ];
}
