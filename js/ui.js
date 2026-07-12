// ============================================================
// ui.js — 共通UI部品
// リング（円形プログレス）・ボトムシート・トースト・日付ユーティリティ
// ============================================================

// HTMLに埋め込む文字列を無害化する（XSS＝悪意あるスクリプト混入の防止）
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// 数値表示（不要な小数を出さない）
export function fmt(n, digits = 0) {
  if (n == null || isNaN(n)) return '-';
  const p = 10 ** digits;
  return (Math.round(n * p) / p).toLocaleString('ja-JP');
}

// ---- 日付ユーティリティ（すべて端末ローカル時刻基準） ----
export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// 日付文字列から曜日の1文字（日〜土）を返す
export function weekdayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
}
export function dateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  const t = todayStr();
  const suffix = dateStr === t ? '（今日）' : dateStr === addDays(t, -1) ? '（昨日）' : `（${w}）`;
  return `${d.getMonth() + 1}月${d.getDate()}日${suffix}`;
}

// ---- リングUI（円形プログレスバー） ----
// pct: 0〜1超も可（表示は100%で頭打ち）
export function ring({ pct, color, size = 120, stroke = 10, center = '', sub = '', label = '' }) {
  const r = (size - stroke) / 2;
  const cir = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, pct || 0));
  const dash = cir * p;
  return `
  <div class="ring-wrap" style="width:${size}px">
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${esc(label)} ${Math.round(p * 100)}%">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--ring-track)" stroke-width="${stroke}"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
        stroke-linecap="round" stroke-dasharray="${dash} ${cir}" transform="rotate(-90 ${size / 2} ${size / 2})"
        class="ring-arc"/>
    </svg>
    <div class="ring-center">
      <div class="ring-val">${center}</div>
      ${sub ? `<div class="ring-sub">${sub}</div>` : ''}
    </div>
    ${label ? `<div class="ring-label">${esc(label)}</div>` : ''}
  </div>`;
}

// ---- ボトムシート（画面下からせり上がるパネル） ----
let sheetCloseCb = null;

export function openSheet(title, bodyHTML, { onClose = null } = {}) {
  const host = document.getElementById('sheet-host');
  sheetCloseCb = onClose;
  host.innerHTML = `
    <div class="sheet-backdrop" data-close-sheet></div>
    <div class="sheet" role="dialog" aria-label="${esc(title)}">
      <div class="sheet-handle"></div>
      <div class="sheet-head">
        <div class="sheet-title">${esc(title)}</div>
        <button class="icon-btn" data-close-sheet aria-label="閉じる">✕</button>
      </div>
      <div class="sheet-body">${bodyHTML}</div>
    </div>`;
  requestAnimationFrame(() => host.classList.add('open'));
  return host.querySelector('.sheet-body');
}

export function closeSheet() {
  const host = document.getElementById('sheet-host');
  if (!host.classList.contains('open')) return;
  host.classList.remove('open');
  const cb = sheetCloseCb; sheetCloseCb = null;
  setTimeout(() => { host.innerHTML = ''; if (cb) cb(); }, 200);
}

// シート内の閉じるボタン・背景タップは一括処理
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close-sheet]')) closeSheet();
});

// ---- トースト（画面下部に数秒出る通知） ----
let toastTimer = null;
export function toast(msg, ms = 2400) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ---- セグメント（選択肢ボタン群）を作るヘルパー ----
export function segmented(name, options, selected) {
  return `<div class="seg" data-seg="${esc(name)}">${options.map(o =>
    `<button type="button" class="seg-btn${o.v === selected ? ' on' : ''}" data-v="${esc(o.v)}">${esc(o.label)}</button>`
  ).join('')}</div>`;
}

// セグメントのタップで on を付け替える（値は data-v から読む）
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  btn.closest('.seg').querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('on', b === btn));
});
export function segValue(root, name) {
  const el = root.querySelector(`[data-seg="${name}"] .seg-btn.on`);
  return el ? el.dataset.v : null;
}
