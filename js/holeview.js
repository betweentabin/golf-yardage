// 計測画面のホール図（2D・SVG）。
// ティー→グリーンの向きが上になるよう回転して描き、ピンの配置と地点タップでの距離確認ができる。
import { toLocal, fromLocal, greenCenter, haversine, M_TO_YD } from './geo.js';

const NS = 'http://www.w3.org/2000/svg';
const yd = (m) => Math.round(m * M_TO_YD);

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
}

export class HoleView {
  /**
   * onPin(latlng): ピン配置モードでグリーンをタップしたとき
   * onTap(latlng|null): 通常時に図をタップしたとき（もう一度タップで解除）
   */
  constructor(svg, { onPin, onTap }) {
    this.svg = svg;
    this.onPin = onPin;
    this.onTap = onTap;
    this.pinMode = false;
    this.frame = null;
    svg.addEventListener('click', (e) => this.handleTap(e));
  }

  /** 画面上の点 → 緯度経度 */
  toLatLng(clientX, clientY) {
    const f = this.frame;
    if (!f) return null;
    const r = this.svg.getBoundingClientRect();
    const xr = (clientX - r.left - f.ox) / f.scale + f.minX;
    const yr = f.maxY - (clientY - r.top - f.oy) / f.scale;
    // 回転を戻す
    const x = xr * f.dy + yr * f.dx;
    const y = -xr * f.dx + yr * f.dy;
    return fromLocal(f.origin, [x, y]).map((v) => +v.toFixed(7));
  }

  handleTap(e) {
    const p = this.toLatLng(e.clientX, e.clientY);
    if (!p) return;
    if (this.pinMode) this.onPin(p);
    else this.onTap(p);
  }

  /**
   * hole, green: 表示するホールと使うグリーン
   * pos, acc: 現在地と誤差 (m)。無ければ null
   * pin: ピン位置。無ければグリーン中心に薄く表示
   * tap: 通常時にタップした地点
   */
  render({ hole, green, pos, acc, pin, tap }) {
    const svg = this.svg;
    const W = svg.clientWidth, H = svg.clientHeight;
    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const center = greenCenter(green);
    if (!hole || !center || W < 20 || H < 20) { this.frame = null; return; }

    // ---- 向き: ティー→グリーン。ティーが無ければ現在地→グリーン、どちらも無ければ北が上
    const origin = center;
    const from = hole.tee || (pos && haversine(pos, center) > 20 ? pos : null);
    let dx = 0, dy = 1;
    if (from) {
      const [fx, fy] = toLocal(origin, from);
      const n = Math.hypot(fx, fy);
      if (n > 1) { dx = -fx / n; dy = -fy / n; }
    }
    // ローカル座標 (東, 北) → 回転後 (右, 上)
    const rot = (p) => {
      const [x, y] = toLocal(origin, p);
      return [x * dy - y * dx, x * dx + y * dy];
    };

    const greens = hole.greens.filter((g) => greenCenter(g));
    const pinPt = pin || center;
    const near = pos && haversine(pos, center) < 700 ? pos : null; // 遠すぎる現在地は枠に入れない

    // ---- 枠に入れる点
    const pts = [];
    const circle = (c, r) => { for (let a = 0; a < 8; a++) pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]); };
    if (this.pinMode) {
      if (green.outline.length >= 3) pts.push(...green.outline.map(rot));
      else circle(rot(center), 15);
      circle(rot(pinPt), 3);
    } else {
      for (const g of greens) {
        if (g.outline.length >= 3) pts.push(...g.outline.map(rot));
        else circle(rot(greenCenter(g)), 12);
      }
      // 現在地があれば「現在地からグリーンまで」を写し、近づくほど拡大する。
      // ティーは、ティー付近より後ろにいるときだけ入れる
      const dGreen = near ? haversine(near, center) : Infinity;
      if (hole.tee && (!near || dGreen > haversine(hole.tee, center) - 30)) pts.push(rot(hole.tee));
      if (near) circle(rot(near), 10);
      if (tap) pts.push(rot(tap));
    }
    let minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]));
    let minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]));
    const margin = this.pinMode ? 4 : 14;
    minX -= margin; maxX += margin; minY -= margin; maxY += margin;
    // 上は説明文、下はボタンの分だけ空ける
    const padX = 10, padTop = this.pinMode ? 44 : 24, padBottom = this.pinMode ? 54 : 14;
    const scale = Math.min((W - padX * 2) / (maxX - minX), (H - padTop - padBottom) / (maxY - minY));
    const ox = (W - (maxX - minX) * scale) / 2;
    const oy = padTop + (H - padTop - padBottom - (maxY - minY) * scale) / 2;
    this.frame = { origin, dx, dy, minX, maxY, scale, ox, oy };
    const S = (p) => { const [x, y] = rot(p); return [ox + (x - minX) * scale, oy + (maxY - y) * scale]; };
    const m = (meters) => meters * scale;

    // ---- フェアウェイ（ティー→グリーンの帯）
    if (!this.pinMode && hole.tee) {
      const [x1, y1] = S(hole.tee), [x2, y2] = S(center);
      el('line', { x1, y1, x2, y2, class: 'hv-fairway', 'stroke-width': Math.max(8, m(32)) }, svg);
    }

    // ---- ピンからの距離の輪（50yd ごと）
    if (!this.pinMode) {
      const [px, py] = S(pinPt);
      for (let r = 50; r <= 300; r += 50) {
        const rr = m(r / M_TO_YD);
        if (rr > Math.hypot(W, H)) break;
        el('circle', { cx: px, cy: py, r: rr, class: 'hv-ring' }, svg);
        // ラベルは輪の左側
        const t = el('text', { x: px - rr * 0.71, y: py + rr * 0.71, class: 'hv-ring-label' }, svg);
        t.textContent = r;
      }
    }

    // ---- グリーン
    for (const g of greens) {
      const used = g === green;
      const cls = used ? 'hv-green' : 'hv-green-off';
      if (g.outline.length >= 3) {
        el('polygon', { points: g.outline.map((p) => S(p).join(',')).join(' '), class: cls }, svg);
      } else {
        const [cx, cy] = S(greenCenter(g));
        el('circle', { cx, cy, r: m(12), class: cls }, svg);
      }
      if (!used && !this.pinMode && g.name) {
        const [cx, cy] = S(greenCenter(g));
        const t = el('text', { x: cx, y: cy + 4, class: 'hv-green-name' }, svg);
        t.textContent = g.name;
      }
    }

    // ---- ピン配置モード: 手前から 5yd ごとの目盛り
    if (this.pinMode && green.outline.length >= 3) {
      const ys = green.outline.map((p) => rot(p)[1]);
      const front = Math.min(...ys), back = Math.max(...ys);
      const step = 5 / M_TO_YD;
      const every = step * scale < 16 ? 2 : 1; // 目盛りが詰まるときは10ydごとに数字
      for (let k = 1; front + k * step < back; k++) {
        const y = oy + (maxY - (front + k * step)) * scale;
        el('line', { x1: 0, y1: y, x2: W, y2: y, class: k % 2 ? 'hv-tick hv-tick-minor' : 'hv-tick' }, svg);
        if (k % every) continue;
        const t = el('text', { x: 6, y: y + 4, class: 'hv-tick-label' }, svg);
        t.textContent = `${k * 5}`;
      }
      const f = el('text', { x: W / 2, y: oy + (maxY - front) * scale + 16, class: 'hv-edge-label' }, svg);
      f.textContent = '手前';
      const b = el('text', { x: W / 2, y: oy + (maxY - back) * scale - 6, class: 'hv-edge-label' }, svg);
      b.textContent = '奥';
    }

    // ---- ティー
    if (!this.pinMode && hole.tee) {
      const [tx, ty] = S(hole.tee);
      el('rect', { x: tx - 6, y: ty - 4, width: 12, height: 8, rx: 2, class: 'hv-tee' }, svg);
    }

    // ---- 現在地 → ピンの線と残り
    const [px, py] = S(pinPt);
    if (near && !this.pinMode) {
      const [ux, uy] = S(near);
      el('line', { x1: ux, y1: uy, x2: px, y2: py, class: 'hv-line' }, svg);
    }

    // ---- タップした地点（刻み位置の確認）
    if (tap && !this.pinMode) {
      const [qx, qy] = S(tap);
      if (near) {
        const [ux, uy] = S(near);
        el('line', { x1: ux, y1: uy, x2: qx, y2: qy, class: 'hv-tap-line' }, svg);
      }
      el('line', { x1: qx, y1: qy, x2: px, y2: py, class: 'hv-tap-line' }, svg);
      el('circle', { cx: qx, cy: qy, r: 6, class: 'hv-tap' }, svg);
      const lines = [];
      if (near) lines.push(`ここまで ${yd(haversine(near, tap))}`);
      lines.push(`ピンまで ${yd(haversine(tap, pinPt))}`);
      const right = qx < W / 2;
      lines.forEach((s, i) => {
        const t = el('text', { x: qx + (right ? 12 : -12), y: qy - 6 + i * 18, class: 'hv-tap-label', 'text-anchor': right ? 'start' : 'end' }, svg);
        t.textContent = s;
      });
    }

    // ---- ピン（旗）
    const flag = el('g', { class: pin ? 'hv-flag' : 'hv-flag hv-flag-unset' }, svg);
    el('line', { x1: px, y1: py, x2: px, y2: py - 26, class: 'hv-flag-pole' }, flag);
    el('path', { d: `M${px},${py - 26} l14,5 l-14,5 z`, class: 'hv-flag-cloth' }, flag);
    el('circle', { cx: px, cy: py, r: 3, class: 'hv-flag-cup' }, flag);

    // ---- 現在地
    if (near) {
      const [ux, uy] = S(near);
      if (acc) el('circle', { cx: ux, cy: uy, r: Math.max(6, m(acc)), class: 'hv-acc' }, svg);
      el('circle', { cx: ux, cy: uy, r: 7, class: 'hv-me' }, svg);
    } else if (pos && !this.pinMode) {
      const t = el('text', { x: W / 2, y: H - 8, class: 'hv-note' }, svg);
      t.textContent = 'このホールから離れています';
    }
  }
}
