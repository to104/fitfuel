// ============================================================
// train.js — トレーニング記録
// 種目選択 → セット入力（重量×回数×RPE）→ 保存時に自己ベスト判定。
// 自己ベスト＝推定1RM（1回だけ挙げられる最大重量の推定値）の過去最高更新。
// ============================================================
import * as db from '../db.js';
import { e1rm, workoutKcal, workoutsKcal } from '../calc.js';
import { esc, fmt, openSheet, closeSheet, toast, addDays, dateLabel } from '../ui.js';
import { state, refresh } from '../app.js';

export async function render(root) {
  const date = state.date;
  const [rows, profile, loggedWeight] = await Promise.all([
    db.byDate('workouts', date),
    db.getSetting('profile', {}),
    db.latestWeightUpTo(date),
  ]);
  rows.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  // 消費カロリー推定に使う体重（その日以前の記録→なければプロフィール値）
  const bw = loggedWeight ?? profile.weight ?? 0;
  const burn = workoutsKcal(rows, bw);

  root.innerHTML = `
    <header class="page-head">
      <div class="date-nav">
        <button class="icon-btn" data-day="-1">‹</button>
        <div class="date-title">${dateLabel(date)}</div>
        <button class="icon-btn" data-day="1">›</button>
      </div>
    </header>

    ${burn ? `
    <div class="card burn-card">
      <div class="card-head"><span>🔥 推定消費カロリー</span><b>約 ${fmt(burn)} kcal</b></div>
      <div class="burn-note">METs法（運動強度×体重×時間）による概算。1セット≒3分・RPEで強度を補正しています。目標カロリーには加算しません（活動量係数と重複するため）。</div>
    </div>` : ''}

    ${rows.map(w => `
      <button class="card wo-card" data-wo="${w.id}">
        <div class="wo-head">
          <span class="wo-name">${esc(w.name)}${w.pr ? ' <span class="pr-badge">🏆 PR</span>' : ''}</span>
          <span class="wo-vol">${fmt(vol(w))} kg${bw ? `・約${fmt(Math.round(workoutKcal(w, bw)))}kcal` : ''}</span>
        </div>
        <div class="wo-sets">
          ${w.sets.map((s, i) => `<span class="wo-set">${i + 1}. ${fmt(s.weight, 1)}kg × ${s.reps}${s.rpe ? ` @${s.rpe}` : ''}</span>`).join('')}
        </div>
        ${w.memo ? `<div class="wo-memo">${esc(w.memo)}</div>` : ''}
      </button>`).join('') || '<div class="card empty-card">今日のトレーニングはまだ記録がありません</div>'}

    <button class="btn btn-big" id="wo-add">＋ 種目を記録する</button>`;

  root.querySelectorAll('[data-day]').forEach(b => b.onclick = () => {
    state.date = addDays(state.date, +b.dataset.day);
    refresh();
  });
  root.querySelector('#wo-add').onclick = () => openExercisePicker(date);
  root.querySelectorAll('[data-wo]').forEach(b => b.onclick = async () => {
    const w = await db.get('workouts', +b.dataset.wo);
    if (w) openSetSheet(date, { id: w.exerciseId, name: w.name }, w);
  });
}

// 総挙上量（重量×回数の合計＝ボリューム）
function vol(w) {
  return w.sets.reduce((s, x) => s + (x.weight || 0) * (x.reps || 0), 0);
}

// ---- 種目選択シート ----
async function openExercisePicker(date) {
  const list = await db.all('exercises');
  const body = openSheet('種目を選ぶ', `
    <div class="food-list">
      ${list.map(x => `<button class="food-row" data-ex="${x.id}">
        <div><div class="food-name">${esc(x.name)}</div><div class="food-sub">${esc(x.part || '')}</div></div>
        <span class="chev">›</span></button>`).join('')}
    </div>
    <div class="new-ex">
      <input id="ex-name" type="text" placeholder="新しい種目名">
      <select id="ex-part">${['胸', '背中', '脚', '肩', '腕', '腹', 'その他'].map(p => `<option>${p}</option>`).join('')}</select>
      <button class="btn" id="ex-add">追加</button>
    </div>`);

  body.querySelectorAll('[data-ex]').forEach(b => b.onclick = () => {
    const ex = list.find(x => x.id === +b.dataset.ex);
    openSetSheet(date, ex, null);
  });
  body.querySelector('#ex-add').onclick = async () => {
    const name = body.querySelector('#ex-name').value.trim();
    if (!name) { toast('種目名を入力してください'); return; }
    const id = await db.put('exercises', { name, part: body.querySelector('#ex-part').value });
    openSetSheet(date, { id, name }, null);
  };
}

// ---- セット入力シート ----
async function openSetSheet(date, ex, existing) {
  // 前回記録（この記録より前で同じ種目の最新）を探す
  const history = await db.byIndex('workouts', 'exerciseId', ex.id);
  const prev = history
    .filter(w => !existing || w.id !== existing.id)
    .filter(w => w.date <= date)
    .sort((a, b) => b.date.localeCompare(a.date) || (b.ts || 0) - (a.ts || 0))[0];

  const initSets = existing?.sets
    || (prev ? prev.sets.map(s => ({ ...s })) : [{ weight: '', reps: '', rpe: '' }]);

  const body = openSheet(ex.name, `
    ${prev ? `<div class="prev-box">前回（${prev.date.slice(5).replace('-', '/')}） ${prev.sets.map(s => `${fmt(s.weight, 1)}×${s.reps}`).join(' / ')}</div>`
           : '<div class="prev-box">前回記録なし — 初挑戦です</div>'}
    <div class="set-head"><span></span><span>重量 kg</span><span>回数</span><span>RPE</span><span></span></div>
    <div id="sets"></div>
    <button class="btn-ghost" id="set-add">＋ セットを追加</button>
    <label>メモ<input id="wo-memo" type="text" value="${esc(existing?.memo || '')}" placeholder="フォームの気づきなど"></label>
    <button class="btn btn-big" id="wo-save">保存する</button>
    ${existing ? '<button class="btn-danger" id="wo-del">この記録を削除</button>' : ''}`);

  const setsEl = body.querySelector('#sets');
  const addRow = (s = { weight: '', reps: '', rpe: '' }) => {
    const row = document.createElement('div');
    row.className = 'set-row';
    row.innerHTML = `
      <span class="set-no">${setsEl.children.length + 1}</span>
      <input type="number" inputmode="decimal" class="s-w" value="${s.weight ?? ''}">
      <input type="number" inputmode="numeric" class="s-r" value="${s.reps ?? ''}">
      <input type="number" inputmode="decimal" class="s-e" value="${s.rpe ?? ''}" placeholder="-">
      <button class="icon-btn s-x" aria-label="削除">✕</button>`;
    row.querySelector('.s-x').onclick = () => {
      row.remove();
      [...setsEl.children].forEach((r, i) => r.querySelector('.set-no').textContent = i + 1);
    };
    setsEl.appendChild(row);
  };
  initSets.forEach(addRow);
  // セット追加時は直前のセットの入力値をコピーする（連続セットの入力を楽にする）
  body.querySelector('#set-add').onclick = () => {
    const last = setsEl.lastElementChild;
    addRow(last ? {
      weight: last.querySelector('.s-w').value,
      reps: last.querySelector('.s-r').value,
      rpe: last.querySelector('.s-e').value,
    } : undefined);
  };

  body.querySelector('#wo-save').onclick = async () => {
    const sets = [...setsEl.children].map(r => ({
      weight: +r.querySelector('.s-w').value || 0,
      reps: +r.querySelector('.s-r').value || 0,
      rpe: +r.querySelector('.s-e').value || null,
    })).filter(s => s.weight > 0 && s.reps > 0);
    if (!sets.length) { toast('重量と回数を入力してください'); return; }

    // 自己ベスト判定: 過去全記録の推定1RM最大値と比較
    const sessionBest = Math.max(...sets.map(s => e1rm(s.weight, s.reps)));
    const histBest = Math.max(0, ...history
      .filter(w => !existing || w.id !== existing.id)
      .flatMap(w => w.sets.map(s => e1rm(s.weight, s.reps))));
    const pr = sessionBest > histBest && histBest > 0;

    await db.put('workouts', {
      ...(existing || {}),
      date, exerciseId: ex.id, name: ex.name, sets,
      memo: body.querySelector('#wo-memo').value.trim(),
      pr: pr || (existing?.pr && sessionBest >= histBest) || false,
      ts: existing?.ts || Date.now(),
    });
    closeSheet();
    if (pr) toast(`🏆 自己ベスト更新！ 推定1RM ${fmt(sessionBest, 1)}kg`, 3500);
    else toast('トレーニングを記録しました');
    refresh();
  };

  if (existing) body.querySelector('#wo-del').onclick = async () => {
    if (!confirm(`「${ex.name}」の記録を削除しますか？`)) return;
    await db.del('workouts', existing.id);
    closeSheet();
    toast('削除しました');
    refresh();
  };
}
