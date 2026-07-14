// ============================================================
// train.js — トレーニング記録
// 種目選択 → セット入力（重量×回数×RPE）→ 保存時に自己ベスト判定。
// 自己ベスト＝推定1RM（1回だけ挙げられる最大重量の推定値）の過去最高更新。
// ============================================================
import * as db from '../db.js';
import * as timer from '../timer.js';
import { e1rm, workoutKcal, workoutsKcal } from '../calc.js';
import { esc, fmt, openSheet, closeSheet, toast, dateLabel, todayStr } from '../ui.js';
import { state, refresh, setTab, changeDay } from '../app.js';

export async function render(root) {
  const date = state.date;
  const [rows, profile, loggedWeight, bright] = await Promise.all([
    db.byDate('workouts', date),
    db.getSetting('profile', {}),
    db.latestWeightUpTo(date),
    db.getSetting('accentBright', 100),   // オレンジの明るさ（%）
  ]);
  rows.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  // 消費カロリー推定に使う体重（その日以前の記録→なければプロフィール値）
  const bw = loggedWeight ?? profile.weight ?? 0;
  const burn = workoutsKcal(rows, bw);

  root.innerHTML = `
    <header class="page-head">
      <div class="date-nav">
        <button class="icon-btn" data-day="-1">‹</button>
        <button class="date-title" id="go-cal" aria-label="カレンダーで開く">${dateLabel(date)}</button>
        <button class="icon-btn" data-day="1">›</button>
      </div>
    </header>

    ${date === todayStr() ? '<div id="timer-mount"></div>' : ''}

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
          ${w.sets.map((s, i) => `<span class="wo-set">${i + 1}. ${s.weight > 0 ? `${fmt(s.weight, 1)}kg` : '自重'} × ${s.reps}${s.rpe ? ` @${s.rpe}` : ''}</span>`).join('')}
        </div>
        ${w.memo ? `<div class="wo-memo">${esc(w.memo)}</div>` : ''}
      </button>`).join('') || '<div class="card empty-card">今日のトレーニングはまだ記録がありません</div>'}

    <button class="btn btn-big" id="wo-add">＋ 種目を記録する</button>

    <div class="sec-title">画面の色</div>
    <div class="card bright-card">
      <span class="bright-ico" aria-hidden="true">🔅</span>
      <input type="range" id="accent-bright" min="50" max="150" step="5" value="${bright}" aria-label="オレンジの明るさ">
      <span class="bright-ico" aria-hidden="true">🔆</span>
      <button class="bright-val" id="bright-reset" aria-label="標準の明るさに戻す">${bright}%</button>
    </div>
    <div class="hint">この画面のオレンジ色の明るさを調整できます（%をタップで標準に戻す）</div>`;

  const tm = root.querySelector('#timer-mount');
  if (tm) timer.mountCard(tm);

  // 日付移動（画面の左右スワイプでも移動できる）
  root.querySelectorAll('[data-day]').forEach(b => b.onclick = () => changeDay(+b.dataset.day));
  // 日付タップで記録タブのカレンダーへ（この日を選択した状態で開く）
  root.querySelector('#go-cal').onclick = () => {
    state.logTab = 'cal';
    state.calMonth = date.slice(0, 7);
    state.calSel = date;
    setTab('log');
  };
  root.querySelector('#wo-add').onclick = () => openExercisePicker(date);
  root.querySelectorAll('[data-wo]').forEach(b => b.onclick = async () => {
    const w = await db.get('workouts', +b.dataset.wo);
    if (w) openSetSheet(date, { id: w.exerciseId, name: w.name }, w);
  });

  // オレンジ明るさスライダー: 動かすと即時反映、指を離したら保存
  const slider = root.querySelector('#accent-bright');
  const valBtn = root.querySelector('#bright-reset');
  slider.oninput = () => {
    setAccentVar(+slider.value);
    valBtn.textContent = `${slider.value}%`;
  };
  slider.onchange = () => db.setSetting('accentBright', +slider.value);
  valBtn.onclick = () => {
    slider.value = 100;
    setAccentVar(100);
    valBtn.textContent = '100%';
    db.setSetting('accentBright', 100);
  };
}

// ============================================================
// オレンジ明るさ調整（トレ画面の表示中だけ有効）
// CSS変数 --accent（アプリ全体のオレンジ色の定義元）をbodyに上書きする。
// タブを離れると app.js の refresh が applyAccent(false) で標準色に戻す。
// ============================================================

// 基準色: ダーク #FF9F0A = hsl(36,100%,52%)／ライト #E07800 = hsl(32,100%,44%)
// 明るさ%はHSLのL（明度）に掛けて反映する（極端に潰れないよう22〜82%に制限）
function accentColor(pct) {
  const light = matchMedia('(prefers-color-scheme: light)').matches;
  const [h, l] = light ? [32, 44] : [36, 52];
  const nl = Math.max(22, Math.min(82, Math.round(l * pct / 100)));
  return `hsl(${h} 100% ${nl}%)`;
}

function setAccentVar(pct) {
  if (pct === 100) document.body.style.removeProperty('--accent');   // 標準は上書きなし
  else document.body.style.setProperty('--accent', accentColor(pct));
}

// トレ画面の表示中だけ明るさ設定を反映する（app.jsのrefreshから毎回呼ばれる）
export async function applyAccent(on) {
  if (!on) { document.body.style.removeProperty('--accent'); return; }
  setAccentVar(await db.getSetting('accentBright', 100));
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
// 今日の記録では「✓ セット完了」で1セットずつ途中保存でき、
// 休憩タイマーが自動で始まる（ジムでの1タップ運用。設定でOFFにできる）。
async function openSetSheet(date, ex, existing) {
  // 前回記録（この記録より前で同じ種目の最新）を探す
  // ※種目名の変更で別種目に付け替えたときは取り直す（自己ベスト判定用）
  let history = await db.byIndex('workouts', 'exerciseId', ex.id);
  const prev = history
    .filter(w => !existing || w.id !== existing.id)
    .filter(w => w.date <= date)
    .sort((a, b) => b.date.localeCompare(a.date) || (b.ts || 0) - (a.ts || 0))[0];

  const initSets = existing?.sets
    || (prev ? prev.sets.map(s => ({ ...s })) : [{ weight: '', reps: '', rpe: '' }]);

  const isToday = date === todayStr();

  const body = openSheet(ex.name, `
    <div id="sheet-rest"></div>
    ${prev ? `<div class="prev-box">前回（${prev.date.slice(5).replace('-', '/')}） ${prev.sets.map(s => `${s.weight > 0 ? fmt(s.weight, 1) : '自重'}×${s.reps}`).join(' / ')}</div>`
           : '<div class="prev-box">前回記録なし — 初挑戦です</div>'}
    <div class="set-head"><span></span><span>重量 kg</span><span>回数</span><span>RPE</span><span></span></div>
    <div id="sets"></div>
    <button class="btn-ghost" id="set-add">＋ セットを追加</button>
    ${isToday ? '<button class="btn btn-big" id="wo-done">✓ セット完了（記録して休憩へ）</button>' : ''}
    <label>メモ<input id="wo-memo" type="text" value="${esc(existing?.memo || '')}" placeholder="フォームの気づきなど"></label>
    <button class="${isToday ? 'btn' : 'btn btn-big'}" id="wo-save">保存して閉じる</button>
    ${existing ? '<div id="wo-rename-box"></div>' : ''}
    ${existing ? '<button class="btn-danger" id="wo-del">この記録を削除</button>' : ''}`,
    { onClose: refresh });   // ✓で途中保存した後に✕で閉じても一覧に反映されるように

  // 休憩タイマーの残り時間・操作をシート内に表示（カウント中のみ見える）
  timer.mountStrip(body.querySelector('#sheet-rest'));

  // ✓で途中保存した後は同じ記録を上書きし続けるためIDを覚えておく
  let recId = existing?.id ?? null;
  let recTs = existing?.ts ?? null;
  let hadPr = existing?.pr || false;

  const setsEl = body.querySelector('#sets');
  // pending=true は「✓セット完了」で自動追加された次セットの候補行。
  // 入力するか次の✓で確定し、そのまま閉じた場合は保存対象にならない。
  const addRow = (s = { weight: '', reps: '', rpe: '' }, pending = false) => {
    const row = document.createElement('div');
    row.className = 'set-row' + (pending ? ' pending' : '');
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
    row.querySelectorAll('input').forEach(i =>
      i.addEventListener('input', () => row.classList.remove('pending')));
    setsEl.appendChild(row);
  };
  initSets.forEach(s => addRow(s));
  // セット追加時は直前のセットの入力値をコピーする（連続セットの入力を楽にする）
  body.querySelector('#set-add').onclick = () => {
    const last = setsEl.lastElementChild;
    addRow(last ? {
      weight: last.querySelector('.s-w').value,
      reps: last.querySelector('.s-r').value,
      rpe: last.querySelector('.s-e').value,
    } : undefined);
  };

  // 入力行からセット配列を作る（未確定行は除外。重量欄が空でなければ0kg=自重として扱う）
  const collectSets = () => [...setsEl.children]
    .filter(r => !r.classList.contains('pending'))
    .map(r => ({
      weight: parseFloat(r.querySelector('.s-w').value) || 0,
      weightGiven: r.querySelector('.s-w').value.trim() !== '',
      reps: +r.querySelector('.s-r').value || 0,
      rpe: +r.querySelector('.s-e').value || null,
    }))
    .filter(s => s.reps > 0 && (s.weight > 0 || s.weightGiven))
    .map(({ weight, reps, rpe }) => ({ weight, reps, rpe }));

  // 保存本体（自己ベスト判定つき）。✓と「保存して閉じる」で共用する
  const saveRec = async (sets) => {
    const sessionBest = Math.max(...sets.map(s => e1rm(s.weight, s.reps)));
    const histBest = Math.max(0, ...history
      .filter(w => recId == null || w.id !== recId)
      .flatMap(w => w.sets.map(s => e1rm(s.weight, s.reps))));
    const pr = sessionBest > histBest && histBest > 0;
    recTs = recTs || Date.now();
    const saved = pr || (hadPr && sessionBest >= histBest) || false;
    recId = await db.put('workouts', {
      ...(recId != null ? { id: recId } : {}),
      date, exerciseId: ex.id, name: ex.name, sets,
      memo: body.querySelector('#wo-memo').value.trim(),
      pr: saved,
      ts: recTs,
    });
    const newPr = pr && !hadPr;
    hadPr = saved;
    return { newPr, sessionBest };
  };

  // ✓ セット完了: 途中保存＋休憩タイマー自動開始＋次セット候補行を追加
  if (isToday) body.querySelector('#wo-done').onclick = async () => {
    // いま完了した扱いなので、未確定行も確定する
    [...setsEl.children].forEach(r => r.classList.remove('pending'));
    const sets = collectSets();
    if (!sets.length) { toast('重量と回数を入力してください'); return; }
    const { newPr, sessionBest } = await saveRec(sets);
    timer.haptic();
    const auto = timer.getPrefs().autoTimer;
    if (auto) timer.startRest();
    if (newPr) toast(`🏆 自己ベスト更新！ 推定1RM ${fmt(sessionBest, 1)}kg`, 3500);
    else toast(`✓ ${sets.length}セット目を記録${auto ? '・休憩スタート' : ''}`);
    // 次のセット用の候補行（前セットと同じ値・未確定）を用意する
    const last = setsEl.lastElementChild;
    addRow({
      weight: last.querySelector('.s-w').value,
      reps: last.querySelector('.s-r').value,
      rpe: last.querySelector('.s-e').value,
    }, true);
  };

  body.querySelector('#wo-save').onclick = async () => {
    const sets = collectSets();
    if (!sets.length) { toast('重量と回数を入力してください'); return; }
    const { newPr, sessionBest } = await saveRec(sets);
    closeSheet();
    if (newPr) toast(`🏆 自己ベスト更新！ 推定1RM ${fmt(sessionBest, 1)}kg`, 3500);
    else toast('トレーニングを記録しました');
  };

  if (existing) body.querySelector('#wo-del').onclick = async () => {
    if (!confirm(`「${ex.name}」の記録を削除しますか？`)) return;
    await db.del('workouts', existing.id);
    closeSheet();
    toast('削除しました');
  };

  // ✎ 種目名を変更: この記録の種目名を直す（既存の記録の付け間違い・改名用）
  const openRename = async () => {
    const exList = await db.all('exercises');
    const box = body.querySelector('#wo-rename-box');
    box.innerHTML = `
      <label>新しい種目名
        <input id="rn-name" type="text" value="${esc(ex.name)}" list="rn-list">
        <datalist id="rn-list">${exList.map(x => `<option value="${esc(x.name)}">`).join('')}</datalist>
      </label>
      <button class="btn" id="rn-save">この記録の種目名を変更する</button>
      <p class="hint">登録済みの種目名にするとその種目の記録として扱われます（前回比較・グラフも新しい種目側に）。未登録の名前は新しい種目として登録できます。</p>`;
    box.querySelector('#rn-save').onclick = async () => {
      const name = box.querySelector('#rn-name').value.trim();
      if (!name) { toast('種目名を入力してください'); return; }
      if (name === ex.name) { toast('種目名は変わっていません'); return; }
      // 登録済み種目なら付け替え、未登録なら新しい種目として登録してから付け替える
      let target = exList.find(x => x.name === name);
      if (!target) {
        if (!confirm(`「${name}」は種目リストに未登録です。\n新しい種目として登録して変更しますか？\n（部位は「その他」になります。設定画面で変更できます）`)) return;
        const id = await db.put('exercises', { name, part: 'その他' });
        target = { id, name };
      }
      ex.id = target.id;
      ex.name = name;
      // 保存済みの記録本体にもすぐ反映する（セットを保存せず閉じても名前が残るように）
      const w = await db.get('workouts', recId);
      if (w) await db.put('workouts', { ...w, name, exerciseId: ex.id });
      // 自己ベスト判定の比較対象も新しい種目の履歴に切り替える
      history = await db.byIndex('workouts', 'exerciseId', ex.id);
      const title = body.closest('.sheet')?.querySelector('.sheet-title');
      if (title) title.textContent = name;
      closeRename();
      toast(`種目名を「${name}」に変更しました`);
    };
  };
  // 変更後・キャンセル後は元の✎ボタンに戻す（もう一度変更できるように）
  const closeRename = () => {
    const box = body.querySelector('#wo-rename-box');
    box.innerHTML = '<button class="btn-ghost" id="wo-rename">✎ 種目名を変更</button>';
    box.querySelector('#wo-rename').onclick = openRename;
  };
  if (existing) closeRename();
}
