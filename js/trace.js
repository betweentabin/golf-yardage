// 航空写真からグリーンの外形を自動でなぞる。
// タップした地点の色から、似た色が続く範囲を広げていき（領域拡張）、その輪郭を外形にする。

/** sRGB → CIE Lab（色の差を人の見え方に近い尺度で測るため） */
function toLab(r, g, b) {
  const lin = (c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** 3x3 の平均でならした Lab 画像（芝目や JPEG のノイズを抑える） */
function labImage({ data, width, height }) {
  const lab = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const i = (yy * width + xx) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
      }
      const [L, A, B] = toLab(r / n, g / n, b / n);
      const o = (y * width + x) * 3;
      lab[o] = L; lab[o + 1] = A; lab[o + 2] = B;
    }
  }
  return lab;
}

/** シード周辺 (5x5) の平均色 */
function seedColor(lab, width, height, sx, sy) {
  let L = 0, A = 0, B = 0, n = 0;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const x = sx + dx, y = sy + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const o = (y * width + x) * 3;
      L += lab[o]; A += lab[o + 1]; B += lab[o + 2]; n++;
    }
  return [L / n, A / n, B / n];
}

/** シードから色の差が tol 未満の画素を広げる。maxR を超えたら漏れたとみなす */
function grow(lab, width, height, sx, sy, seed, tol, maxR) {
  const mask = new Uint8Array(width * height);
  const stack = [sy * width + sx];
  mask[sy * width + sx] = 1;
  let area = 0, leaked = false;
  const tol2 = tol * tol;
  // 明るさの差は影や撮影条件で変わりやすいので、色味 (a, b) より軽く見る
  const near = (p) => {
    const o = p * 3;
    const dL = (lab[o] - seed[0]) * 0.5, dA = lab[o + 1] - seed[1], dB = lab[o + 2] - seed[2];
    return dL * dL + dA * dA + dB * dB < tol2;
  };
  while (stack.length) {
    const p = stack.pop();
    area++;
    const x = p % width, y = (p - x) / width;
    if ((x - sx) ** 2 + (y - sy) ** 2 > maxR * maxR) { leaked = true; continue; }
    if (x > 0 && !mask[p - 1] && near(p - 1)) { mask[p - 1] = 1; stack.push(p - 1); }
    if (x < width - 1 && !mask[p + 1] && near(p + 1)) { mask[p + 1] = 1; stack.push(p + 1); }
    if (y > 0 && !mask[p - width] && near(p - width)) { mask[p - width] = 1; stack.push(p - width); }
    if (y < height - 1 && !mask[p + width] && near(p + width)) { mask[p + width] = 1; stack.push(p + width); }
  }
  return { mask, area, leaked };
}

/** 2値画像の膨張・収縮（半径 r 画素の円） */
function morph(mask, width, height, r, dilate) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let v = dilate ? 0 : 1;
      for (let dy = -r; dy <= r && v === (dilate ? 0 : 1); dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const xx = x + dx, yy = y + dy;
          const m = xx < 0 || yy < 0 || xx >= width || yy >= height ? 0 : mask[yy * width + xx];
          if (dilate && m) { v = 1; break; }
          if (!dilate && !m) { v = 0; break; }
        }
      out[y * width + x] = v;
    }
  return out;
}

/** シードを含む連結成分だけ残し、内側の穴（ピン跡・影など）を埋める */
function cleanUp(mask, width, height, sx, sy) {
  const keep = new Uint8Array(mask.length);
  const seedP = sy * width + sx;
  if (!mask[seedP]) return keep;
  const st = [seedP];
  keep[seedP] = 1;
  while (st.length) {
    const p = st.pop();
    const x = p % width;
    for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
      if (q >= 0 && q < mask.length && mask[q] && !keep[q]) { keep[q] = 1; st.push(q); }
    }
  }
  // 外側から塗れない場所 = 穴
  const outside = new Uint8Array(mask.length);
  const st2 = [];
  for (let x = 0; x < width; x++) { st2.push(x, (height - 1) * width + x); }
  for (let y = 0; y < height; y++) { st2.push(y * width, y * width + width - 1); }
  while (st2.length) {
    const p = st2.pop();
    if (outside[p] || keep[p]) continue;
    outside[p] = 1;
    const x = p % width;
    if (x > 0) st2.push(p - 1);
    if (x < width - 1) st2.push(p + 1);
    if (p >= width) st2.push(p - width);
    if (p < mask.length - width) st2.push(p + width);
  }
  for (let p = 0; p < mask.length; p++) if (!outside[p]) keep[p] = 1;
  return keep;
}

/** 輪郭追跡（Moore近傍）。外周の画素列を返す */
function traceContour(mask, width, height) {
  let start = -1;
  for (let p = 0; p < mask.length; p++) if (mask[p]) { start = p; break; }
  if (start < 0) return [];
  const at = (x, y) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x];
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const sx = start % width, sy = (start - sx) / width;
  const pts = [[sx, sy]];
  let x = sx, y = sy, d = 6; // 上から来たとみなす
  for (let guard = 0; guard < mask.length; guard++) {
    let found = false;
    for (let k = 0; k < 8; k++) {
      const nd = (d + 6 + k) % 8; // 左手側から時計回りに探す
      const nx = x + dirs[nd][0], ny = y + dirs[nd][1];
      if (at(nx, ny)) { x = nx; y = ny; d = nd; found = true; break; }
    }
    if (!found || (x === sx && y === sy)) break;
    pts.push([x, y]);
  }
  return pts;
}

/** Douglas-Peucker で頂点を間引く */
function simplify(pts, eps) {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let best = -1, bestD = eps;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * 画像の (sx, sy) をタップしたとして、グリーンの外形を画素座標で返す。
 * mPerPx: 1画素あたりのメートル。
 * 許容する色の差を少しずつ広げ、面積が急に増える（周りの芝に漏れる）手前で止める。
 */
export function traceGreen(img, sx, sy, mPerPx) {
  const { width, height } = img;
  const lab = labImage(img);
  const seed = seedColor(lab, width, height, sx, sy);
  const maxR = 45 / mPerPx; // グリーンの端まで最大45m
  const minArea = 60 / (mPerPx * mPerPx);
  let chosen = null, prevArea = 0;
  for (let tol = 6; tol <= 30; tol += 2) {
    const r = grow(lab, width, height, sx, sy, seed, tol, maxR);
    if (r.leaked) break;
    // 面積が一気に1.6倍以上になったら境界を越えたとみなす
    if (chosen && prevArea > minArea && r.area > prevArea * 1.6) break;
    chosen = { ...r, tol };
    prevArea = r.area;
  }
  if (!chosen || chosen.area < minArea) {
    return { ok: false, reason: chosen ? '小さすぎます。グリーンの真ん中をタップしてください' : '境界がはっきりしません。手動で外形を描いてください' };
  }
  let mask = chosen.mask;
  const rc = Math.max(1, Math.round(0.8 / mPerPx));
  // グリーンは丸みのある塊なので、大きさの2割より細いはみ出し（影・通路など）は削る
  const eqR = Math.sqrt(chosen.area / Math.PI) * mPerPx;
  const ro = Math.max(1, Math.round(Math.min(3.5, Math.max(1.5, eqR * 0.2)) / mPerPx));
  mask = morph(morph(mask, width, height, rc, true), width, height, rc, false); // 閉じる（細い切れ目をつなぐ）
  mask = morph(morph(mask, width, height, ro, false), width, height, ro, true); // 開く（細いはみ出しを取る）
  mask = cleanUp(mask, width, height, sx, sy);
  let area = 0;
  for (let p = 0; p < mask.length; p++) area += mask[p];
  const areaM2 = area * mPerPx * mPerPx;
  if (areaM2 > 1500) return { ok: false, reason: `範囲が広すぎます（${Math.round(areaM2)}㎡）。池やフェアウェイに広がった可能性があります` };
  const contour = simplify(traceContour(mask, width, height), Math.max(1, 0.5 / mPerPx));
  if (contour.length < 3) return { ok: false, reason: '外形を作れませんでした' };
  return { ok: true, contour, areaM2, tol: chosen.tol };
}

// ---------------- 地図タイルとの橋渡し（ブラウザ専用） ----------------

const TILE = 256;
const project = (lat, lon, z) => {
  const n = TILE * 2 ** z;
  const s = Math.sin((lat * Math.PI) / 180);
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
};
const unproject = (x, y, z) => {
  const n = TILE * 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [+lat.toFixed(7), +lon.toFixed(7)];
};

async function loadTile(url) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error('航空写真を読み込めません');
  return createImageBitmap(await res.blob());
}

/**
 * 地点 [lat, lon] のグリーンを航空写真からなぞり、外形 [lat, lon][] を返す。
 * tileUrl は {z}/{x}/{y} を含むテンプレート（CORS 対応のもの）。
 */
export async function traceGreenAt(p, tileUrl, z = 18) {
  const [cx, cy] = project(p[0], p[1], z);
  const mPerPx = (40075016.686 * Math.cos((p[0] * Math.PI) / 180)) / (TILE * 2 ** z);
  const half = Math.ceil(60 / mPerPx); // タップ地点から60m四方を読む
  const x0 = Math.floor(cx - half), y0 = Math.floor(cy - half);
  const w = half * 2, h = half * 2;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const tx0 = Math.floor(x0 / TILE), ty0 = Math.floor(y0 / TILE);
  const tx1 = Math.floor((x0 + w) / TILE), ty1 = Math.floor((y0 + h) / TILE);
  const jobs = [];
  for (let tx = tx0; tx <= tx1; tx++)
    for (let ty = ty0; ty <= ty1; ty++) {
      const url = tileUrl.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
      jobs.push(loadTile(url).then((bmp) => ctx.drawImage(bmp, tx * TILE - x0, ty * TILE - y0)));
    }
  await Promise.all(jobs);
  const img = ctx.getImageData(0, 0, w, h);
  const r = traceGreen(img, Math.round(cx - x0), Math.round(cy - y0), mPerPx);
  if (!r.ok) return r;
  return { ...r, outline: r.contour.map(([x, y]) => unproject(x0 + x + 0.5, y0 + y + 0.5, z)) };
}
