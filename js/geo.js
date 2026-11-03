// 距離計算まわり。座標はすべて [lat, lon]（度）で扱う。

export const M_TO_YD = 1.09361;
const R = 6371008.8; // 地球の平均半径 (m)
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** 2点間の地表距離 (m)。Haversine式。 */
export function haversine(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** origin を原点とした平面座標 [東(m), 北(m)]。ゴルフ場の範囲なら十分な精度。 */
export function toLocal(origin, p) {
  return [
    rad(p[1] - origin[1]) * R * Math.cos(rad(origin[0])),
    rad(p[0] - origin[0]) * R,
  ];
}

export function fromLocal(origin, [x, y]) {
  return [
    origin[0] + deg(y / R),
    origin[1] + deg(x / (R * Math.cos(rad(origin[0])))),
  ];
}

/** ポリゴンの重心。面積が潰れている場合は頂点の平均。 */
export function centroid(outline) {
  if (!outline || outline.length === 0) return null;
  const o = outline[0];
  const pts = outline.map((p) => toLocal(o, p));
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const f = x1 * y2 - x2 * y1;
    a += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-6) {
    const sx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const sy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    return fromLocal(o, [sx, sy]);
  }
  return fromLocal(o, [cx / (3 * a), cy / (3 * a)]);
}

export function greenCenter(green) {
  return green?.center || centroid(green?.outline) || null;
}

/**
 * 現在地からグリーンまでの距離 (m)。
 * 手前・奥は外形の頂点を「現在地→中心」方向に投影した最小値・最大値。
 * pinOffsetYd は中心からの奥(+)/手前(-)のずれ (yd)。
 */
export function greenDistances(pos, green, pinOffsetYd = 0) {
  const center = greenCenter(green);
  if (!pos || !center) return null;
  const c = haversine(pos, center);
  let front = null, back = null;
  const outline = green.outline;
  if (outline && outline.length >= 3 && c > 1) {
    const [dx, dy] = toLocal(pos, center);
    const n = Math.hypot(dx, dy);
    const ux = dx / n, uy = dy / n;
    front = Infinity;
    back = -Infinity;
    for (const v of outline) {
      const [vx, vy] = toLocal(pos, v);
      const t = vx * ux + vy * uy;
      if (t < front) front = t;
      if (t > back) back = t;
    }
    front = Math.max(0, front);
  }
  return { center: c, front, back, pin: Math.max(0, c + pinOffsetYd / M_TO_YD) };
}

/** 点 p から線分 a-b までの距離 (m)。 */
export function distToSegment(p, a, b) {
  const [ax, ay] = toLocal(p, a);
  const [bx, by] = toLocal(p, b);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** 点がポリゴン内にあるか（レイキャスト法）。 */
export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if (yi > p[0] !== yj > p[0] && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** 精度で重み付けした平均位置。fixes: [{lat, lon, acc}] */
export function weightedMean(fixes) {
  let sw = 0, la = 0, lo = 0, sa = 0;
  for (const f of fixes) {
    const w = 1 / Math.max(f.acc, 0.5) ** 2;
    sw += w;
    la += f.lat * w;
    lo += f.lon * w;
    sa += f.acc;
  }
  return { pos: [la / sw, lo / sw], acc: sa / fixes.length };
}

export const toYd = (m) => (m == null ? null : m * M_TO_YD);
