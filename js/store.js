// コースデータと設定の保存（localStorage）、JSONのエクスポート・インポート。
//
// Course: { id, name, holes: Hole[] }
// Hole:   { id, number, par, tee: [lat,lon]|null, greens: Green[] }
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
        round: { holeId: null, greenIdx: {}, pinOffsets: {}, ...raw.round },
      };
    }
  } catch { /* 壊れたデータは無視して初期化 */ }
  return {
    courses: [],
    activeCourseId: null,
    settings: { ...DEFAULT_SETTINGS },
    round: { holeId: null, greenIdx: {}, pinOffsets: {} },
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
  course.holes.sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
}

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

export function activeGreen(hole = activeHole()) {
  if (!hole || hole.greens.length === 0) return null;
  const i = state.round.greenIdx[hole.id] ?? 0;
  return hole.greens[Math.min(i, hole.greens.length - 1)];
}

export function setActiveGreen(hole, idx) {
  state.round.greenIdx[hole.id] = idx;
}

/** 前後のホールへ移動 (dir: -1 / +1)。端では一周する。 */
export function stepHole(dir) {
  const c = activeCourse();
  const h = activeHole();
  if (!c || !h) return;
  const i = c.holes.indexOf(h);
  state.round.holeId = c.holes[(i + dir + c.holes.length) % c.holes.length].id;
}

const pinKey = (hole) => `${state.activeCourseId}:${hole.id}`;
export const getPinOffset = (hole) => state.round.pinOffsets[pinKey(hole)] || 0;
export function setPinOffset(hole, yd) {
  state.round.pinOffsets[pinKey(hole)] = yd;
}

export function newCourse(name) {
  const c = { id: uid(), name, holes: [] };
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
  const h = { id: uid(), number, par: null, tee: null, greens: [newGreen('')] };
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
    holes: c.holes.map((h) => ({
      id: typeof h.id === 'string' ? h.id : uid(),
      number: Number.isFinite(h.number) ? h.number : null,
      par: Number.isFinite(h.par) ? h.par : null,
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
