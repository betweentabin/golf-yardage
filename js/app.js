// 画面の組み立て：計測、設定、タブ切り替え、画面の常時点灯、ホール自動判定。
import { greenDistances, toYd, greenCenter, distToSegment, haversine } from './geo.js';
import {
  state, commit, subscribe, activeCourse, activeHole, activeGreen, setActiveGreen, stepHole, setHole,
  getPin, setPin, setGreenPref, newCourse, exportJSON, importJSON, roundPlan, endRound, holeLabel,
} from './store.js';
import { Tracker } from './position.js';
import { MapView } from './map.js';
import { initSelect } from './select.js';
import { HoleView } from './holeview.js';

const $ = (id) => document.getElementById(id);
const tracker = new Tracker(() => state.settings);
let gps = { status: 'off' };

// ---------------- バナー ----------------
function showBanner(text) {
  $('banner-text').textContent = text;
  $('banner').hidden = false;
}
$('banner-close').onclick = () => ($('banner').hidden = true);

// ---------------- タブ ----------------
let currentView = 'measure';
let mapView = null;
function showView(name) {
  currentView = name;
  for (const v of ['measure', 'select', 'map', 'settings']) $('view-' + v).hidden = v !== name;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'map') {
    if (!mapView) mapView = new MapView({ tracker, showBanner, getGps: () => gps });
    mapView.show();
  }
  if (name === 'settings') renderSettings();
  if (name === 'select') select.render();
}
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => showView(b.dataset.view)));

// ---------------- 計測画面 ----------------
const fmt = (m) => (m == null ? '---' : String(Math.round(toYd(m))));

function renderMeasure() {
  const course = activeCourse();
  const hole = activeHole();
  const plan = roundPlan();
  $('course-name').textContent = course ? course.name : 'ゴルフ場を選ぶ';
  $('hole-num').textContent = hole ? holeLabel(hole) : '--';
  $('round-progress').textContent = plan ? `${plan.idx + 1}/${plan.order.length}ホール目` : '';
  $('hole-par').textContent = hole?.par ? `Par${hole.par}` : '';
  $('auto-badge').hidden = !state.settings.autoHole;

  // 2グリーン切り替え
  const seg = $('green-switch');
  if (hole && hole.greens.length > 1) {
    const cur = activeGreen(hole);
    seg.replaceChildren(
      ...hole.greens.map((g, i) => {
        const b = document.createElement('button');
        b.textContent = g.name || `G${i + 1}`;
        b.classList.toggle('on', g === cur);
        // 2グリーンはその日どちらかを使うので、全ホールまとめて切り替える
        b.onclick = () => { if (g.name) setGreenPref(g.name); else setActiveGreen(hole, i); commit(); };
        return b;
      })
    );
    seg.hidden = false;
  } else seg.hidden = true;

  const green = activeGreen(hole);
  let noData = '';
  if (!course) noData = '「ゴルフ場」タブでゴルフ場を選んでください';
  else if (!hole) noData = '「地図」タブでホールを登録してください';
  else if (!greenCenter(green)) noData = 'このホールにはグリーンが登録されていません。「地図」タブ→「編集」で登録できます';
  $('no-data').textContent = noData;
  $('no-data').hidden = !noData;
  $('distances').hidden = !!noData;

  // 距離。ピンを置いていればピンまで、なければグリーン中心まで
  const pin = getPin(green);
  const showDist = (gps.status === 'fixed' || gps.status === 'moving') && green && !noData;
  const d = showDist ? greenDistances(gps.pos, green) : null;
  $('d-pin').textContent = fmt(d && (pin ? haversine(gps.pos, pin) : d.center));
  $('pin-label').textContent = pin ? 'ピン' : '中心';
  $('d-center').textContent = fmt(d?.center);
  $('d-front').textContent = fmt(d?.front);
  $('d-back').textContent = fmt(d?.back);
  $('distances').classList.toggle('dim', !d);

  // 測位状態
  const texts = {
    off: '測位していません',
    error: gps.message || '現在地を取得できません',
    searching: gps.message || '測位中…',
    moving: '移動中',
    fixed: `確定（${gps.n}点平均）`,
  };
  $('gps-dot').className = 'dot ' + (gps.stale && gps.status === 'fixed' ? 'moving' : gps.status);
  let text = texts[gps.status];
  if (gps.stale && (gps.status === 'fixed' || gps.status === 'moving')) text = '更新が止まっています（最後の位置）';
  $('gps-text').textContent = state.settings.simulate ? '[テスト] ' + text : text;
  const acc = gps.status === 'fixed' || gps.status === 'moving' ? gps.acc : gps.rawAcc;
  $('gps-acc').textContent = acc != null ? `±${acc < 10 ? acc.toFixed(1) : Math.round(acc)}m` : '';

  // ホールが変わったら、ピン配置モードとタップ地点を解除
  if (hole?.id !== lastHoleId) {
    lastHoleId = hole?.id;
    tapPoint = null;
    if (holeView.pinMode) setPinMode(false);
  }
  if (!noData) renderHole();
}
let lastHoleId = null;

$('prev-hole').onclick = () => manualStep(-1);
$('next-hole').onclick = () => manualStep(1);
$('course-name').onclick = () => showView('select');
function manualStep(dir) {
  if (stepHole(dir) === 'end') {
    if (!confirm('最終ホールです。ラウンドを終了しますか？')) return;
    endRound();
    select.reset();
    commit();
    showView('select');
    return;
  }
  autoHole.candidate = null;
  autoHole.suppressUntil = Date.now() + 60_000; // 手動で切り替えたら1分は自動判定しない
  commit();
}

// ---------------- ホール図とピン ----------------
let tapPoint = null;
const holeView = new HoleView($('hole-view'), {
  onPin: (p) => {
    const green = activeGreen();
    if (!green) return;
    setPin(green, p);
    setPinMode(false);
    commit();
  },
  onTap: (p) => {
    tapPoint = tapPoint ? null : p; // もう一度タップで消す
    renderHole();
  },
});

function setPinMode(on) {
  holeView.pinMode = on;
  $('pin-mode').textContent = on ? 'やめる' : 'ピンを置く';
  $('pin-mode').classList.toggle('primary', !on);
  $('pin-center').hidden = !on;
  tapPoint = null;
  renderHole();
}
$('pin-mode').onclick = () => setPinMode(!holeView.pinMode);
$('pin-center').onclick = () => {
  const green = activeGreen();
  if (green) setPin(green, null);
  setPinMode(false);
  commit();
};

function renderHole() {
  const hole = activeHole();
  const green = activeGreen(hole);
  const live = gps.status === 'fixed' || gps.status === 'moving';
  $('hv-hint').textContent = holeView.pinMode
    ? 'ピンの位置をタップ（横線は手前から5ydごと）'
    : getPin(green) ? '' : 'ピン位置を置くと、ピンまでの距離になります';
  holeView.render({
    hole,
    green,
    pos: live ? gps.pos : null,
    acc: live ? gps.acc : null,
    pin: getPin(green),
    tap: tapPoint,
  });
}
window.addEventListener('resize', () => renderHole());

// ---------------- ホール自動判定 ----------------
const autoHole = { candidate: null, count: 0, suppressUntil: 0 };

/** 現在地からホール（ティー〜グリーン中心の線分、なければグリーン中心）までの距離 */
function holeDistance(pos, hole) {
  let best = Infinity;
  for (const g of hole.greens) {
    const c = greenCenter(g);
    if (!c) continue;
    best = Math.min(best, hole.tee ? distToSegment(pos, hole.tee, c) : haversine(pos, c));
  }
  if (hole.tee) best = Math.min(best, haversine(pos, hole.tee));
  return best;
}

function runAutoHole() {
  if (!state.settings.autoHole || Date.now() < autoHole.suppressUntil) return;
  if (gps.status !== 'fixed' && gps.status !== 'moving') return;
  const course = activeCourse();
  const cur = activeHole();
  if (!course || !cur) return;
  // ラウンド中は、回る予定のホールだけから選ぶ
  const plan = roundPlan();
  const candidates = plan ? course.holes.filter((h) => plan.order.includes(h.id)) : course.holes;
  let best = null, bestD = Infinity;
  for (const h of candidates) {
    const d = holeDistance(gps.pos, h);
    if (d < bestD) { bestD = d; best = h; }
  }
  if (!best || best === cur || bestD > 150) { autoHole.candidate = null; return; }
  // 今のホールより10m以上近い状態が3回続いたら切り替える（境界でのばたつき防止）
  if (holeDistance(gps.pos, cur) - bestD < 10) { autoHole.candidate = null; return; }
  if (autoHole.candidate === best.id) autoHole.count++;
  else { autoHole.candidate = best.id; autoHole.count = 1; }
  if (autoHole.count >= 3) {
    setHole(best.id);
    autoHole.candidate = null;
    commit();
  }
}

tracker.on((st) => {
  gps = st;
  runAutoHole();
  renderMeasure();
  mapView?.onGps(st);
});

// ---------------- 設定画面 ----------------
function renderSettings() {
  const sel = $('course-select');
  sel.replaceChildren(
    ...(state.courses.length
      ? state.courses.map((c) => new Option(c.name, c.id, false, c.id === state.activeCourseId))
      : [new Option('（コースがありません）', '')])
  );
  const c = activeCourse();
  if (c) {
    const withGreen = c.holes.filter((h) => h.greens.some((g) => greenCenter(g))).length;
    const withOutline = c.holes.filter((h) => h.greens.some((g) => g.outline.length >= 3)).length;
    const withTee = c.holes.filter((h) => h.tee).length;
    $('course-summary').textContent = `${c.holes.length}ホール（グリーン中心 ${withGreen} / 外形 ${withOutline} / ティー ${withTee}）`;
  } else $('course-summary').textContent = '';

  const s = state.settings;
  $('set-acc').value = s.accThreshold;
  $('set-still-r').value = s.stillRadius;
  $('set-still-s').value = s.stillSeconds;
  $('set-theme').value = s.theme;
  $('set-tiles').value = s.tiles;
  $('set-autohole').checked = s.autoHole;
  $('set-simulate').checked = s.simulate;
  renderEnv();
}

function renderEnv() {
  const items = [
    `HTTPS: ${window.isSecureContext ? 'OK' : 'NG（位置情報が使えません）'}`,
    `位置情報: ${'geolocation' in navigator ? '対応' : '非対応'}`,
    `画面の常時点灯: ${wake.text}`,
    `オフライン: ${swState}`,
    `ホーム画面から起動: ${navigator.standalone || matchMedia('(display-mode: standalone)').matches ? 'はい' : 'いいえ'}`,
  ];
  $('env-status').innerHTML = items.map((t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('<br>');
}

$('course-select').onchange = (e) => {
  state.activeCourseId = e.target.value || null;
  state.round.holeId = null;
  commit();
};
$('course-new').onclick = () => {
  const name = prompt('コース名', '');
  if (!name) return;
  newCourse(name.trim());
  commit();
};
$('course-rename').onclick = () => {
  const c = activeCourse();
  if (!c) return;
  const name = prompt('コース名', c.name);
  if (!name) return;
  c.name = name.trim();
  commit();
};
$('course-delete').onclick = () => {
  const c = activeCourse();
  if (!c || !confirm(`「${c.name}」を削除します。元に戻せません。`)) return;
  state.courses = state.courses.filter((x) => x !== c);
  state.activeCourseId = state.courses[0]?.id ?? null;
  state.round.holeId = null;
  commit();
};

async function shareJSON(text, filename) {
  const file = new File([text], filename, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
const safeName = (s) => s.replace(/[\\/:*?"<>|\s]+/g, '_');
$('export-course').onclick = () => {
  const c = activeCourse();
  if (!c) return alert('コースがありません');
  shareJSON(exportJSON([c]), `golf-${safeName(c.name)}.json`);
};
$('export-all').onclick = () => {
  if (!state.courses.length) return alert('コースがありません');
  shareJSON(exportJSON(state.courses), 'golf-courses.json');
};
$('import-btn').onclick = () => $('import-file').click();
$('import-file').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const n = importJSON(await f.text());
    commit();
    alert(`${n}コースを読み込みました`);
  } catch (err) {
    alert('読み込めませんでした: ' + err.message);
  }
};

$('reset-pins').onclick = () => {
  state.round.pins = {};
  commit();
};

const num = (id, min, max, key) => {
  $(id).onchange = (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v)) state.settings[key] = Math.max(min, Math.min(max, v));
    commit();
    renderSettings();
  };
};
num('set-acc', 1, 50, 'accThreshold');
num('set-still-r', 1, 20, 'stillRadius');
num('set-still-s', 1, 30, 'stillSeconds');
$('set-theme').onchange = (e) => { state.settings.theme = e.target.value; commit(); };
$('set-tiles').onchange = (e) => { state.settings.tiles = e.target.value; commit(); };
$('set-autohole').onchange = (e) => {
  state.settings.autoHole = e.target.checked;
  autoHole.suppressUntil = 0;
  commit();
};
$('set-simulate').onchange = (e) => {
  state.settings.simulate = e.target.checked;
  if (!e.target.checked) tracker.setSimulated(null);
  commit();
};

// ---------------- 画面の常時点灯 ----------------
const wake = { lock: null, text: '確認中' };
function setWake(text) {
  wake.text = text;
  $('wake-status').textContent = text === '有効' ? '画面は自動で消えません' : '';
}
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) {
    setWake('非対応');
    showBanner('この環境では画面を点けたままにできません。iPhoneの「設定 > 画面表示と明るさ > 自動ロック」を「なし」にしてください。');
    return;
  }
  if (document.visibilityState !== 'visible' || wake.lock) return;
  try {
    wake.lock = await navigator.wakeLock.request('screen');
    setWake('有効');
    wake.lock.addEventListener('release', () => {
      wake.lock = null;
      setWake('解除（アプリに戻ると再開）');
    });
  } catch {
    setWake('失敗');
    showBanner('画面の常時点灯を有効にできませんでした。画面をタップするか、「設定 > 画面表示と明るさ > 自動ロック」を「なし」にしてください。');
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestWakeLock();
});
// iOS はユーザー操作の後でないと失敗することがあるので、最初のタップでも試す
document.addEventListener('click', () => { if (!wake.lock) requestWakeLock(); }, { capture: true });

// ---------------- オフライン（Service Worker） ----------------
let swState = '確認中';
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(
    (reg) => {
      swState = reg.active ? '準備完了' : 'キャッシュ中';
      navigator.serviceWorker.ready.then(() => { swState = '準備完了'; });
    },
    () => { swState = '利用不可'; }
  );
} else swState = '非対応';

// ---------------- 起動 ----------------
function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme;
}
const select = initSelect({
  getGps: () => gps,
  showView,
  showBanner,
  openRegister: () => {
    showView('map');
    mapView.openRegister();
  },
});

subscribe(() => {
  applyTheme();
  renderMeasure();
  if (currentView === 'settings') renderSettings();
  if (currentView === 'select') select.render();
  mapView?.refresh();
});
applyTheme();
renderMeasure();
// ラウンド中でなく、ゴルフ場も選ばれていなければ選ぶ画面から始める
if (!roundPlan() && !activeCourse()) showView('select');
tracker.start();
requestWakeLock();
