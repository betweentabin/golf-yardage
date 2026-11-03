// 地図表示とコースデータの手動編集（Leaflet）。
/* global L */
import { centroid, greenCenter, haversine, pointInPolygon, toYd } from './geo.js';
import {
  state, commit, activeCourse, activeHole, activeGreen, setActiveGreen, stepHole, setHole,
  newCourse, newHole, newGreen, sortHoles, holeLabel,
} from './store.js';
import { fetchGolf, buildHoles } from './osm.js';
import { traceGreenAt } from './trace.js';

const $ = (id) => document.getElementById(id);
const ll = (p) => L.latLng(p[0], p[1]);
const pt = (latlng) => [+latlng.lat.toFixed(7), +latlng.lng.toFixed(7)];
const yd = (m) => Math.round(toYd(m));

const TILES = {
  gsi: {
    url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
    // crossOrigin: 写真の画素を読んでグリーンをなぞるため、CORS で取得する
    opt: { maxNativeZoom: 18, maxZoom: 21, crossOrigin: 'anonymous', attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>' },
  },
  osm: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    opt: { maxNativeZoom: 19, maxZoom: 21, crossOrigin: 'anonymous', attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>' },
  },
};

const TOP_BAR = 100; // 地図上部のボタン類の高さ (px)

const labelIcon = (text, cls = '') =>
  L.divIcon({ className: '', html: `<span class="pt-label ${cls}">${text}</span>`, iconSize: [0, 0] });

export class MapView {
  constructor({ tracker, showBanner, getGps }) {
    this.tracker = tracker;
    this.showBanner = showBanner;
    this.getGps = getGps;
    this.editing = false;
    this.mode = null;   // null | 'outline' | 'center' | 'tee' | 'sampling' | 'trace' | 'register'
    this.reg = null;    // 写真から順に登録: { holeIds, i, slot }  slot 0 = 1面目(左), 1 = 2面目(右)
    this.tracing = false;
    this.draft = [];
    this.fittedHoleId = null;

    this.map = L.map('map', { zoomControl: false, maxZoom: 21, tapHold: true });
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(this.map);
    this.tileKey = null;
    this.courseLayer = L.layerGroup().addTo(this.map);
    this.editLayer = L.layerGroup().addTo(this.map);
    this.draftLayer = L.layerGroup().addTo(this.map);
    this.measureLayer = L.layerGroup().addTo(this.map);
    this.meLayer = L.layerGroup().addTo(this.map);

    this.map.on('click', (e) => this.onMapClick(e));
    this.map.on('contextmenu', (e) => this.onLongPress(e));
    this.bindUI();
    this.setTiles();
    this.map.setView([36.2, 138.3], 5);
  }

  // ---------- 画面との接続 ----------
  bindUI() {
    $('map-prev').onclick = () => { stepHole(-1); commit(); this.fitHole(); };
    $('map-next').onclick = () => { stepHole(1); commit(); this.fitHole(); };
    $('map-hole-select').onchange = (e) => { setHole(e.target.value); commit(); this.fitHole(); };
    $('map-green-select').onchange = (e) => {
      const h = activeHole();
      if (!h) return;
      if (e.target.value === '__add') return this.action('add-green');
      setActiveGreen(h, Number(e.target.value));
      commit();
    };
    $('map-locate').onclick = () => {
      const g = this.getGps();
      if (g.pos) this.centerOn(g.pos, Math.max(this.map.getZoom(), 17));
      else alert('現在地がまだ取れていません');
    };
    $('map-fit').onclick = () => this.fitHole();
    $('map-edit-toggle').onclick = () => {
      this.editing = !this.editing;
      this.setMode(null);
      if (this.editing) this.fitGreen();
    };
    $('mode-cancel').onclick = () => { this.reg = null; this.setMode(null); };
    $('mode-skip').onclick = () => this.regAdvance();
    $('mode-undo').onclick = () => { this.draft.pop(); this.renderDraft(); };
    $('mode-done').onclick = () => this.finishOutline();
    document.querySelectorAll('#edit-buttons [data-act]').forEach((b) => (b.onclick = () => this.action(b.dataset.act)));
  }

  show() {
    this.map.invalidateSize();
    this.refresh();
    if (this.fittedHoleId !== state.round.holeId) this.fitHole();
  }

  setTiles() {
    const key = TILES[state.settings.tiles] ? state.settings.tiles : 'gsi';
    if (key === this.tileKey) return;
    this.tile?.remove();
    this.tile = L.tileLayer(TILES[key].url, TILES[key].opt).addTo(this.map);
    this.tileKey = key;
  }

  fitHole() {
    const hole = activeHole();
    this.fittedHoleId = state.round.holeId;
    const pts = [];
    if (hole) {
      if (hole.tee) pts.push(hole.tee);
      for (const g of hole.greens) {
        pts.push(...g.outline);
        const c = greenCenter(g);
        if (c) pts.push(c);
      }
    }
    // ホール情報がまだ無いときは、ゴルフ場にいれば現在地、自宅などで登録するならゴルフ場の位置
    const loc = activeCourse()?.loc;
    const me = this.getGps().pos;
    if (pts.length === 1) this.centerOn(pts[0], 18);
    else if (pts.length > 1) this.fitVisible(pts, 19);
    else if (me && (!loc || haversine(me, loc) < 3000)) this.centerOn(me, 17);
    else if (loc) this.centerOn(loc, 16);
  }

  // 地図の上部はボタン、編集中は下部がパネルで隠れるので、見えている範囲に収める
  hiddenBottom() {
    return this.editing ? $('edit-panel').offsetHeight || 0 : 0;
  }

  fitVisible(pts, maxZoom) {
    this.map.fitBounds(L.latLngBounds(pts.map(ll)), {
      paddingTopLeft: [40, TOP_BAR + 20], paddingBottomRight: [40, this.hiddenBottom() + 40], maxZoom,
    });
  }

  centerOn(p, zoom) {
    this.map.setView(ll(p), zoom, { animate: false });
    this.map.panBy([0, (this.hiddenBottom() - TOP_BAR) / 2], { animate: false });
  }

  /** 編集しやすいよう、選択中のグリーンに寄せる（下半分は編集パネルで隠れる） */
  fitGreen() {
    const g = activeGreen();
    const pts = g ? [...g.outline, ...(greenCenter(g) ? [greenCenter(g)] : [])] : [];
    if (pts.length === 0) return this.fitHole();
    if (pts.length === 1) this.centerOn(pts[0], 19);
    else this.fitVisible(pts, 20);
  }

  // ---------- 描画 ----------
  refresh() {
    if ($('view-map').hidden) return;
    this.setTiles();
    const course = activeCourse();
    const hole = activeHole();
    const green = activeGreen(hole);

    const hs = $('map-hole-select');
    hs.replaceChildren(
      ...(course?.holes.length
        ? course.holes.map((h) => new Option(`${holeLabel(h)}${h.par ? ' P' + h.par : ''}`, h.id, false, h === hole))
        : [new Option('ホールなし', '')])
    );
    const gs = $('map-green-select');
    const gOpts = (hole?.greens || []).map((g, i) => new Option(g.name || `G${i + 1}`, i, false, g === green));
    if (this.editing && hole) gOpts.push(new Option('＋追加', '__add'));
    gs.replaceChildren(...gOpts);
    gs.hidden = !hole || (hole.greens.length < 2 && !this.editing);

    $('map-edit-toggle').classList.toggle('on', this.editing);
    $('edit-panel').hidden = !this.editing;
    $('edit-buttons').hidden = !!this.mode;

    this.renderCourse(course, hole, green);
    this.renderHandles(hole, green);
    this.renderDraft();
  }

  renderCourse(course, hole, green) {
    this.courseLayer.clearLayers();
    if (!course) return;
    for (const h of course.holes) {
      const active = h === hole;
      for (const g of h.greens) {
        const sel = active && g === green;
        if (g.outline.length >= 3) {
          L.polygon(g.outline.map(ll), {
            interactive: false,
            color: sel ? '#ffe600' : active ? '#ffffff' : '#ffffff',
            weight: sel ? 4 : 2,
            opacity: active ? 1 : 0.7,
            fillOpacity: sel ? 0.2 : 0.08,
            dashArray: active ? null : '4 4',
          }).addTo(this.courseLayer);
        }
        const c = greenCenter(g);
        if (c && !(this.editing && sel && g.center)) {
          const text = active ? (h.greens.length > 1 ? g.name || '中心' : '中心') : `${h.number ?? '?'}${h.greens.length > 1 ? g.name : ''}`;
          L.marker(ll(c), { icon: labelIcon(text, sel ? 'center' : ''), interactive: false }).addTo(this.courseLayer);
        }
      }
      if (active && h.tee) {
        const c = greenCenter(green);
        if (c) L.polyline([ll(h.tee), ll(c)], { interactive: false, color: '#4fc3f7', weight: 2, dashArray: '6 6' }).addTo(this.courseLayer);
        if (!this.editing) L.marker(ll(h.tee), { icon: labelIcon(`T${h.number ?? ''}`, 'tee'), interactive: false }).addTo(this.courseLayer);
      }
    }
  }

  /** 編集中のハンドル：外形の頂点、中心、ティー */
  renderHandles(hole, green) {
    this.editLayer.clearLayers();
    if (!this.editing || !hole || !green || this.mode === 'outline') return;

    green.outline.forEach((p, i) => {
      const m = L.marker(ll(p), {
        draggable: true,
        icon: L.divIcon({ className: 'vx-handle', iconSize: [18, 18] }),
      }).addTo(this.editLayer);
      m.on('dragend', () => { green.outline[i] = pt(m.getLatLng()); commit(); });
      m.on('click', () => {
        if (green.outline.length <= 3) return alert('頂点は3つ以上必要です');
        green.outline.splice(i, 1);
        commit();
      });
    });

    const c = green.center;
    if (c) {
      const m = L.marker(ll(c), { draggable: true, icon: labelIcon('中心', 'center') }).addTo(this.editLayer);
      m.on('dragend', () => { green.center = pt(m.getLatLng()); commit(); });
    }
    if (hole.tee) {
      const m = L.marker(ll(hole.tee), { draggable: true, icon: labelIcon(`T${hole.number ?? ''}`, 'tee') }).addTo(this.editLayer);
      m.on('dragend', () => { hole.tee = pt(m.getLatLng()); commit(); });
    }
  }

  renderDraft() {
    this.draftLayer.clearLayers();
    if (this.mode !== 'outline') return;
    if (this.draft.length) {
      L.polyline(this.draft.map(ll), { color: '#ff2d55', weight: 3, interactive: false }).addTo(this.draftLayer);
      if (this.draft.length >= 3) {
        L.polyline([ll(this.draft.at(-1)), ll(this.draft[0])], { color: '#ff2d55', weight: 2, dashArray: '4 4', interactive: false }).addTo(this.draftLayer);
      }
      for (const p of this.draft) L.circleMarker(ll(p), { radius: 5, color: '#ff2d55', fillOpacity: 1, interactive: false }).addTo(this.draftLayer);
    }
    $('edit-mode-text').textContent = `外形: グリーンの縁をタップ（${this.draft.length}点）`;
    $('mode-done').disabled = this.draft.length < 3;
  }

  onGps(st) {
    this.meLayer.clearLayers();
    if (!st.pos) return;
    const color = st.status === 'fixed' ? '#0a7d32' : st.status === 'moving' ? '#c76a00' : '#b00020';
    const acc = st.status === 'fixed' || st.status === 'moving' ? st.acc : st.rawAcc;
    if (acc) L.circle(ll(st.pos), { radius: acc, color, weight: 1, fillOpacity: 0.15, interactive: false }).addTo(this.meLayer);
    L.circleMarker(ll(st.pos), { radius: 8, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1, interactive: false }).addTo(this.meLayer);
    if (this.measureTarget) this.renderMeasure(this.measureTarget);
  }

  // ---------- 操作 ----------
  setMode(mode, text = '') {
    this.mode = mode;
    this.draft = [];
    $('edit-mode-bar').hidden = !mode;
    $('edit-mode-text').textContent = text;
    $('mode-undo').hidden = mode !== 'outline';
    $('mode-done').hidden = mode !== 'outline';
    $('mode-cancel').hidden = mode === 'sampling';
    $('mode-skip').hidden = mode !== 'register';
    $('mode-cancel').textContent = mode === 'register' ? '終了' : 'やめる';
    this.refresh();
  }

  onMapClick(e) {
    const p = pt(e.latlng);
    const hole = activeHole();
    const green = activeGreen(hole);
    if (this.mode === 'outline') {
      this.draft.push(p);
      this.renderDraft();
      return;
    }
    if (this.mode === 'center' && green) {
      green.center = p;
      this.setMode(null);
      commit();
      return;
    }
    if (this.mode === 'tee' && hole) {
      hole.tee = p;
      this.setMode(null);
      commit();
      return;
    }
    if (this.mode === 'trace' || this.mode === 'register') {
      this.traceAt(p);
      return;
    }
    if (this.mode) return;
    // 通常時：タップした地点までの距離を表示（刻み位置の確認用）
    if (this.measureTarget) {
      this.measureTarget = null;
      this.measureLayer.clearLayers();
      $('map-info').hidden = true;
    } else this.renderMeasure(p);
  }

  renderMeasure(p) {
    this.measureTarget = p;
    this.measureLayer.clearLayers();
    const gps = this.getGps();
    const c = greenCenter(activeGreen());
    const parts = [];
    const line = [];
    const me = gps.status === 'fixed' || gps.status === 'moving' ? gps.pos : null;
    if (me) { parts.push(`現在地から ${yd(haversine(me, p))}yd`); line.push(ll(me)); }
    line.push(ll(p));
    if (c) { parts.push(`グリーン中心まで ${yd(haversine(p, c))}yd`); line.push(ll(c)); }
    if (line.length > 1) L.polyline(line, { color: '#fff', weight: 3, dashArray: '2 6', interactive: false }).addTo(this.measureLayer);
    L.circleMarker(ll(p), { radius: 7, color: '#000', fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(this.measureLayer);
    $('map-info').textContent = parts.join(' ／ ') || 'グリーンも現在地もありません';
    $('map-info').hidden = false;
  }

  // ---------- 航空写真からグリーンをなぞる ----------

  /** p をタップしたグリーンをなぞり、今のグリーン（登録モードなら順番の枠）に入れる */
  async traceAt(p) {
    if (this.tracing) return;
    this.tracing = true;
    const keepText = $('edit-mode-text').textContent;
    $('edit-mode-text').textContent = '航空写真からなぞっています…';
    let r;
    try {
      r = await traceGreenAt(p, TILES.gsi.url);
    } catch (e) {
      r = { ok: false, reason: e.message };
    }
    this.tracing = false;
    const target = this.traceTarget();
    if (!target) return this.setMode(null);
    if (r.ok) {
      target.green.outline = r.outline;
      target.green.center = centroid(r.outline);
    } else {
      $('edit-mode-text').textContent = keepText;
      if (!confirm(`うまくなぞれませんでした: ${r.reason}\n\nタップした地点をグリーン中心として登録しますか？（外形なし。手前・奥は出ません）`)) return;
      target.green.outline = [];
      target.green.center = p;
    }
    commit();
    if (this.mode === 'register') this.regAdvance(true);
    else this.setMode(null);
  }

  /** なぞった結果を入れる先。登録モードでは左→右の順に枠を用意する */
  traceTarget() {
    if (this.mode !== 'register') {
      const hole = this.ensureHole();
      if (!hole) return null;
      if (!hole.greens.length) hole.greens.push(newGreen(''));
      return { hole, green: activeGreen(hole) };
    }
    const hole = activeCourse()?.holes.find((h) => h.id === this.reg.holeIds[this.reg.i]);
    if (!hole) return null;
    if (this.reg.slot === 1) {
      if (hole.greens.length < 2) hole.greens.push(newGreen(''));
      hole.greens[0].name = '左';
      hole.greens[1].name = '右';
    }
    if (!hole.greens.length) hole.greens.push(newGreen(''));
    return { hole, green: hole.greens[this.reg.slot] };
  }

  /** スタート選択画面から: 編集を開いて、今のホールから写真で登録を始める */
  openRegister() {
    this.editing = true;
    this.fitHole();
    this.startRegister();
  }

  startRegister() {
    const course = this.ensureCourse();
    if (!course) return;
    const holes = course.holes.filter((h) => h.number != null);
    if (!holes.length) return alert('番号の付いたホールがありません。先に「＋ホール」で作ってください');
    const cur = holes.indexOf(activeHole());
    this.reg = { holeIds: holes.map((h) => h.id), i: Math.max(0, cur), slot: 0 };
    this.setMode('register');
    this.regShow();
  }

  /** 次の枠へ。traced なら1面登録した直後 */
  regAdvance(traced = false) {
    if (!this.reg) return;
    if (this.reg.slot === 0 && traced) {
      this.reg.slot = 1; // 2グリーンなら右も
    } else {
      this.reg.slot = 0;
      this.reg.i++;
    }
    if (this.reg.i >= this.reg.holeIds.length) {
      this.reg = null;
      this.setMode(null);
      alert('最後のホールまで終わりました。計測画面で距離を確認できます。');
      return;
    }
    this.regShow();
  }

  regShow() {
    const course = activeCourse();
    const hole = course.holes.find((h) => h.id === this.reg.holeIds[this.reg.i]);
    setHole(hole.id);
    setActiveGreen(hole, this.reg.slot);
    commit();
    const n = `${this.reg.i + 1}/${this.reg.holeIds.length}`;
    $('edit-mode-text').textContent = this.reg.slot === 0
      ? `${holeLabel(hole)}（${n}）: グリーンをタップ。2グリーンなら左から`
      : `${holeLabel(hole)}: 右グリーンをタップ。1グリーンなら「次へ」`;
    $('mode-skip').textContent = this.reg.slot === 0 ? 'このホールは飛ばす' : '次へ';
  }

  onLongPress(e) {
    if (!state.settings.simulate) return;
    this.tracker.setSimulated(pt(e.latlng));
  }

  finishOutline() {
    const green = activeGreen();
    if (!green || this.draft.length < 3) return;
    green.outline = this.draft;
    const c = centroid(green.outline);
    if (!green.center || confirm('グリーン中心を、描いた外形の重心に合わせますか？')) green.center = c;
    this.setMode(null);
    commit();
  }

  ensureCourse() {
    if (activeCourse()) return activeCourse();
    const name = prompt('先にコースを作成します。コース名', '');
    if (!name) return null;
    const c = newCourse(name.trim());
    commit();
    return c;
  }

  ensureHole() {
    const c = this.ensureCourse();
    if (!c) return null;
    if (activeHole()) return activeHole();
    const h = newHole(c);
    state.round.holeId = h.id;
    commit();
    return h;
  }

  async action(act) {
    if (act === 'osm') return this.importOSM();
    if (act === 'register') return this.startRegister();
    if (act === 'cache-tiles') return this.cacheTiles();

    const course = this.ensureCourse();
    if (!course) return;

    if (act === 'add-hole') {
      const h = newHole(course);
      state.round.holeId = h.id;
      commit();
      return;
    }

    const hole = this.ensureHole();
    if (!hole) return;
    if (hole.greens.length === 0) hole.greens.push(newGreen(''));
    const green = activeGreen(hole);

    switch (act) {
      case 'outline':
        if (green.outline.length && !confirm('今の外形を消して描き直しますか？')) return;
        this.setMode('outline');
        break;
      case 'center':
        this.setMode('center', '中心: グリーン中心をタップ');
        break;
      case 'trace':
        this.setMode('trace', `写真から: ${holeLabel(hole)}${green.name ? ' ' + green.name : ''}のグリーンの真ん中をタップ`);
        break;
      case 'tee':
        this.setMode('tee', `ティー: ${hole.number ?? '?'}番のティーをタップ`);
        break;
      case 'center-centroid':
        if (green.outline.length < 3) return alert('先に外形を描いてください');
        green.center = centroid(green.outline);
        commit();
        break;
      case 'center-gps':
        await this.registerCenterByGps(green);
        break;
      case 'hole-props': {
        const n = prompt('ホール番号', hole.number ?? '');
        if (n === null) return;
        const num = n.trim() === '' ? null : parseInt(n, 10);
        const grp = prompt('コース名（東・西など。1コースだけなら空欄）', hole.group || '');
        if (grp === null) return;
        const group = grp.trim();
        if (num != null && course.holes.some((h) => h !== hole && h.number === num && (h.group || '') === group) &&
            !confirm(`${group ? group + 'コースの' : ''}${num}番は既にあります。重複させますか？`)) return;
        const p = prompt('Par（空欄可）', hole.par ?? '');
        hole.number = Number.isFinite(num) ? num : null;
        hole.group = group;
        if (p !== null) hole.par = parseInt(p, 10) || null;
        sortHoles(course);
        commit();
        break;
      }
      case 'add-green': {
        const name = prompt('グリーン名（例: L / R / A / B）', hole.greens.length === 1 ? 'R' : '');
        if (name === null) return;
        if (hole.greens.length === 1 && !hole.greens[0].name) hole.greens[0].name = name.trim() === 'R' ? 'L' : 'A';
        hole.greens.push(newGreen(name.trim()));
        setActiveGreen(hole, hole.greens.length - 1);
        commit();
        break;
      }
      case 'del-green':
        if (!confirm(`グリーン「${green.name || '1'}」を削除しますか？`)) return;
        hole.greens.splice(hole.greens.indexOf(green), 1);
        if (hole.greens.length === 0) hole.greens.push(newGreen(''));
        setActiveGreen(hole, 0);
        commit();
        break;
      case 'del-hole':
        if (!confirm(`${hole.number ?? '?'}番ホールを削除しますか？`)) return;
        course.holes.splice(course.holes.indexOf(hole), 1);
        state.round.holeId = null;
        commit();
        break;
    }
  }

  async registerCenterByGps(green) {
    const s = state.settings;
    if (!confirm(`グリーン中心に立って、動かずに待ってください。\n15秒間、誤差${s.accThreshold}m以内の測位を平均して中心に登録します。`)) return;
    this.setMode('sampling', '測位を集めています…');
    try {
      const r = await this.tracker.sample(15_000, (n, left) => {
        $('edit-mode-text').textContent = `測位中… ${n}点 / 残り${left}秒`;
      });
      this.setMode(null);
      const moved = green.center ? `（今の中心から ${haversine(green.center, r.pos).toFixed(1)}m）` : '';
      const outside = green.outline.length >= 3 && !pointInPolygon(r.pos, green.outline)
        ? '\n※登録済みの外形の外側です。外形がずれている可能性があります。' : '';
      if (confirm(`${r.n}点の平均、誤差 約±${r.acc.toFixed(1)}m です${moved}。中心として登録しますか？${outside}`)) {
        green.center = r.pos.map((v) => +v.toFixed(7));
        commit();
      }
    } catch (e) {
      this.setMode(null);
      alert(e.message + '\n空の開けた場所で、もう一度試してください。');
    }
  }

  async importOSM() {
    const b = this.map.getBounds();
    const diag = haversine([b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]);
    if (diag > 6000) return alert('範囲が広すぎます。ゴルフ場全体が入る程度まで拡大してください。');
    $('edit-buttons').hidden = true;
    $('edit-mode-bar').hidden = false;
    $('edit-mode-text').textContent = 'OpenStreetMapから取得中…';
    let result;
    try {
      const json = await fetchGolf([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((v) => v.toFixed(6)), (n) => {
        $('edit-mode-text').textContent = `サーバー混雑のため再試行中…（${n}回目）`;
      });
      result = buildHoles(json);
    } catch (e) {
      this.setMode(null);
      return alert('取得できませんでした: ' + e.message);
    }
    this.setMode(null);
    const { holes, courseName, stats } = result;
    if (holes.length === 0) {
      return alert('この範囲にはグリーンが登録されていませんでした。手動で「＋ホール」→「外形を描く」で登録してください。');
    }
    const numbered = holes.filter((h) => h.number != null).length;
    const msg = `グリーン ${stats.greens}面、ホール ${stats.holeWays}本 を見つけました（番号付き ${numbered}ホール）。`;

    let course = activeCourse();
    if (course && course.holes.length === 0 && confirm(`${msg}\n空のコース「${course.name}」に取り込みますか？`)) {
      course.holes = holes;
    } else {
      const name = prompt(`${msg}\n新しいコースとして作成します。コース名`, courseName || '');
      if (!name) return;
      course = newCourse(name.trim());
      course.holes = holes;
    }
    sortHoles(course);
    state.round.holeId = course.holes[0].id;
    commit();
    this.fitHole();
    if (holes.some((h) => h.number == null)) {
      this.showBanner('番号のないホールがあります。地図で確認して「番号・Par」で番号を付けてください。');
    }
  }

  /** 表示範囲の地図タイルを読み込み、Service Worker にキャッシュさせる */
  async cacheTiles() {
    const b = this.map.getBounds();
    const t = TILES[this.tileKey];
    const zMax = Math.min(t.opt.maxNativeZoom, 18);
    const tiles = [];
    for (let z = 15; z <= zMax; z++) {
      const nw = this.map.project(b.getNorthWest(), z).divideBy(256).floor();
      const se = this.map.project(b.getSouthEast(), z).divideBy(256).floor();
      for (let x = nw.x; x <= se.x; x++)
        for (let y = nw.y; y <= se.y; y++) tiles.push(t.url.replace('{z}', z).replace('{x}', x).replace('{y}', y));
    }
    if (tiles.length > 600) return alert(`タイルが多すぎます（${tiles.length}枚）。ゴルフ場が収まる程度まで拡大してください。`);
    if (!navigator.serviceWorker?.controller) return alert('オフライン用のキャッシュがまだ準備できていません。一度アプリを開き直してください。');
    if (!confirm(`${tiles.length}枚の地図画像を保存します（Wi-Fi推奨）。`)) return;
    $('edit-buttons').hidden = true;
    $('edit-mode-bar').hidden = false;
    let done = 0, failed = 0;
    const queue = tiles.slice();
    const worker = async () => {
      while (queue.length) {
        const url = queue.shift();
        try { if (!(await fetch(url, { mode: 'cors' })).ok) failed++; } catch { failed++; }
        done++;
        $('edit-mode-text').textContent = `地図を保存中… ${done}/${tiles.length}`;
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    this.setMode(null);
    alert(`保存しました（${tiles.length - failed}/${tiles.length}枚）`);
  }
}
