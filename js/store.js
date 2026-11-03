// コースデータと設定の保存（localStorage）、JSONのエクスポート・インポート。
//
// Course: { id, name, osm: {type, id}|null, loc: [lat,lon]|null, holes: Hole[] }  loc はゴルフ場の位置
// Hole:   { id, number, par, group, tee: [lat,lon]|null, greens: Green[] }
//         group は同じゴルフ場内のコース名（東・西など）。1コースなら ''
// Green:  { id, name, center: [lat,lon]|null, outline: [lat,lon][] }

const KEY = 'golf-yardage.v1';
export const FORMAT = 'golf-yardage';

export const DEFAULT_SETTINGS = {
  accThreshold: 4,  // 精度ゲート (m)
  stillRadius: 3,   // 静止とみなす範囲 (m)
  stillSeconds: 4,  // 静止とみなす時間 (秒)
  theme: 'light',
  tiles: 'gsi',
  autoHole: false,
  simulate: false,
};

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && Array.isArray(raw.courses)) {
      return {
        courses: raw.courses,
        activeCourseId: raw.activeCourseId ?? null,
        settings: { ...DEFAULT_SETTINGS, ...raw.settings },
        round: { holeId: null, greenIdx: {}, pins: {}, plan: null, ...raw.round },
      };
    }
  } catch { /* 壊れたデータは無視して初期化 */ }
  return {
    courses: [],
    activeCourseId: null,
    settings: { ...DEFAULT_SETTINGS },
    round: { holeId: null, greenIdx: {}, pins: {}, plan: null },
  };
}

export const state = load();
const subs = new Set();

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** 変更後に呼ぶ。保存して購読者に通知する。 */
export function commit() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    alert('保存できませんでした: ' + e.message);
  }
  for (const fn of subs) fn();
}

export const activeCourse = () => state.courses.find((c) => c.id === state.activeCourseId) || null;

export function sortHoles(course) {
  course.holes.sort((a, b) => (a.group || '').localeCompare(b.group || '') || (a.number ?? 999) - (b.number ?? 999));
}

/** ホールの表示名。例: 「西 12H」「7H」 */
export const holeLabel = (h) => `${h.group ? h.group + ' ' : ''}${h.number ?? '?'}H`;

export function activeHole() {
  const c = activeCourse();
  if (!c || c.holes.length === 0) return null;
  let h = c.holes.find((x) => x.id === state.round.holeId);
  if (!h) {
    h = c.holes[0];
    state.round.holeId = h.id;
  }
  return h;
}

/**
 * そのホールで使うグリーン。
 * 地図で個別に選んだものがあればそれ、なければ「今日は左」のような全体の指定（greenPref）に合う名前のもの
 */
export function activeGreen(hole = activeHole()) {
  if (!hole || hole.greens.length === 0) return null;
  const i = state.round.greenIdx[hole.id];
  if (i != null) return hole.greens[Math.min(i, hole.greens.length - 1)];
  const pref = state.round.greenPref && hole.greens.find((g) => g.name === state.round.greenPref);
  return pref || hole.greens[0];
}

/** 2グリーンの、今日使う側を全ホールまとめて切り替える */
export function setGreenPref(name) {
  state.round.greenPref = name;
  state.round.greenIdx = {};
}

export function setActiveGreen(hole, idx) {
  state.round.greenIdx[hole.id] = idx;
}

// ---- ラウンド ----
// plan: { courseId, label, order: holeId[], idx }  order はラウンドで回る順

/** 今のコースでラウンド中なら plan を返す */
export function roundPlan() {
  const p = state.round.plan;
  return p && p.courseId === state.activeCourseId && p.order.length ? p : null;
}

/**
 * ゴルフ場で選べるラウンドの回り方。
 * - 18ホールのコース: OUTスタート（1→18）/ INスタート（10→18→1→9）
 * - 9ホールのコースが複数: 前半・後半の組み合わせ
 */
export function roundOptions(course) {
  const groups = new Map();
  for (const h of course.holes) {
    if (h.number == null) continue;
    const g = h.group || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(h);
  }
  const opts = [];
  const nines = [];
  for (const [g, hs] of groups) {
    hs.sort((a, b) => a.number - b.number);
    const out = hs.filter((h) => h.number <= 9);
    const inn = hs.filter((h) => h.number >= 10);
    const name = g ? g + 'コース ' : '';
    if (inn.length) {
      opts.push({ group: g, label: `${name}OUTスタート`, short: 'OUTスタート', sub: '1番から', order: [...out, ...inn] });
      opts.push({ group: g, label: `${name}INスタート`, short: 'INスタート', sub: '10番から', order: [...inn, ...out] });
    } else nines.push([g, out]);
  }
  if (nines.length === 1) {
    const [g, hs] = nines[0];
    opts.push({ group: g, label: `${g ? g + 'コース ' : ''}9ホール`, sub: `1〜${hs.length}番`, order: hs });
    opts.push({ group: g, label: `${g ? g + 'コース ' : ''}2周（18ホール）`, sub: '1番から2回', order: [...hs, ...hs] });
  } else {
    for (const [a, ha] of nines)
      for (const [b, hb] of nines)
        if (a !== b) opts.push({ group: a, label: `${a || '?'} → ${b || '?'}`, sub: `前半 ${a}コース・後半 ${b}コース`, order: [...ha, ...hb] });
  }
  return opts;
}

export function startRound(course, opt) {
  state.activeCourseId = course.id;
  state.round = {
    holeId: opt.order[0].id,
    greenIdx: {},
    greenPref: state.round.greenPref ?? null, // 2グリーンの左右は前回の選択を引き継ぐ
    pins: {}, // ピン位置は日ごとに変わるのでリセット
    plan: { courseId: course.id, label: opt.label, order: opt.order.map((h) => h.id), idx: 0, startedAt: Date.now() },
  };
}

export function endRound() {
  state.round.plan = null;
}

/** ホールを直接選ぶ。ラウンド中なら何ホール目かも合わせる */
export function setHole(id) {
  state.round.holeId = id;
  const p = roundPlan();
  if (!p) return;
  // 同じホールを2回回る場合は、今に近い方
  let best = -1;
  p.order.forEach((x, i) => { if (x === id && (best < 0 || Math.abs(i - p.idx) < Math.abs(best - p.idx))) best = i; });
  if (best >= 0) p.idx = best;
}

/**
 * 前後のホールへ移動 (dir: -1 / +1)。
 * ラウンド中は回る順に進み、最終ホールの先では 'end' を返す。それ以外は一周する。
 */
export function stepHole(dir) {
  const p = roundPlan();
  if (p) {
    const i = p.idx + dir;
    if (i >= p.order.length) return 'end';
    if (i < 0) return;
    p.idx = i;
    state.round.holeId = p.order[i];
    return;
  }
  const c = activeCourse();
  const h = activeHole();
  if (!c || !h) return;
  const i = c.holes.indexOf(h);
  state.round.holeId = c.holes[(i + dir + c.holes.length) % c.holes.length].id;
}

// ピン位置はグリーンごとに [lat, lon] で持つ（2グリーンは左右それぞれ）
const pinKey = (green) => `${state.activeCourseId}:${green.id}`;
export const getPin = (green) => (green && state.round.pins?.[pinKey(green)]) || null;
export function setPin(green, p) {
  state.round.pins ||= {};
  if (p) state.round.pins[pinKey(green)] = p;
  else delete state.round.pins[pinKey(green)];
}

export function newCourse(name, osm = null) {
  const c = { id: uid(), name, osm, holes: [] };
  state.courses.push(c);
  state.activeCourseId = c.id;
  state.round.holeId = null;
  return c;
}

export function newHole(course, number = null) {
  const used = new Set(course.holes.map((h) => h.number));
  if (number == null) {
    number = 1;
    while (used.has(number)) number++;
  }
  const h = { id: uid(), number, par: null, group: '', tee: null, greens: [newGreen('')] };
  course.holes.push(h);
  sortHoles(course);
  return h;
}

export const newGreen = (name) => ({ id: uid(), name, center: null, outline: [] });

// ---- エクスポート・インポート ----

export function exportJSON(courses) {
  return JSON.stringify(
    { format: FORMAT, version: 1, exportedAt: new Date().toISOString(), courses },
    null,
    1
  );
}

const isPt = (p) => Array.isArray(p) && p.length === 2 && p.every((v) => Number.isFinite(v));

function sanitizeCourse(c) {
  if (!c || typeof c.name !== 'string' || !Array.isArray(c.holes)) throw new Error('コースの形式が不正です');
  return {
    id: typeof c.id === 'string' ? c.id : uid(),
    name: c.name.slice(0, 100),
    osm: c.osm && /^(way|relation|node)$/.test(c.osm.type) && Number.isFinite(c.osm.id) ? { type: c.osm.type, id: c.osm.id } : null,
    loc: isPt(c.loc) ? c.loc : null,
    unverified: c.unverified === true, // 推定を含むデータ（現地で確認が必要）
    holes: c.holes.map((h) => ({
      id: typeof h.id === 'string' ? h.id : uid(),
      number: Number.isFinite(h.number) ? h.number : null,
      par: Number.isFinite(h.par) ? h.par : null,
      group: typeof h.group === 'string' ? h.group.slice(0, 20) : '',
      tee: isPt(h.tee) ? h.tee : null,
      greens: (Array.isArray(h.greens) ? h.greens : []).map((g) => ({
        id: typeof g.id === 'string' ? g.id : uid(),
        name: typeof g.name === 'string' ? g.name.slice(0, 20) : '',
        center: isPt(g.center) ? g.center : null,
        outline: Array.isArray(g.outline) ? g.outline.filter(isPt) : [],
      })),
    })),
  };
}

/** 同じIDのコースは上書き、それ以外は追加。取り込んだコース数を返す。 */
export function importJSON(text) {
  const data = JSON.parse(text);
  if (data?.format !== FORMAT || !Array.isArray(data.courses)) {
    throw new Error('このアプリのエクスポートファイルではありません');
  }
  const courses = data.courses.map(sanitizeCourse);
  for (const c of courses) {
    sortHoles(c);
    const i = state.courses.findIndex((x) => x.id === c.id);
    if (i >= 0) state.courses[i] = c;
    else state.courses.push(c);
  }
  if (!activeCourse() && courses[0]) state.activeCourseId = courses[0].id;
  return courses.length;
}
