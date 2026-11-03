// OpenStreetMap (Overpass API) からグリーンとホールを取り込む。
import { centroid, haversine, pointInPolygon } from './geo.js';
import { uid } from './store.js';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/** bbox: [south, west, north, east] */
export async function fetchGolf(bbox, onRetry) {
  const b = bbox.join(',');
  const q = `[out:json][timeout:30];
(
  way["golf"="green"](${b});
  relation["golf"="green"](${b});
  way["golf"="hole"](${b});
);
out geom;
(
  way["leisure"="golf_course"](${b});
  relation["leisure"="golf_course"](${b});
);
out tags;`;
  // 公開サーバーは混雑で 429 / 502 / 504 を返すことがあるので、間隔を空けて数回試す
  let lastErr;
  for (let round = 0; round < 3; round++) {
    if (round > 0) {
      onRetry?.(round);
      await new Promise((r) => setTimeout(r, 3000 * 2 ** (round - 1)));
    }
    for (const url of ENDPOINTS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(q),
        });
        if (res.ok) return await res.json();
        lastErr = new Error(
          [429, 502, 503, 504].includes(res.status)
            ? 'OpenStreetMapのサーバーが混雑しています。少し時間をおいて試してください'
            : `Overpass API エラー (${res.status})`
        );
      } catch {
        lastErr = new Error('OpenStreetMapのサーバーに接続できません（電波を確認してください）');
      }
    }
  }
  throw lastErr;
}

const geomToPts = (geom) => (geom || []).map((g) => [g.lat, g.lon]);

/** マルチポリゴンの outer メンバーを端点でつないで1つの輪にする（最大のもの）。 */
function joinOuter(members) {
  const segs = members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => geomToPts(m.geometry));
  const rings = [];
  while (segs.length) {
    let ring = segs.shift();
    let grew = true;
    while (grew && segs.length) {
      grew = false;
      const end = ring.at(-1);
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const same = (a, b) => a[0] === b[0] && a[1] === b[1];
        if (same(s[0], end)) ring = ring.concat(s.slice(1));
        else if (same(s.at(-1), end)) ring = ring.concat(s.slice(0, -1).reverse());
        else continue;
        segs.splice(i, 1);
        grew = true;
        break;
      }
    }
    rings.push(ring);
  }
  return rings.sort((a, b) => b.length - a.length)[0] || [];
}

function dropClosingPoint(pts) {
  if (pts.length > 1 && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1]) pts = pts.slice(0, -1);
  return pts;
}

/**
 * Overpass の結果を Hole[] に変換する。
 * - golf=hole の終点を含む（または近い）グリーンをそのホールのグリーンにする
 * - 割り当てのないグリーンは、近くのホールの2つ目のグリーン（2グリーン）か、番号なしホールにする
 */
export function buildHoles(json) {
  const greens = [];
  const holeWays = [];
  let courseName = null;

  for (const el of json.elements || []) {
    const t = el.tags || {};
    if (t.leisure === 'golf_course' && t.name && !courseName) courseName = t.name;
    if (t.golf === 'green') {
      const pts = dropClosingPoint(el.type === 'relation' ? joinOuter(el.members || []) : geomToPts(el.geometry));
      if (pts.length >= 3) greens.push({ outline: pts, center: centroid(pts), osmName: t.name || t.ref || '' });
    } else if (t.golf === 'hole' && el.type === 'way') {
      const pts = geomToPts(el.geometry);
      if (pts.length >= 2) holeWays.push({ pts, ref: parseInt(t.ref, 10), par: parseInt(t.par, 10) });
    }
  }

  const used = new Set();
  const holes = [];
  for (const hw of holeWays) {
    const end = hw.pts.at(-1);
    let best = -1, bestD = Infinity;
    greens.forEach((g, i) => {
      if (used.has(i)) return;
      const d = pointInPolygon(end, g.outline) ? 0 : haversine(end, g.center);
      if (d < bestD) { bestD = d; best = i; }
    });
    const hole = {
      id: uid(),
      number: Number.isFinite(hw.ref) ? hw.ref : null,
      par: Number.isFinite(hw.par) ? hw.par : null,
      tee: hw.pts[0],
      greens: [],
      _end: end,
    };
    if (best >= 0 && bestD <= 60) {
      used.add(best);
      hole.greens.push(toGreen(greens[best], ''));
    }
    holes.push(hole);
  }

  // 番号の重複（例: 2コース分の1番）は後のものを番号なしにする
  const seen = new Set();
  for (const h of holes) {
    if (h.number == null) continue;
    if (seen.has(h.number)) h.number = null;
    else seen.add(h.number);
  }

  greens.forEach((g, i) => {
    if (used.has(i)) return;
    // 既に割り当てたグリーンの近く（80m以内）なら2グリーンの片方とみなす
    let host = null, hostD = Infinity;
    for (const h of holes) {
      const ref = h.greens[0]?.center || h._end;
      const d = haversine(ref, g.center);
      if (d < hostD) { hostD = d; host = h; }
    }
    if (host && hostD <= 80 && host.greens.length < 2) {
      host.greens.push(toGreen(g, ''));
    } else {
      holes.push({ id: uid(), number: null, par: null, tee: null, greens: [toGreen(g, '')], _end: g.center });
    }
  });

  for (const h of holes) {
    delete h._end;
    if (h.greens.length === 2) nameTwoGreens(h);
    if (h.greens.length === 0) h.greens.push({ id: uid(), name: '', center: null, outline: [] });
  }
  return { holes, courseName, stats: { greens: greens.length, holeWays: holeWays.length } };
}

function toGreen(g, name) {
  return { id: uid(), name, center: g.center, outline: g.outline };
}

/** 2グリーンを、ティーから見た左右で L / R と名付ける。ティーが無ければ A / B。 */
function nameTwoGreens(h) {
  const [a, b] = h.greens;
  if (!h.tee) {
    a.name = 'A';
    b.name = 'B';
    return;
  }
  // ティー→各グリーンのベクトルの外積の符号で左右を判定
  const v = (p) => [p[1] - h.tee[1], p[0] - h.tee[0]];
  const [ax, ay] = v(a.center);
  const [bx, by] = v(b.center);
  const aIsLeft = ax * by - ay * bx < 0;
  a.name = aIsLeft ? 'L' : 'R';
  b.name = aIsLeft ? 'R' : 'L';
  h.greens.sort((x, y) => x.name.localeCompare(y.name));
}
