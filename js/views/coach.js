// ============================================================
// views/coach.js — AIトレーナー画面
// 「今日のメニュー」の生成・表示・編集（削除/追加）・クイック記録。
// メニュー未生成なら日タイプ＋時間の選択画面（セットアップ）を出す。
// ============================================================
import * as db from '../db.js';
import * as coach from '../coach.js';
import * as timer from '../timer.js';
import { e1rm } from '../calc.js';
import { esc, fmt, openSheet, closeSheet, toast, todayStr, dateLabel } from '../ui.js';
import { state, refresh, setTab } from '../app.js';
import { openSetSheet } from './train.js';

// バッジ（提案の種類）の表示定義
const BADGES = {
  up:    { cls: 'b-up',    label: '挑戦' },
  keep:  { cls: 'b-keep',  label: '維持' },
  light: { cls: 'b-light', label: '軽め' },
  new:   { cls: 'b-new',   label: '初挑戦' },
  user:  { cls: 'b-user',  label: '自分で追加' },
};

export async function render(root) {
  // トレ画面で表示していた日付のメニューを扱う（今日＝従来どおり／明日以降＝予定の作成）
  if (state.date < todayStr()) state.date = todayStr();   // 過去の日付では開かない
  const menu = await coach.getMenu(state.date);
  if (!menu) return renderSetup(root, state.date);
  return renderMenu(root, menu);
}

const headHTML = (date) => `
  <header class="coach-head">
    <button class="icon-btn" id="co-back" aria-label="トレ画面へ戻る">‹</button>
    <h1 class="coach-title">AIトレーナー</h1>
    <span class="coach-date">${dateLabel(date)}</span>
  </header>`;

// 見出し・文言用: 今日なら「今日」、明日以降なら「7月16日（木）」
const dayWord = (date) => date === todayStr() ? '今日' : dateLabel(date);

// セット配列を「70kg × 8回 × 3セット」形式にまとめる（バラバラなら個別表記）
function setsLabel(sets) {
  if (!sets.length) return '';
  const one = (s) => `${s.weight > 0 ? `${fmt(s.weight, 1)}kg` : '自重'}×${s.reps}`;
  const same = sets.every(s => s.weight === sets[0].weight && s.reps === sets[0].reps);
  if (same) return `${sets[0].weight > 0 ? `${fmt(sets[0].weight, 1)}kg` : '自重'} × ${sets[0].reps}回 × ${sets.length}セット`;
  return sets.map(one).join(' / ');
}

// ============================================================
// セットアップ画面（日タイプ・時間を選んで生成）
// ============================================================
async function renderSetup(root, date) {
  const [sug, split] = await Promise.all([coach.suggestDay(date), coach.getSplit()]);
  let dayKey = sug.key;
  let time = split.baseTime;
  const times = [...new Set([...coach.TIME_CHOICES, split.baseTime])].sort((a, b) => a - b);

  root.innerHTML = `
    <div class="coach-scr">
    ${headHTML(date)}
    <div class="sec-title">${esc(dayWord(date))}の日タイプ</div>
    <div class="card">
      <div class="day-seg">
        ${coach.DAY_TYPES.map(t => `
          <button class="day-btn" data-day="${t.key}">${t.label}
            ${t.key === sug.key ? '<span class="day-sug">おすすめ</span>' : `<span class="day-sug">${esc(t.mains.join('・'))}</span>`}
          </button>`).join('')}
      </div>
      <p class="hint" id="day-reason"></p>
      <div class="co-extras" id="day-extras"></div>
    </div>
    <div class="sec-title">トレーニング時間</div>
    <div class="card">
      <div class="time-seg">
        ${times.map(m => `<button class="day-btn" data-time="${m}">${m}分</button>`).join('')}
      </div>
    </div>
    <button class="btn btn-big" id="co-gen">この内容でメニューを作成</button>
    <p class="hint">追い込み部位と基本時間は 設定 →「AIトレーナー（分割パターン）」で変更できます。</p>
    </div>`;

  const update = () => {
    root.querySelectorAll('[data-day]').forEach(b => b.classList.toggle('on', b.dataset.day === dayKey));
    root.querySelectorAll('[data-time]').forEach(b => b.classList.toggle('on', +b.dataset.time === time));
    root.querySelector('#day-reason').textContent = dayKey === sug.key ? sug.reason : '';
    const day = coach.DAY_TYPES.find(t => t.key === dayKey);
    const extras = (split.extras[dayKey] || []).filter(p => !day.mains.includes(p));
    root.querySelector('#day-extras').innerHTML =
      `<span class="mut">メイン: ${esc(day.mains.join('・'))}</span>` +
      (extras.length ? `<span class="co-extra-chip">＋${esc(extras.join('・'))}</span>` : '');
  };
  update();

  root.querySelector('#co-back').onclick = () => setTab('train');
  root.querySelectorAll('[data-day]').forEach(b => b.onclick = () => { dayKey = b.dataset.day; update(); });
  root.querySelectorAll('[data-time]').forEach(b => b.onclick = () => { time = +b.dataset.time; update(); });
  root.querySelector('#co-gen').onclick = async (e) => {
    e.target.disabled = true;
    try {
      await coach.generateMenu({ dayKey, time, date });
      toast(`${dayWord(date)}のメニューを作成しました`);
    } catch (err) {
      console.error(err);
      toast('メニューを作成できませんでした: ' + err.message);
    }
    refresh();
  };
}

// ============================================================
// メニュー画面（チェックリスト＋編集）
// ============================================================
async function renderMenu(root, menu) {
  const date = menu.date;
  const isFuture = date > todayStr();   // 明日以降＝予定（閲覧・編集のみ。記録は当日から）
  const rows = await db.byDate('workouts', date);
  // 記録済み判定: 同じ種目の今日の記録があれば「済」扱い（最新の1件を表示に使う）
  const recOf = (exId) => rows
    .filter(w => w.exerciseId === exId)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];

  const day = coach.DAY_TYPES.find(t => t.key === menu.dayKey) || coach.DAY_TYPES[0];
  const est = coach.estimateMinutes(menu.items);
  const isDone = (it) => it.kind === 'warmup' ? !!it.done : !!recOf(it.exId);
  const doneCount = menu.items.filter(isDone).length;
  const warmups = menu.items.filter(it => it.kind === 'warmup');
  const exItems = menu.items.filter(it => it.kind === 'ex');

  const badge = (b) => b && BADGES[b] ? `<span class="co-badge ${BADGES[b].cls}">${BADGES[b].label}</span>` : '';

  const exRow = (it) => {
    const rec = recOf(it.exId);
    return `
    <div class="co-item${rec ? ' done' : ''}">
      <button class="co-check${isFuture && !rec ? ' plan' : ''}" data-chk-ex="${it.uid}"
        aria-label="${rec ? '記録を取り消す' : '提案どおりに全セット記録する'}">${rec ? '✓' : ''}</button>
      <button class="co-body" data-open="${it.uid}">
        <span class="co-main">
          <span class="co-name">${esc(it.name)} ${badge(it.badge)}</span>
          <span class="co-sub">${rec
            ? `済 ${esc(setsLabel(rec.sets))}${rec.pr ? ' 🏆' : ''}`
            : `${esc(setsLabel(it.sets))}・休憩${timer.fmtSec(it.rest)}`}</span>
          ${!rec && it.note ? `<span class="co-note">${esc(it.note)}</span>` : ''}
        </span>
      </button>
      ${rec ? '' : `<button class="icon-btn co-edit" data-edit="${it.uid}" aria-label="提案の重量・回数を調整">✎</button>`}
      <button class="icon-btn co-del" data-del="${it.uid}" aria-label="この種目を外す">✕</button>
    </div>`;
  };

  const wuRow = (it) => `
    <div class="co-item${it.done ? ' done' : ''}">
      <button class="co-body" data-wu="${it.uid}">
        <span class="co-check">${it.done ? '✓' : ''}</span>
        <span class="co-main">
          <span class="co-name">${esc(it.name)}</span>
          <span class="co-sub">${esc(it.detail || '')}</span>
        </span>
      </button>
      <button class="icon-btn co-del" data-del="${it.uid}" aria-label="外す">✕</button>
    </div>`;

  root.innerHTML = `
    <div class="coach-scr">
    ${headHTML(date)}
    <div class="co-meta">
      <span class="co-extra-chip">${day.label}の日</span>
      <span class="co-time-chip">目安 約${est}分 / ${menu.time}分</span>
    </div>
    <div class="co-comment">
      <div class="co-comment-t">AIトレーナーから</div>
      ${esc(menu.comment)}
    </div>

    ${warmups.length ? `<div class="sec-title">ウォームアップ</div><div class="card co-list">${warmups.map(wuRow).join('')}</div>` : ''}

    <div class="sec-title">${isFuture ? 'メニュー（予定・タップで調整）' : 'メニュー（タップで記録）'}</div>
    <div class="card co-list">
      ${exItems.map(exRow).join('') || '<div class="empty-line">種目がありません。下から追加してください</div>'}
      <button class="btn-ghost" id="co-add">＋ 種目を追加</button>
    </div>

    <div class="card">
      <div class="card-head"><span>進み具合</span><b>${doneCount} / ${menu.items.length}</b></div>
      <div class="co-prog"><i style="width:${menu.items.length ? Math.round(doneCount / menu.items.length * 100) : 0}%"></i></div>
    </div>

    <button class="btn-ghost" id="co-regen">メニューを作り直す（日タイプ・時間の変更）</button>
    <p class="hint">${isFuture
      ? 'この日の予定メニューです。種目をタップすると重量・回数・セット数を調整できます。記録は当日になってからです（メニューを作り直すと調整もリセットされ、直前の記録から計算し直されます）。'
      : '□をタップすると提案どおりに全セットまとめて記録できます（✓をもう一度タップで取り消し）。種目名のタップで1セットずつ記録、✎で提案の重量・回数・セット数を調整できます。✕で外した種目は今日のメニューから消えるだけで、種目リストや過去の記録には影響しません。記録済みの種目はトレ画面からも編集できます。'}</p>
    </div>`;

  root.querySelector('#co-back').onclick = () => setTab('train');

  // ウォームアップ: タップでチェック切り替え
  root.querySelectorAll('[data-wu]').forEach(b => b.onclick = async () => {
    const it = menu.items.find(x => x.uid === +b.dataset.wu);
    it.done = !it.done;
    await coach.saveMenu(menu);
    if (it.done) timer.haptic();
    refresh();
  });

  // 種目タップ → クイック記録シート（明日以降の予定は記録できないので調整シートを開く）
  root.querySelectorAll('[data-open]').forEach(b => b.onclick = () => {
    const it = menu.items.find(x => x.uid === +b.dataset.open);
    if (!it) return;
    if (isFuture) { openEditProposal(menu, it); return; }
    openQuickLog(it, date);
  });

  // □タップ → 提案どおりに全セットを一括記録（✓済みならもう一度タップで取り消し）
  root.querySelectorAll('[data-chk-ex]').forEach(b => b.onclick = async () => {
    const it = menu.items.find(x => x.uid === +b.dataset.chkEx);
    if (!it) return;
    if (isFuture) { toast('予定メニューのため、チェック（記録）は当日からできます'); return; }
    const rec = recOf(it.exId);
    if (rec) {
      // ✓済み → 誤タップ対応として、この日のこの種目の記録を取り消せるようにする
      if (!confirm(`「${it.name}」の今日の記録を取り消しますか？\n（過去の日の記録には影響しません）`)) return;
      for (const w of rows.filter(x => x.exerciseId === it.exId)) await db.del('workouts', w.id);
      toast(`「${it.name}」の記録を取り消しました`);
    } else {
      await recordAllSets(it, date);
    }
    refresh();
  });

  // ✎ で提案の重量・回数を調整
  root.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
    const it = menu.items.find(x => x.uid === +b.dataset.edit);
    if (it) openEditProposal(menu, it);
  });

  // ✕ で今日のメニューから外す
  root.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const it = menu.items.find(x => x.uid === +b.dataset.del);
    if (!it) return;
    if (!confirm(`「${it.name}」を今日のメニューから外しますか？`)) return;
    menu.items = menu.items.filter(x => x.uid !== it.uid);
    await coach.saveMenu(menu);
    toast(`「${it.name}」を外しました`);
    refresh();
  });

  root.querySelector('#co-add').onclick = () => openAddSheet(menu);
  root.querySelector('#co-regen').onclick = async () => {
    if (!confirm('メニューを作り直しますか？\n（記録済みのトレーニングはそのまま残ります）')) return;
    await coach.clearMenu(date);
    refresh();
  };
}

// ============================================================
// □タップの一括記録
// 提案どおりの重量・回数・セット数をそのまま1件の記録として保存する。
// 保存形式・PR（自己ベスト）判定はクイック記録と同じ＝グラフ・前回比較に自動で乗る。
// ============================================================
async function recordAllSets(item, date) {
  const sets = item.sets
    .filter(s => (s.reps || 0) > 0)
    .map(s => ({ weight: s.weight || 0, reps: s.reps, rpe: null }));
  if (!sets.length) { toast('セットがありません。✎で調整してください'); return; }
  const history = await db.byIndex('workouts', 'exerciseId', item.exId);
  const sessionBest = Math.max(...sets.map(s => e1rm(s.weight, s.reps)));
  const histBest = Math.max(0, ...history.flatMap(w => w.sets.map(s => e1rm(s.weight, s.reps))));
  const pr = sessionBest > histBest && histBest > 0;
  await db.put('workouts', {
    date, exerciseId: item.exId, name: item.name, sets,
    memo: '', pr, ts: Date.now(),
  });
  timer.haptic();
  if (pr) toast(`🏆 自己ベスト更新！ 推定1RM ${fmt(sessionBest, 1)}kg`, 3500);
  else toast(`✓ 「${item.name}」を提案どおり記録しました`);
}

// ============================================================
// 種目追加シート（提案の重量・回数は前回記録から自動生成）
// ============================================================
async function openAddSheet(menu) {
  const exercises = await db.all('exercises');
  const inMenu = new Set(menu.items.filter(it => it.kind === 'ex').map(it => it.exId));
  // 部位ごとにまとめて表示（メニューに入っていない種目のみ）
  const groups = coach.EXTRA_PARTS
    .map(p => ({ part: p, list: exercises.filter(x => (x.part || 'その他') === p && !inMenu.has(x.id)) }))
    .filter(g => g.list.length);

  const body = openSheet('種目を追加', `
    <div class="food-list">
      ${groups.map(g => `
        <div class="co-group-title">${esc(g.part)}</div>
        ${g.list.map(x => `<button class="food-row" data-ex="${x.id}">
          <div><div class="food-name">${esc(x.name)}</div></div><span class="chev">›</span>
        </button>`).join('')}`).join('') || '<div class="empty-line">追加できる種目がありません</div>'}
    </div>
    <div class="co-group-title">新しい種目を登録して追加</div>
    <div class="new-ex">
      <input id="co-new-name" type="text" placeholder="新しい種目名">
      <select id="co-new-part">${coach.EXTRA_PARTS.map(p => `<option>${p}</option>`).join('')}</select>
      <button class="btn" id="co-new-add">追加</button>
    </div>
    <p class="hint">重量・回数は前回の記録から自動で提案されます（記録がない種目は自重×10回から）。<br>新しく登録した種目は、設定・トレ画面の種目リストにも追加されます。</p>`);

  // 選んだ（or 登録した）種目をこの日のメニューに足す共通処理
  const addToMenu = async (ex) => {
    const history = await db.byIndex('workouts', 'exerciseId', ex.id);
    const prop = coach.proposeFor(ex, history, { date: menu.date });
    const uid = Math.max(0, ...menu.items.map(it => it.uid)) + 1;
    menu.items.push({
      uid, kind: 'ex', exId: ex.id, name: ex.name, part: ex.part || 'その他', extra: true,
      sets: prop.sets, rest: coach.restFor(prop.sets, true),
      badge: 'user', note: prop.note,
    });
    await coach.saveMenu(menu);
    closeSheet();
    toast(`「${ex.name}」を追加しました`);
    refresh();
  };

  body.querySelectorAll('[data-ex]').forEach(b => b.onclick = () =>
    addToMenu(exercises.find(x => x.id === +b.dataset.ex)));

  // 新しい種目をその場で登録してメニューに追加（設定→トレーニング種目と同じ入力欄）
  body.querySelector('#co-new-add').onclick = async () => {
    const name = body.querySelector('#co-new-name').value.trim();
    if (!name) { toast('種目名を入力してください'); return; }
    if (exercises.some(x => x.name === name)) { toast('同じ名前の種目がすでにあります'); return; }
    const part = body.querySelector('#co-new-part').value;
    const id = await db.put('exercises', { name, part });
    await addToMenu({ id, name, part });
  };
}

// ============================================================
// 提案調整シート
// AIが提案した重量・回数・セット数を、記録する前に自分好みに変更する。
// クイック記録と同じ±操作。変更は未編集の後続セットにも引き継がれる。
// 保存先はメニュー（coachMenu）のみ＝過去の記録には影響しない。
// ============================================================
async function openEditProposal(menu, item) {
  const isFuture = menu.date > todayStr();
  const rows = item.sets.map(s => ({ w: s.weight || 0, r: s.reps || 10 }));
  if (!rows.length) rows.push({ w: 0, r: 10 });
  const edited = rows.map(() => false);
  let stepAt = -1, stepK = '';   // 開いている±パネルの行と対象（w/r）

  const body = openSheet(`${item.name}（提案の調整）`, `
    <div class="prev-box">${esc(item.note || '提案メニュー')}</div>
    <div id="ep-rows"></div>
    <button class="btn-ghost" id="ep-add">＋ セットを追加</button>
    <button class="btn btn-big" id="ep-save">この内容に変更する</button>
    <p class="hint">${isFuture ? '予定メニューのため、チェック（記録）は当日になるとできます。<br>' : ''}数値をタップすると±で調整できます。変更は後ろのセットにも引き継がれます。<br>ここで変えるのは提案（予定）だけで、過去の記録には影響しません。</p>`);

  const rowsEl = body.querySelector('#ep-rows');
  const draw = () => {
    rowsEl.innerHTML = rows.map((s, i) => `
      <div class="q-row">
        <span class="set-no">${i + 1}</span>
        <button class="q-val${stepAt === i && stepK === 'w' ? ' on' : ''}" data-i="${i}" data-k="w">${s.w > 0 ? `${fmt(s.w, 1)}<i>kg</i>` : '自重'}</button>
        <button class="q-val${stepAt === i && stepK === 'r' ? ' on' : ''}" data-i="${i}" data-k="r">${s.r}<i>回</i></button>
        ${rows.length > 1 ? `<button class="icon-btn q-del" data-rm="${i}" aria-label="このセットを減らす">✕</button>` : '<span></span>'}
      </div>
      ${stepAt === i ? `
      <div class="q-step">
        <button data-d="-1">−${stepK === 'w' ? '2.5' : '1'}</button>
        <b>${stepK === 'w' ? (s.w > 0 ? `${fmt(s.w, 1)}kg` : '自重') : `${s.r}回`}</b>
        <button data-d="1">＋${stepK === 'w' ? '2.5' : '1'}</button>
      </div>` : ''}`).join('');
  };
  draw();

  rowsEl.onclick = (e) => {
    // ±パネルの開閉（重量・回数の数値ボタン）
    const val = e.target.closest('.q-val');
    if (val) {
      const i = +val.dataset.i, k = val.dataset.k;
      if (stepAt === i && stepK === k) { stepAt = -1; } else { stepAt = i; stepK = k; }
      draw();
      return;
    }
    // ±ボタン: 値を変更し、未編集の後続セットにも引き継ぐ
    const st = e.target.closest('[data-d]');
    if (st && stepAt >= 0) {
      const d = +st.dataset.d, s = rows[stepAt];
      if (stepK === 'w') s.w = Math.max(0, Math.round((s.w + d * 2.5) * 10) / 10);
      else s.r = Math.max(1, s.r + d);
      edited[stepAt] = true;
      for (let j = stepAt + 1; j < rows.length; j++) {
        if (!edited[j]) { rows[j].w = s.w; rows[j].r = s.r; }
      }
      draw();
      return;
    }
    // ✕: このセットを減らす
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      const i = +rm.dataset.rm;
      rows.splice(i, 1);
      edited.splice(i, 1);
      stepAt = -1;
      draw();
    }
  };

  body.querySelector('#ep-add').onclick = () => {
    const last = rows[rows.length - 1];
    rows.push({ w: last.w, r: last.r });
    edited.push(true);   // コピーした行は引き継ぎで上書きしない
    stepAt = -1;
    draw();
  };

  body.querySelector('#ep-save').onclick = async () => {
    item.sets = rows.map(s => ({ weight: s.w, reps: s.r, rpe: null }));
    item.rest = coach.restFor(item.sets, !!item.extra);
    if (!(item.note || '').includes('自分で調整')) {
      item.note = (item.note ? `${item.note}・` : '') + '自分で調整';
    }
    await coach.saveMenu(menu);
    closeSheet();
    toast(`「${item.name}」の提案を変更しました`);
    refresh();
  };
}

// ============================================================
// クイック記録シート
// 提案通りなら各セットの ✓ だけ（1タップ）。数値タップで±調整でき、
// 変更は未実施の後続セットにも引き継がれる。✓のたびに途中保存＋休憩タイマー。
// 保存形式はトレ画面と同じ workouts（グラフ・PR判定・前回比較に自動で乗る）。
// ============================================================
async function openQuickLog(item, date) {
  const history = await db.byIndex('workouts', 'exerciseId', item.exId);
  const existing = history
    .filter(w => w.date === date)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))[0] || null;

  // 行の初期状態: 記録済みセット（✓固定）＋提案の残りセット
  const rows = [];
  if (existing) existing.sets.forEach(s => rows.push({ w: s.weight || 0, r: s.reps, rpe: s.rpe ?? null, done: true }));
  for (let i = rows.length; i < item.sets.length; i++) {
    rows.push({ w: item.sets[i].weight || 0, r: item.sets[i].reps || 10, rpe: null, done: false });
  }
  if (!rows.length) rows.push({ w: 0, r: 10, rpe: null, done: false });
  const edited = rows.map(() => false);

  let recId = existing?.id ?? null;
  let recTs = existing?.ts ?? null;
  let hadPr = existing?.pr || false;
  let stepAt = -1, stepK = '';   // 開いている±パネルの行と対象（w/r）

  const body = openSheet(item.name, `
    <div id="ql-rest"></div>
    <div class="prev-box">${esc(item.note || '提案メニュー')}・休憩目安 ${timer.fmtSec(item.rest)}</div>
    <div id="ql-rows"></div>
    <button class="btn-ghost" id="ql-add">＋ セットを追加</button>
    <button class="btn btn-big" id="ql-done">全セット記録して閉じる</button>
    <button class="btn-ghost" id="ql-full">キーボードで入力（RPE・メモ）</button>
    <p class="hint">数値をタップすると±で調整できます。✓で1セットずつ記録され、休憩タイマーが始まります。</p>`,
    { onClose: refresh });

  timer.mountStrip(body.querySelector('#ql-rest'));
  const rowsEl = body.querySelector('#ql-rows');

  const draw = () => {
    rowsEl.innerHTML = rows.map((s, i) => `
      <div class="q-row${s.done ? ' done' : ''}">
        <span class="set-no">${i + 1}</span>
        <button class="q-val${stepAt === i && stepK === 'w' ? ' on' : ''}" data-i="${i}" data-k="w" ${s.done ? 'disabled' : ''}>${s.w > 0 ? `${fmt(s.w, 1)}<i>kg</i>` : '自重'}</button>
        <button class="q-val${stepAt === i && stepK === 'r' ? ' on' : ''}" data-i="${i}" data-k="r" ${s.done ? 'disabled' : ''}>${s.r}<i>回</i></button>
        ${s.done
          ? '<span class="q-ok">✓</span>'
          : `<button class="q-chk" data-chk="${i}" aria-label="このセットを記録">✓</button>`}
      </div>
      ${stepAt === i && !s.done ? `
      <div class="q-step">
        <button data-d="-1">−${stepK === 'w' ? '2.5' : '1'}</button>
        <b>${stepK === 'w' ? (s.w > 0 ? `${fmt(s.w, 1)}kg` : '自重') : `${s.r}回`}</b>
        <button data-d="1">＋${stepK === 'w' ? '2.5' : '1'}</button>
      </div>` : ''}`).join('');
  };
  draw();

  // ✓済みのセットだけを保存する（PR＝自己ベスト判定つき。train.jsと同じ形式）
  const save = async () => {
    const sets = rows.filter(s => s.done && s.r > 0)
      .map(s => ({ weight: s.w, reps: s.r, rpe: s.rpe }));
    if (!sets.length) return { newPr: false };
    const sessionBest = Math.max(...sets.map(s => e1rm(s.weight, s.reps)));
    const histBest = Math.max(0, ...history
      .filter(w => recId == null || w.id !== recId)
      .flatMap(w => w.sets.map(s => e1rm(s.weight, s.reps))));
    const pr = sessionBest > histBest && histBest > 0;
    recTs = recTs || Date.now();
    const saved = pr || (hadPr && sessionBest >= histBest) || false;
    recId = await db.put('workouts', {
      ...(recId != null ? { id: recId } : {}),
      date, exerciseId: item.exId, name: item.name, sets,
      memo: '', pr: saved, ts: recTs,
    });
    const newPr = pr && !hadPr;
    hadPr = saved;
    return { newPr, sessionBest };
  };

  rowsEl.onclick = async (e) => {
    // ±パネルの開閉（重量・回数の数値ボタン）
    const val = e.target.closest('.q-val');
    if (val && !val.disabled) {
      const i = +val.dataset.i, k = val.dataset.k;
      if (stepAt === i && stepK === k) { stepAt = -1; } else { stepAt = i; stepK = k; }
      draw();
      return;
    }
    // ±ボタン: 値を変更し、未実施・未編集の後続セットにも引き継ぐ
    const st = e.target.closest('[data-d]');
    if (st && stepAt >= 0) {
      const d = +st.dataset.d, s = rows[stepAt];
      if (stepK === 'w') s.w = Math.max(0, Math.round((s.w + d * 2.5) * 10) / 10);
      else s.r = Math.max(1, s.r + d);
      edited[stepAt] = true;
      for (let j = stepAt + 1; j < rows.length; j++) {
        if (!rows[j].done && !edited[j]) { rows[j].w = s.w; rows[j].r = s.r; }
      }
      draw();
      return;
    }
    // ✓: このセットを記録して休憩タイマー開始
    const chk = e.target.closest('[data-chk]');
    if (chk) {
      const i = +chk.dataset.chk;
      rows[i].done = true;
      if (stepAt === i) stepAt = -1;
      const { newPr, sessionBest } = await save();
      timer.haptic();
      const auto = timer.getPrefs().autoTimer;
      const remaining = rows.some(s => !s.done);
      if (auto && remaining) { timer.setTo(item.rest); timer.toggle(); }
      if (newPr) toast(`🏆 自己ベスト更新！ 推定1RM ${fmt(sessionBest, 1)}kg`, 3500);
      else toast(`✓ ${rows.filter(s => s.done).length}セット目を記録${auto && remaining ? '・休憩スタート' : ''}`);
      draw();
    }
  };

  body.querySelector('#ql-add').onclick = () => {
    const last = rows[rows.length - 1];
    rows.push({ w: last.w, r: last.r, rpe: null, done: false });
    edited.push(false);
    draw();
  };

  // 全セット記録: 未実施の行もまとめて✓にして保存（提案通り全部できたとき用）
  body.querySelector('#ql-done').onclick = async () => {
    rows.forEach(s => { s.done = true; });
    const { newPr, sessionBest } = await save();
    closeSheet();
    if (newPr) toast(`🏆 自己ベスト更新！ 推定1RM ${fmt(sessionBest, 1)}kg`, 3500);
    else toast('トレーニングを記録しました');
  };

  // 従来のキーボード入力シートへ（RPE・メモを入れたいとき）
  body.querySelector('#ql-full').onclick = async () => {
    const rec = recId != null ? await db.get('workouts', recId) : null;
    closeSheet();
    openSetSheet(date, { id: item.exId, name: item.name }, rec,
      rec ? null : item.sets.map(s => ({ weight: s.weight || '', reps: s.reps, rpe: '' })));
  };
}
