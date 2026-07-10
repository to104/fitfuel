// ============================================================
// charts.js — SVGグラフ描画（外部ライブラリ不使用）
// 折れ線（体重など）と棒グラフ（カロリーなど）。
// タップ/ホバーで値を表示するツールチップ付き。
// ============================================================
import { esc, fmt } from './ui.js';

const W = 360, H = 180;                       // viewBox基準サイズ（表示は横幅100%に伸縮）
const M = { l: 40, r: 10, t: 14, b: 24 };     // 余白（軸ラベル分）

// Y軸の目盛りを3本、キリのよい値で引く
function yTicks(min, max) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step = span / 2;
  return [min, min + step, max].map(v => Math.round(v * 10) / 10);
}

function yScale(min, max) {
  return v => M.t + (H - M.t - M.b) * (1 - (v - min) / (max - min || 1));
}

// 共通の枠組み（グリッド線・Y軸ラベル）を描く
function frame(min, max) {
  const sy = yScale(min, max);
  return yTicks(min, max).map(v =>
    `<line x1="${M.l}" y1="${sy(v)}" x2="${W - M.r}" y2="${sy(v)}" class="grid"/>
     <text x="${M.l - 6}" y="${sy(v) + 3}" class="ax" text-anchor="end">${fmt(v, 1)}</text>`
  ).join('');
}

// ---- 折れ線グラフ ----
// points: [{d:'YYYY-MM-DD', v:数値}]（日付昇順） opts: {color, unit, dates:[開始,終了]}
export function lineChart(container, points, opts = {}) {
  const color = opts.color || 'var(--chart-1)';
  if (!points.length) {
    container.innerHTML = '<div class="chart-empty">まだ記録がありません</div>';
    return;
  }
  const vals = points.map(p => p.v);
  let min = Math.min(...vals), max = Math.max(...vals);
  const pad = Math.max((max - min) * 0.15, 0.5);
  min -= pad; max += pad;
  const sy = yScale(min, max);

  // X座標: 期間内の日付の位置で決める（記録がない日は詰めずに空ける）
  const t0 = new Date((opts.dates?.[0] || points[0].d) + 'T00:00:00').getTime();
  const t1 = new Date((opts.dates?.[1] || points[points.length - 1].d) + 'T00:00:00').getTime();
  const sx = d => {
    const t = new Date(d + 'T00:00:00').getTime();
    return M.l + (W - M.l - M.r) * ((t - t0) / (t1 - t0 || 1));
  };
  const pts = points.map(p => ({ ...p, x: sx(p.d), y: sy(p.v) }));
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');

  const xl = (d) => { const dt = new Date(d + 'T00:00:00'); return `${dt.getMonth() + 1}/${dt.getDate()}`; };
  container.innerHTML = `
    <div class="chart">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        ${frame(min, max)}
        <path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        ${pts.map((p, i) => `<circle data-i="${i}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="${color}" stroke="var(--card)" stroke-width="2"/>`).join('')}
        <text x="${M.l}" y="${H - 6}" class="ax">${xl(points[0].d)}</text>
        <text x="${W - M.r}" y="${H - 6}" class="ax" text-anchor="end">${xl(points[points.length - 1].d)}</text>
      </svg>
      <div class="chart-tip" hidden></div>
    </div>`;
  attachHover(container, pts, p => `${xl(p.d)}　<b>${fmt(p.v, 1)}</b>${esc(opts.unit || '')}`);
}

// ---- 棒グラフ ----
// bars: [{label, v}] opts: {color, unit, target(目標線)}
export function barChart(container, bars, opts = {}) {
  const color = opts.color || 'var(--chart-1)';
  if (!bars.length || bars.every(b => !b.v)) {
    container.innerHTML = '<div class="chart-empty">まだ記録がありません</div>';
    return;
  }
  let max = Math.max(...bars.map(b => b.v), opts.target || 0) * 1.1;
  const min = 0;
  const sy = yScale(min, max);
  const band = (W - M.l - M.r) / bars.length;
  const bw = Math.max(4, Math.min(26, band - 2));   // 棒同士は最低2px空ける

  // 上端だけ4px角丸の棒を描く
  const bar = (b, i) => {
    if (!b.v) return '';
    const x = M.l + band * i + (band - bw) / 2;
    const y = sy(b.v), y0 = sy(0);
    const r = Math.min(4, bw / 2, y0 - y);
    return `<path data-i="${i}" d="M${x},${y0} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${y0} Z" fill="${color}"/>`;
  };
  // X軸ラベルは間引いて最大7個まで
  const step = Math.ceil(bars.length / 7);
  const labels = bars.map((b, i) => (i % step === 0 || i === bars.length - 1)
    ? `<text x="${M.l + band * i + band / 2}" y="${H - 6}" class="ax" text-anchor="middle">${esc(b.label)}</text>` : '').join('');

  container.innerHTML = `
    <div class="chart">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        ${frame(min, max)}
        ${bars.map(bar).join('')}
        ${opts.target ? `<line x1="${M.l}" y1="${sy(opts.target)}" x2="${W - M.r}" y2="${sy(opts.target)}" class="target-line"/>
          <text x="${W - M.r}" y="${sy(opts.target) - 4}" class="ax target-text" text-anchor="end">目標 ${fmt(opts.target)}</text>` : ''}
        ${labels}
      </svg>
      <div class="chart-tip" hidden></div>
    </div>`;
  const pts = bars.map((b, i) => ({ ...b, x: M.l + band * i + band / 2 }));
  attachHover(container, pts, p => `${esc(p.label)}　<b>${fmt(p.v)}</b>${esc(opts.unit || '')}`);
}

// タップ/マウス移動で最寄りのデータ点のツールチップを出す
function attachHover(container, pts, html) {
  const svg = container.querySelector('svg');
  const tip = container.querySelector('.chart-tip');
  const move = (e) => {
    const rect = svg.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width * W;
    let best = null, bd = Infinity;
    for (const p of pts) {
      const d = Math.abs(p.x - x);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return;
    tip.hidden = false;
    tip.innerHTML = html(best);
    const px = best.x / W * rect.width;
    tip.style.left = `${Math.max(4, Math.min(rect.width - tip.offsetWidth - 4, px - tip.offsetWidth / 2))}px`;
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', () => { tip.hidden = true; });
}
