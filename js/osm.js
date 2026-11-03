// OpenStreetMap からゴルフ場を探し、グリーンとホールを取り込む。
// 検索は Nominatim、形状の取得は Overpass API。
import { centroid, haversine, pointInPolygon } from './geo.js';
import { uid } from './store.js';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const JAPAN_BBOX = '24,122,46,154';
const BUSY = 'OpenStreetMapのサーバーが混雑しています。少し時間をおいて試してください';
const OFFLINE = 'OpenStreetMapのサーバーに接続できません（電波を確認してください）';

/** Overpass API に問い合わせる。混雑時（429 / 502 / 504）は間隔を空けて数回試す */
async function overpass(q, onRetry, timeoutMs = 45_000) {
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
          signal: AbortSignal.timeout(timeoutMs), // 応答しないサーバーで止まらないように
        });
        if (res.ok) {
          const json = await res.json();
          // 混雑時は 200 のまま「runtime error: timeout」などの注記付きで空の結果が返る
          if (!/error/i.test(json.remark || '')) return json;
          lastErr = new Error(BUSY);
          continue;
        }
        lastErr = new Error([429, 502, 503, 504].includes(res.status) ? BUSY : `Overpass API エラー (${res.status})`);
      } catch {
        lastErr = new Error(OFFLINE);
      }
    }
  }
  throw lastErr;
}

const golfQuery = (filter) => `(
  way["golf"="green"]${filter};
  relation["golf"="green"]${filter};
  way["golf"="hole"]${filter};
);
out geom;`;

/** 表示範囲のグリーンとホールを取得する。bbox: [south, west, north, east] */
export function fetchGolf(bbox, onRetry) {
  const b = `(${bbox.join(',')})`;
  return overpass(`[out:json][timeout:30];
${golfQuery(b)}
(
  way["leisure"="golf_course"]${b};
  relation["leisure"="golf_course"]${b};
);
out tags;`, onRetry);
}

/**
 * ゴルフ場1つ分のグリーンとホールを取得する。
 * ゴルフ場の敷地（leisure=golf_course）の中にあるものだけを取る。
 */
export async function fetchCourse(place, onRetry) {
  const { osm } = place;
  if (osm.type === 'way' || osm.type === 'relation') {
    const json = await overpass(`[out:json][timeout:60];
${osm.type}(${osm.id})->.c;
.c map_to_area->.a;
${golfQuery('(area.a)')}`, onRetry, 75_000);
    if ((json.elements || []).length) return json;
  }
  // 敷地が無い・敷地内に何も無い場合は、周辺の範囲で取る
  const bbox = place.bbox || [place.lat - 0.008, place.lon - 0.01, place.lat + 0.008, place.lon + 0.01];
  return fetchGolf(bbox.map((v) => (+v).toFixed(6)), onRetry);
}

function toPlace(x) {
  return {
    name: x.name || x.display_name?.split(',')[0] || '名前なし',
    address: (x.display_name || '').split(',').slice(1, 4).join(',').trim(),
    osm: { type: x.osm_type, id: Number(x.osm_id) },
    lat: Number(x.lat),
    lon: Number(x.lon),
    // Nominatim の boundingbox は [south, north, west, east]
    bbox: x.boundingbox ? [+x.boundingbox[0], +x.boundingbox[2], +x.boundingbox[1], +x.boundingbox[3]] : null,
  };
}

async function nominatim(params) {
  const url = NOMINATIM + '?' + new URLSearchParams({ format: 'jsonv2', countrycodes: 'jp', 'accept-language': 'ja', ...params });
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new Error(OFFLINE);
  }
  if (!res.ok) throw new Error(res.status === 429 ? BUSY : `検索エラー (${res.status})`);
  const list = await res.json();
  return list.filter((x) => x.category === 'leisure' && x.type === 'golf_course').map(toPlace);
}

/** 名前でゴルフ場を探す。Nominatim で見つからなければ Overpass で名前の部分一致 */
export async function searchCourses(text) {
  text = text.trim();
  if (!text) return [];
  const found = await nominatim({ q: text, limit: 20 });
  if (found.length) return found;
  // 「霞ヶ関」「霞ケ関」のような表記ゆれも拾う
  const re = text
    .replace(/["\\]/g, '')
    .replace(/[.*+?^${}()|[\]]/g, '\\\\$&')
    .replace(/[ヶケヵ]/g, '[ヶケヵ]')
    .replace(/\s+/g, '.*');
  const json = await overpass(`[out:json][timeout:25];
nwr["leisure"="golf_course"]["name"~"${re}",i](${JAPAN_BBOX});
out center tags 30;`);
  return (json.elements || []).map((e) => ({
    name: e.tags?.name || '名前なし',
    address: '',
    osm: { type: e.type, id: e.id },
    lat: e.lat ?? e.center?.lat,
    lon: e.lon ?? e.center?.lon,
    bbox: null,
  }));
}

/**
 * 現在地の近くのゴルフ場を近い順に。
 * Nominatim は最大40件で打ち切るので、まず約10km四方で探し、少なければ約30kmに広げる
 */
export async function nearbyCourses(pos) {
  const [lat, lon] = pos;
  const search = (d) => nominatim({
    q: 'golf course',
    viewbox: [lon - d * 1.2, lat + d, lon + d * 1.2, lat - d].join(','),
    bounded: 1,
    limit: 40,
  });
  let list = await search(0.1);
  if (list.length < 8) {
    await new Promise((r) => setTimeout(r, 1100)); // Nominatim の利用規約: 1秒に1回まで
    const wide = await search(0.3);
    const seen = new Set(list.map((p) => p.osm.type + p.osm.id));
    list = list.concat(wide.filter((p) => !seen.has(p.osm.type + p.osm.id)));
  }
  return list
    .map((p) => ({ ...p, distance: haversine(pos, [p.lat, p.lon]) }))
    .filter((p) => !/パークゴルフ|park golf/i.test(p.name))
    .sort((a, b) => a.distance - b.distance);
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

const GROUP_JA = { east: '東', west: '西', north: '北', south: '南', middle: '中', central: '中', new: '新', old: '旧' };

/** ホール名からコース名と番号を取り出す。例: "West Hole 12" → { group: '西', number: 12 } */
function parseHoleName(name) {
  if (!name) return { group: '', number: null };
  const nums = name.match(/\d+/g);
  let g = name
    .replace(/\d+/g, ' ')
    .replace(/\b(hole|no|course)\b\.?/gi, ' ')
    .replace(/番ホール|ホール|番|コース|#/g, ' ')
    .replace(/[\s.・\-_:：()（）]+/g, ' ')
    .trim();
  const key = g.toLowerCase();
  if (key === 'out' || key === 'in') g = ''; // 「OUT 1」「IN 10」はコース名ではない
  return { group: GROUP_JA[key] || g, number: nums ? parseInt(nums.at(-1), 10) : null };
}

/**
 * Overpass の結果を Hole[] に変換する。
 * - golf=hole の終点を含む（または近い）グリーンをそのホールのグリーンにする
 * - 1つのゴルフ場に複数コース（東・西など）があれば、ホール名からコース名を付ける
 * - 割り当てのないグリーンは、近くのホールの2つ目のグリーン（2グリーン）にする。
 *   ホール情報がある場合、それ以外は練習グリーンとみなして取り込まない
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
      if (pts.length >= 3) greens.push({ outline: pts, center: centroid(pts) });
    } else if (t.golf === 'hole' && el.type === 'way') {
      const pts = geomToPts(el.geometry);
      if (pts.length < 2) continue;
      const parsed = parseHoleName(t.name);
      const ref = parseInt(t.ref, 10);
      holeWays.push({
        pts,
        number: Number.isFinite(ref) ? ref : parsed.number,
        group: parsed.group,
        par: parseInt(t.par, 10),
      });
    }
  }

  // コース名で分けるのは、3ホール以上のコースが2つ以上あるときだけ
  const groupSize = {};
  for (const hw of holeWays) if (hw.group) groupSize[hw.group] = (groupSize[hw.group] || 0) + 1;
  const useGroups = Object.values(groupSize).filter((n) => n >= 3).length >= 2;
  if (!useGroups) for (const hw of holeWays) hw.group = '';

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
      number: hw.number,
      par: Number.isFinite(hw.par) ? hw.par : null,
      group: hw.group,
      tee: hw.pts[0],
      greens: [],
      _end: end,
    };
    if (best >= 0 && bestD <= 60) {
      used.add(best);
      hole.greens.push(toGreen(greens[best]));
    }
    holes.push(hole);
  }

  // 同じコース内で番号が重複したら、後のものを番号なしにする
  const seen = new Set();
  for (const h of holes) {
    if (h.number == null) continue;
    const k = h.group + ':' + h.number;
    if (seen.has(k)) h.number = null;
    else seen.add(k);
  }

  let practice = 0;
  greens.forEach((g, i) => {
    if (used.has(i)) return;
    // 既に割り当てたグリーンの近く（80m以内）で、ティーからの距離が同じくらいなら2グリーンの片方
    let host = null, hostD = Infinity;
    for (const h of holes) {
      const ref = h.greens[0]?.center || h._end;
      const d = haversine(ref, g.center);
      const sameLength = !h.tee || !h.greens[0] || Math.abs(haversine(h.tee, g.center) - haversine(h.tee, h.greens[0].center)) < 45;
      if (d < hostD && sameLength) { hostD = d; host = h; }
    }
    if (host && hostD <= 80 && host.greens.length < 2) host.greens.push(toGreen(g));
    else if (holeWays.length) practice++;
    else holes.push({ id: uid(), number: null, par: null, group: '', tee: null, greens: [toGreen(g)], _end: g.center });
  });

  for (const h of holes) {
    delete h._end;
    if (h.greens.length === 2) nameTwoGreens(h);
    if (h.greens.length === 0) h.greens.push({ id: uid(), name: '', center: null, outline: [] });
  }
  return { holes, courseName, stats: { greens: greens.length, holeWays: holeWays.length, practice } };
}

function toGreen(g) {
  return { id: uid(), name: '', center: g.center, outline: g.outline };
}

/** 2グリーンを、ティーから見た左右で「左」「右」と名付ける。ティーが無ければ A / B。 */
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
  a.name = aIsLeft ? '左' : '右';
  b.name = aIsLeft ? '右' : '左';
  if (!aIsLeft) h.greens.reverse();
}
