// 現在地の取得、精度ゲート、静止時の平均化。
import { haversine, weightedMean } from './geo.js';

const BUFFER_MS = 60_000; // 平均化に使う測位結果の保持時間
const STALE_MS = 15_000;  // この時間測位が来なければ「測位中」に戻す

/**
 * emit される状態:
 *  { status: 'off' | 'error' | 'searching' | 'moving' | 'fixed',
 *    pos, acc, rawAcc, n, message }
 */
export class Tracker {
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.listeners = new Set();
    this.buffer = [];   // 精度ゲートを通過した測位結果
    this.last = null;   // 直近の測位結果（ゲート前）
    this.state = { status: 'off' };
    this.watchId = null;
    this.simTimer = null;
    this.staleTimer = null;
  }

  on(fn) {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  emit(state) {
    this.state = state;
    for (const fn of this.listeners) fn(state);
  }

  start() {
    if (this.watchId != null) return;
    if (!('geolocation' in navigator)) {
      this.emit({ status: 'error', message: 'この端末は位置情報に対応していません' });
      return;
    }
    if (!window.isSecureContext) {
      this.emit({ status: 'error', message: '位置情報はHTTPSでのみ使えます' });
      return;
    }
    this.emit({ status: 'searching' });
    this.watchId = navigator.geolocation.watchPosition(
      (p) => {
        if (this.simPos) return;
        this.push({
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          acc: p.coords.accuracy,
          t: p.timestamp || Date.now(),
        });
      },
      (err) => {
        if (this.simPos) return;
        const msg =
          err.code === 1
            ? '位置情報の利用が許可されていません（設定 > プライバシー > 位置情報 > Safari）'
            : err.code === 3
              ? '測位がタイムアウトしました。空が開けた場所で待ってください'
              : '現在地を取得できません';
        // 一時的なエラーで直前の表示は消さない
        if (err.code === 1 || !this.last) this.emit({ status: 'error', message: msg });
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 }
    );
  }

  /** テスト用: 指定位置を測位結果として毎秒流す */
  setSimulated(pos, acc = 3) {
    clearInterval(this.simTimer);
    this.simPos = pos;
    this.buffer = [];
    if (!pos) {
      this.emit({ status: 'searching' });
      return;
    }
    const tick = () => {
      // 実機らしく ±1m 程度ゆらす
      const j = () => (Math.random() - 0.5) * 0.00002;
      this.push({ lat: pos[0] + j(), lon: pos[1] + j(), acc, t: Date.now() });
    };
    tick();
    this.simTimer = setInterval(tick, 1000);
  }

  push(fix) {
    const s = this.getSettings();
    this.last = fix;
    const now = fix.t;
    this.buffer = this.buffer.filter((f) => now - f.t <= BUFFER_MS);

    clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      this.buffer = [];
      this.emit({ status: 'searching', rawAcc: this.last?.acc, message: '測位が途切れています' });
    }, STALE_MS);

    // 精度ゲート
    if (fix.acc > s.accThreshold) {
      this.emit({ status: 'searching', rawAcc: fix.acc, pos: [fix.lat, fix.lon] });
      return;
    }
    this.buffer.push(fix);

    // 最新から遡って、平均位置から stillRadius 以内に収まる連続した測位を集める
    const group = [];
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const cand = [this.buffer[i], ...group];
      const m = weightedMean(cand).pos;
      if (cand.every((f) => haversine(m, [f.lat, f.lon]) <= s.stillRadius)) group.unshift(this.buffer[i]);
      else break;
    }
    // 静止していないなら、古い測位はもう使わない
    this.buffer = group;

    const span = (group.at(-1).t - group[0].t) / 1000;
    if (group.length >= 3 && span >= s.stillSeconds) {
      const m = weightedMean(group);
      this.emit({ status: 'fixed', pos: m.pos, acc: m.acc, rawAcc: fix.acc, n: group.length });
    } else {
      this.emit({ status: 'moving', pos: [fix.lat, fix.lon], acc: fix.acc, rawAcc: fix.acc, n: 1 });
    }
  }

  /**
   * durationMs の間、精度ゲートを通過した測位結果を集めて平均する。
   * onProgress(n, remainingSec) で途中経過を返す。
   */
  sample(durationMs, onProgress) {
    return new Promise((resolve, reject) => {
      const fixes = [];
      const started = Date.now();
      let lastT = 0;
      const off = this.on((st) => {
        const f = this.last;
        if (!f || f.t === lastT) return;
        lastT = f.t;
        if (f.acc <= this.getSettings().accThreshold && f.t >= started) fixes.push(f);
      });
      const timer = setInterval(() => {
        const left = Math.max(0, Math.ceil((durationMs - (Date.now() - started)) / 1000));
        onProgress?.(fixes.length, left);
        if (left === 0) {
          clearInterval(timer);
          off();
          if (fixes.length < 3) reject(new Error('精度の良い測位が足りません（' + fixes.length + '点）'));
          else resolve({ ...weightedMean(fixes), n: fixes.length });
        }
      }, 250);
    });
  }
}
