// ゴルフ場を選ぶ画面：検索、近くのゴルフ場、保存済み、ラウンドのスタート選択。
import { greenCenter } from './geo.js';
import {
  state, commit, newCourse, newHole, sortHoles, holeLabel, roundOptions, roundPlan, startRound, endRound, activeCourse, importJSON,
} from './store.js';
import { searchCourses, nearbyCourses, fetchCourse, buildHoles } from './osm.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export function initSelect({ getGps, showView, showBanner, openRegister }) {
  let results = [];
  let setupCourse = null;
  let busy = false;

  const status = (t) => ($('search-status').textContent = t);
  const savedFor = (p) => state.courses.find((c) => c.osm && c.osm.type === p.osm.type && c.osm.id === p.osm.id);

  async function run(label, fn) {
    if (busy) return;
    busy = true;
    status(label);
    try {
      await fn();
    } catch (e) {
      status(e.message);
    } finally {
      busy = false;
    }
  }

  $('search-form').onsubmit = (e) => {
    e.preventDefault();
    const q = $('search-text').value;
    if (!q.trim()) return;
    $('search-text').blur();
    run('検索中…', async () => {
      results = await searchCourses(q);
      status(results.length ? `${results.length}件見つかりました` : '見つかりませんでした。正式名称の一部（例: 「霞ヶ関カンツリー」）で試してください');
      renderResults();
    });
  };

  $('nearby-btn').onclick = () => {
    const g = getGps();
    if (!g.pos) return status('現在地がまだ取れていません。少し待ってからもう一度押してください');
    run('近くのゴルフ場を探しています…', async () => {
      results = await nearbyCourses(g.pos);
      status(results.length ? '近い順に表示しています' : '近く（約30km）にゴルフ場が見つかりませんでした');
      renderResults();
    });
  };

  function placeItem(p) {
    const saved = savedFor(p);
    const b = el('button', 'list-item');
    const main = el('div', 'li-main');
    main.append(el('div', 'li-title', p.name));
    const sub = [p.distance != null ? `${(p.distance / 1000).toFixed(1)}km` : '', p.address].filter(Boolean).join('・');
    if (sub) main.append(el('div', 'li-sub', sub));
    b.append(main);
    if (saved) b.append(el('span', 'badge', '保存済み'));
    b.onclick = () => (saved ? openSetup(saved) : download(p));
    return b;
  }

  function renderResults() {
    $('search-results').replaceChildren(...results.map(placeItem));
  }

  /** 番号付きの全ホールにグリーンが登録されていれば「計測済み」 */
  const isMeasured = (c) => {
    const holes = c.holes.filter((h) => h.number != null);
    return holes.length > 0 && holes.every((h) => h.greens.some((g) => greenCenter(g)));
  };

  function courseItem(c) {
    const b = el('button', 'list-item');
    const main = el('div', 'li-main');
    main.append(el('div', 'li-title', c.name), el('div', 'li-sub', summary(c)));
    b.append(main);
    if (c.unverified) b.append(el('span', 'badge warn', '要確認'));
    b.onclick = () => openSetup(c);
    return b;
  }

  function renderSaved() {
    const measured = state.courses.filter(isMeasured);
    const partial = state.courses.filter((c) => !isMeasured(c));
    $('measured-list').replaceChildren(
      ...(measured.length
        ? measured.map(courseItem)
        : [el('p', 'note', 'まだありません。全ホールのグリーンを登録したゴルフ場がここに並びます。')])
    );
    $('partial-head').hidden = $('saved-list').hidden = !partial.length;
    $('saved-list').replaceChildren(...partial.map(courseItem));
  }

  // ---- アプリに同梱した計測済みゴルフ場（courses/index.json） ----
  let library = null;
  async function loadLibrary() {
    try {
      const res = await fetch('courses/index.json', { cache: 'no-cache' });
      library = res.ok ? await res.json() : [];
    } catch {
      library = [];
    }
    renderLibrary();
  }

  function renderLibrary() {
    const items = (library || []).filter((x) => x && x.file && x.name);
    const installedIds = new Set(state.courses.map((c) => c.id));
    const rest = items.filter((x) => !installedIds.has(x.id));
    $('library-head').hidden = $('library-list').hidden = !rest.length;
    $('library-list').replaceChildren(
      ...rest.map((x) => {
        const b = el('button', 'list-item');
        const main = el('div', 'li-main');
        main.append(el('div', 'li-title', x.name), el('div', 'li-sub', x.note || 'タップで追加'));
        b.append(main);
        b.append(el('span', x.verified ? 'badge' : 'badge warn', x.verified ? '計測済み' : '要確認'));
        b.onclick = () => installLibrary(x);
        return b;
      })
    );
  }

  function installLibrary(x) {
    run(`「${x.name}」を追加しています…`, async () => {
      const res = await fetch('courses/' + x.file);
      if (!res.ok) throw new Error('データを読み込めませんでした');
      importJSON(await res.text());
      const c = state.courses.find((cc) => cc.id === x.id) || state.courses.at(-1);
      if (!x.verified) c.unverified = true;
      commit();
      status('');
      openSetup(c, x.verified ? '' : 'このデータは推定を含みます。初回のラウンドで各ホールのグリーンを確かめてください。');
    });
  }

  function summary(c) {
    const groups = [...new Set(c.holes.map((h) => h.group).filter(Boolean))];
    const ready = c.holes.filter((h) => h.greens.some((g) => greenCenter(g))).length;
    return `${groups.length ? groups.join('・') + 'コース ' : ''}${c.holes.length}ホール（グリーン登録 ${ready}）`;
  }

  /** OSM からホール情報を取得して保存する。existing があれば作り直す */
  function download(place, existing = null) {
    run(`「${place.name}」のホール情報を取得中…`, async () => {
      const json = await fetchCourse(place, (n) => status(`サーバー混雑のため再試行中…（${n}回目）`));
      const { holes, stats } = buildHoles(json);
      const course = existing || newCourse(place.name, place.osm);
      course.holes = holes;
      if (Number.isFinite(place.lat) && Number.isFinite(place.lon)) course.loc = [place.lat, place.lon];
      let note = `グリーン ${stats.greens - stats.practice}面・ホール ${stats.holeWays}本を取り込みました。`;
      if (holes.filter((h) => h.number != null).length === 0) {
        // OSM にホール情報がないゴルフ場は、コース構成を聞いてホールの枠だけ作る
        course.holes = [];
        const names = prompt(
          'OpenStreetMapにこのゴルフ場のホール情報がありません。ホールの枠を作ります。\n' +
          '複数コースがあれば、コース名をカンマ区切りで入力してください（例: 出流,駒）。1コースだけなら空欄のままOK。',
          ''
        );
        const groups = names && names.trim() ? names.split(/[,、，\s]+/).map((x) => x.trim()).filter(Boolean) : [''];
        const per = prompt('1コースのホール数（18 または 9）', '18');
        const n = parseInt(per, 10) === 9 ? 9 : 18;
        for (const g of groups) for (let i = 1; i <= n; i++) newHole(course, i).group = g;
        note = `ホール情報がないため、${groups.length > 1 ? groups.join('・') + 'の' : ''}${n}ホール${groups.length > 1 ? '×' + groups.length : ''}の枠を作りました。` +
          '「写真からグリーンを登録」で、番号順にグリーンをタップしてください。';
      }
      sortHoles(course);
      commit();
      status('');
      openSetup(course, note);
    });
  }

  function openSetup(course, note = '') {
    setupCourse = course;
    $('finder').hidden = true;
    $('setup').hidden = false;
    $('setup-name').textContent = course.name;

    const missing = course.holes.filter((h) => h.number != null && !h.greens.some((g) => greenCenter(g)));
    const info = [note, summary(course)];
    if (missing.length) {
      const list = missing.length <= 6 ? missing.map(holeLabel).join('、') : `${missing.slice(0, 3).map(holeLabel).join('、')} ほか${missing.length - 3}ホール`;
      info.push(`グリーン未登録: ${list}（そのホールは距離が出ません）`);
    }
    $('setup-info').textContent = info.filter(Boolean).join('\n');

    // 東・西などのコースごとに見出しを付け、OUT / IN を横に並べる
    const opts = roundOptions(course);
    const box = $('setup-options');
    box.replaceChildren();
    if (!opts.length) box.append(el('p', 'note', '番号の付いたホールがありません。「地図で確認・修正」でホールを登録してください。'));
    let lastGroup = null;
    for (const o of opts) {
      if (o.short && o.group && o.group !== lastGroup) box.append(el('div', 'start-group', `${o.group}コース`));
      lastGroup = o.group;
      const b = el('button', 'start-btn');
      b.append(el('div', 'start-label', o.short || o.label), el('div', 'start-sub', `${o.sub}・${o.order.length}ホール`));
      b.onclick = () => {
        setupCourse = null;
        startRound(course, o);
        commit();
        showView('measure');
      };
      box.append(b);
    }
    $('setup-update').hidden = !course.osm;
    $('setup-register').hidden = missing.length === 0;
    $('setup-register').textContent = `写真からグリーンを登録（未登録 ${missing.length}ホール）`;
  }

  $('setup-back').onclick = () => {
    setupCourse = null;
    render();
  };
  $('setup-register').onclick = () => {
    state.activeCourseId = setupCourse.id;
    // 未登録の最初のホールから始める
    const first = setupCourse.holes.find((h) => h.number != null && !h.greens.some((g) => greenCenter(g)));
    if (first) state.round.holeId = first.id;
    commit();
    openRegister();
  };
  $('setup-map').onclick = () => {
    if (state.activeCourseId !== setupCourse.id) {
      state.activeCourseId = setupCourse.id;
      state.round.holeId = null;
      commit();
    }
    showView('map');
  };
  $('setup-update').onclick = () => {
    const c = setupCourse;
    if (!c?.osm) return;
    if (!confirm('OpenStreetMapから取り直します。このゴルフ場で手動修正した内容は消えます。')) return;
    const first = c.holes.flatMap((h) => h.greens).map(greenCenter).find(Boolean);
    $('setup').hidden = true;
    $('finder').hidden = false;
    download({ name: c.name, osm: c.osm, lat: first?.[0], lon: first?.[1], bbox: null }, c);
  };

  $('round-continue').onclick = () => showView('measure');
  $('round-end').onclick = () => {
    if (!confirm('ラウンドを終了しますか？')) return;
    endRound();
    commit();
  };

  function render() {
    if (setupCourse && state.courses.includes(setupCourse)) return openSetup(setupCourse);
    setupCourse = null;
    $('setup').hidden = true;
    $('finder').hidden = false;
    const p = roundPlan();
    $('round-card').hidden = !p;
    if (p) $('round-text').textContent = `ラウンド中: ${activeCourse()?.name}（${p.label}・${p.idx + 1}/${p.order.length}ホール目）`;
    renderResults();
    renderSaved();
    if (library) renderLibrary();
    else loadLibrary();
  }

  return {
    render,
    reset() {
      setupCourse = null;
    },
  };
}
