// ============================================================
// meals.js — 食事記録画面＋食品追加シート
// 追加方法: ①検索（内蔵DB＋Myフード） ②履歴 ③手入力
// 記録1件 = {date, slot, name, amount(g), kcal, p, f, c, salt, base100, micros, ts}
// base100 = 100gあたりの栄養値（あとから分量を変えたとき再計算に使う）
// micros = ビタミン・ミネラル10種の合計値（手入力・Myフード分。並び順はcalc.jsのMICROSと同じ）
// ============================================================
import * as db from '../db.js';
import { searchFoods, microsOf, microsPer100 } from '../foods.js';
import { MICROS, microTargets } from '../calc.js';
import { esc, fmt, openSheet, closeSheet, toast, todayStr, addDays, dateLabel } from '../ui.js';
import { state, refresh, setTab, changeDay } from '../app.js';

export const SLOTS = [
  { k: 'b', label: '朝食' },
  { k: 'l', label: '昼食' },
  { k: 'd', label: '夕食' },
  { k: 's', label: '間食' },
];

// その日の食事を取得
export async function mealsOf(date) {
  const rows = await db.byDate('meals', date);
  rows.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return rows;
}

// ビタミン・ミネラルの達成状況カード（ホームと食事画面で共用）
export function microCardHtml(rows, profile) {
  const micros = microsOf(rows);
  const t = microTargets(profile);
  const ok = micros.filter((v, i) => v >= t[i]).length;
  return `
    <div class="card">
      <div class="card-head"><span>ビタミン・ミネラル</span><b>${ok} / ${MICROS.length} 達成</b></div>
      <div class="micro-grid">
        ${MICROS.map((m, i) => {
          const v = micros[i], tg = t[i];
          const dec = tg >= 50 ? 0 : 1;   // 目標が大きい栄養素は整数表示
          return `<div class="micro-item">
            <div class="micro-top"><span>${m.label}</span><span>${fmt(v, dec)} / ${fmt(tg, dec)}${m.unit}</span></div>
            <div class="bar bar-thin"><div class="bar-fill bar-micro" style="width:${Math.min(100, tg ? v / tg * 100 : 0)}%"></div></div>
          </div>`;
        }).join('')}
      </div>
      <div class="micro-note">内蔵食品DBとの照合＋手入力されたビタミン・ミネラルの合計（概算）です。未入力の手入力食品は0扱いになります</div>
    </div>`;
}

// 合計を計算
export function sumMeals(rows) {
  const t = { kcal: 0, p: 0, f: 0, c: 0, salt: 0 };
  for (const r of rows) {
    t.kcal += r.kcal || 0; t.p += r.p || 0; t.f += r.f || 0; t.c += r.c || 0; t.salt += r.salt || 0;
  }
  for (const k of ['p', 'f', 'c', 'salt']) t[k] = Math.round(t[k] * 10) / 10;
  t.kcal = Math.round(t.kcal);
  return t;
}

// ============ 画面本体 ============
export async function render(root) {
  const date = state.date;
  const rows = await mealsOf(date);
  const total = sumMeals(rows);
  const [targets, profile] = await Promise.all([
    db.getSetting('targets', { kcal: 2200, p: 130, f: 60, c: 280 }),
    db.getSetting('profile', {}),
  ]);

  const section = (slot) => {
    const items = rows.filter(r => r.slot === slot.k);
    const sub = sumMeals(items);
    return `
    <div class="card meal-sec">
      <div class="meal-sec-head">
        <div class="meal-sec-title">${slot.label}<span class="meal-sec-kcal">${items.length ? fmt(sub.kcal) + ' kcal' : ''}</span></div>
        <button class="add-btn" data-add-slot="${slot.k}" aria-label="${slot.label}に追加">＋</button>
      </div>
      ${items.map(r => `
        <button class="meal-item" data-meal-id="${r.id}">
          <div class="meal-item-main">
            <div class="meal-item-name">${esc(r.name)}</div>
            <div class="meal-item-sub">${r.amount ? fmt(r.amount) + 'g ・ ' : ''}P${fmt(r.p, 1)} / F${fmt(r.f, 1)} / C${fmt(r.c, 1)}</div>
          </div>
          <div class="meal-item-kcal">${fmt(r.kcal)}<span> kcal</span></div>
        </button>`).join('') || '<div class="empty-line">記録なし</div>'}
    </div>`;
  };

  root.innerHTML = `
    <header class="page-head">
      <div class="date-nav">
        <button class="icon-btn" data-day="-1">‹</button>
        <button class="date-title" id="go-cal" aria-label="カレンダーで開く">${dateLabel(date)}</button>
        <button class="icon-btn" data-day="1">›</button>
      </div>
    </header>
    <div class="day-total card">
      <div class="dt-kcal"><b>${fmt(total.kcal)}</b> / ${fmt(targets.kcal)} kcal</div>
      <div class="dt-pfc">
        <span><i class="dot dot-p"></i>P ${fmt(total.p, 1)}g</span>
        <span><i class="dot dot-f"></i>F ${fmt(total.f, 1)}g</span>
        <span><i class="dot dot-c"></i>C ${fmt(total.c, 1)}g</span>
        <span class="dt-salt">塩分 ${fmt(total.salt, 1)}g</span>
      </div>
    </div>
    ${rows.length ? '' : `
    <button class="btn btn-big" id="copy-prev">📋 前日の記録をコピー</button>
    <div class="hint">前日と同じ内容から始めて、不要な品は削除・変わった品は追加で調整できます</div>`}
    ${SLOTS.map(section).join('')}
    ${microCardHtml(rows, profile)}`;

  // 日付移動（画面の左右スワイプでも移動できる）
  root.querySelectorAll('[data-day]').forEach(b => b.onclick = () => changeDay(+b.dataset.day));
  // 日付タップで記録タブのカレンダーへ（この日を選択した状態で開く）
  root.querySelector('#go-cal').onclick = () => {
    state.logTab = 'cal';
    state.calMonth = date.slice(0, 7);
    state.calSel = date;
    setTab('log');
  };
  // 前日の記録を丸ごとコピー（この日が空のときだけボタンが出る）
  const cp = root.querySelector('#copy-prev');
  if (cp) cp.onclick = async () => {
    const prev = await mealsOf(addDays(date, -1));
    if (!prev.length) { toast('前日の食事記録がありません'); return; }
    const base = Date.now();
    for (let i = 0; i < prev.length; i++) {
      const { id, ...rest } = prev[i];   // idを外して新しい記録として保存（元の並び順はtsで維持）
      await db.put('meals', { ...rest, date, ts: base + i });
    }
    toast(`前日の${prev.length}品をコピーしました`);
    refresh();
  };
  // 追加
  root.querySelectorAll('[data-add-slot]').forEach(b => b.onclick = () =>
    openAddSheet(b.dataset.addSlot, date, refresh));
  // 既存項目の編集
  root.querySelectorAll('[data-meal-id]').forEach(b => b.onclick = async () => {
    const row = await db.get('meals', +b.dataset.mealId);
    if (row) openEditSheet(row, refresh);
  });
}

// ============ 食品追加シート ============
export async function openAddSheet(slot, date, onSaved) {
  const slotLabel = SLOTS.find(s => s.k === slot)?.label || '';
  const customFoods = await db.all('customFoods');

  const body = openSheet(`${slotLabel}に追加`, `
    <div class="tabs" id="add-tabs">
      <button class="tab on" data-t="search">検索</button>
      <button class="tab" data-t="hist">履歴</button>
      <button class="tab" data-t="manual">手入力</button>
    </div>
    <div id="add-pane"></div>`);

  const pane = body.querySelector('#add-pane');
  const tabs = body.querySelector('#add-tabs');
  tabs.onclick = (e) => {
    const t = e.target.closest('.tab'); if (!t) return;
    tabs.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === t));
    ({ search: renderSearch, hist: renderHist, manual: renderManual })[t.dataset.t]();
  };

  // 保存共通処理
  async function save(rec, { keepOpen = true } = {}) {
    await db.put('meals', { ...rec, date, slot, ts: Date.now() });
    toast(`${rec.name} を${slotLabel}に追加しました`);
    onSaved();
    if (!keepOpen) closeSheet();
  }

  // ---- 検索タブ ----
  function renderSearch() {
    pane.innerHTML = `
      <input id="q" type="search" placeholder="食品名で検索（例: 鶏むね、ご飯、プロテイン）" autocomplete="off">
      <div id="q-res" class="food-list"></div>`;
    const q = pane.querySelector('#q');
    const res = pane.querySelector('#q-res');
    const run = () => {
      const hits = searchFoods(q.value, customFoods);
      res.innerHTML = hits.map((h, i) => `
        <button class="food-row" data-i="${i}">
          <div><div class="food-name">${esc(h.name)}</div>
          <div class="food-sub">${esc(h.cat)} ・ 100gあたり ${fmt(h.kcal)}kcal / P${fmt(h.p, 1)}</div></div>
          <span class="chev">›</span>
        </button>`).join('') || (q.value ? '<div class="empty-line">見つかりません。「手入力」タブで登録できます。</div>' : '');
      res.querySelectorAll('.food-row').forEach(b => b.onclick = () => renderAmount(hits[+b.dataset.i]));
    };
    q.oninput = run;
    q.focus();
  }

  // ---- 分量入力（検索から選んだあと） ----
  function renderAmount(food) {
    const defG = food.u ? food.u[1] : 100;
    pane.innerHTML = `
      <button class="btn-ghost back-btn" id="back">‹ 検索に戻る</button>
      <div class="amount-head">
        <div class="food-name-big">${esc(food.name)}</div>
        <div class="food-sub">100gあたり ${fmt(food.kcal)}kcal ・ P${fmt(food.p, 1)} F${fmt(food.f, 1)} C${fmt(food.c, 1)}</div>
      </div>
      <div class="amount-row">
        <button class="step-btn" data-d="-10">−10</button>
        <input id="g" type="number" inputmode="decimal" value="${defG}"><span class="unit-g">g</span>
        <button class="step-btn" data-d="10">＋10</button>
      </div>
      <div class="quick-units">
        ${food.u ? `<button class="chip" data-g="${food.u[1]}">${esc(food.u[0])}（${food.u[1]}g）</button>` : ''}
        <button class="chip" data-g="100">100g</button>
        ${food.u2 ? `<button class="chip" data-g="${food.u2[1]}">${esc(food.u2[0])}（${food.u2[1]}g）</button>`
          : food.u ? `<button class="chip" data-g="${food.u[1] * 2}">${esc(food.u[0])}×2</button>`
          : '<button class="chip" data-g="200">200g</button>'}
      </div>
      <div class="preview card" id="pv"></div>
      <button class="btn btn-big" id="add-go">追加する</button>`;

    const g = pane.querySelector('#g');
    const pv = pane.querySelector('#pv');
    const calc = () => {
      const n = Math.max(0, +g.value || 0);
      const s = n / 100;
      pv.innerHTML = `
        <div class="pv-kcal"><b>${fmt(food.kcal * s)}</b> kcal</div>
        <div class="dt-pfc">
          <span><i class="dot dot-p"></i>P ${fmt(food.p * s, 1)}g</span>
          <span><i class="dot dot-f"></i>F ${fmt(food.f * s, 1)}g</span>
          <span><i class="dot dot-c"></i>C ${fmt(food.c * s, 1)}g</span>
        </div>
        ${microDetailHtml(food.v ? food.v.map(x => (x || 0) * s) : null)}`;
      return { n, s };
    };
    calc();
    g.oninput = calc;
    pane.querySelectorAll('.step-btn').forEach(b => b.onclick = () => { g.value = Math.max(0, (+g.value || 0) + +b.dataset.d); calc(); });
    pane.querySelectorAll('.chip').forEach(b => b.onclick = () => { g.value = b.dataset.g; calc(); });
    pane.querySelector('#back').onclick = renderSearch;
    pane.querySelector('#add-go').onclick = () => {
      const { n, s } = calc();
      if (!n) { toast('分量を入力してください'); return; }
      // Myフードにビタミン・ミネラル(v=100gあたり)があれば分量で按分して記録に持たせる
      // （内蔵DBの食品は名前照合で自動集計されるので記録には持たせない）
      const mv = food.my && food.v ? food.v.map(x => r2((x || 0) * s)) : null;
      save({
        name: food.name, amount: n,
        kcal: Math.round(food.kcal * s), p: r1(food.p * s), f: r1(food.f * s), c: r1(food.c * s), salt: r1((food.salt || 0) * s),
        base100: { kcal: food.kcal, p: food.p, f: food.f, c: food.c, salt: food.salt || 0, ...(mv ? { v: food.v } : {}) },
        ...(mv ? { micros: mv } : {}),
      });
      renderSearch();
    };
  }

  // ---- 履歴タブ（最近使った食品をワンタップ再登録） ----
  async function renderHist() {
    const allMeals = await db.all('meals');
    allMeals.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const seen = new Set(); const hist = [];
    for (const m of allMeals) {
      const key = `${m.name}|${m.amount}`;
      if (seen.has(key)) continue;
      seen.add(key); hist.push(m);
      if (hist.length >= 25) break;
    }
    pane.innerHTML = `<div class="food-list">${hist.map((h, i) => `
      <button class="food-row" data-i="${i}">
        <div><div class="food-name">${esc(h.name)}</div>
        <div class="food-sub">${h.amount ? fmt(h.amount) + 'g ・ ' : ''}${fmt(h.kcal)}kcal / P${fmt(h.p, 1)}</div></div>
        <span class="chev">＋</span>
      </button>`).join('') || '<div class="empty-line">まだ履歴がありません</div>'}</div>`;
    pane.querySelectorAll('.food-row').forEach(b => b.onclick = () => {
      const h = hist[+b.dataset.i];
      save({ name: h.name, amount: h.amount, kcal: h.kcal, p: h.p, f: h.f, c: h.c, salt: h.salt || 0, base100: h.base100 || null, micros: h.micros || null });
    });
  }

  // ---- 手入力タブ ----
  function renderManual() {
    pane.innerHTML = `
      <label>食品名<input id="m-name" type="text" placeholder="例: 唐揚げ定食"></label>
      <div class="form-row2">
        <label>分量 <span class="unit">g（任意）</span><input id="m-g" type="number" inputmode="decimal"></label>
        <label>カロリー <span class="unit">kcal</span><input id="m-kcal" type="number" inputmode="decimal"></label>
      </div>
      <div class="form-row3">
        <label>P <span class="unit">g</span><input id="m-p" type="number" inputmode="decimal"></label>
        <label>F <span class="unit">g</span><input id="m-f" type="number" inputmode="decimal"></label>
        <label>C <span class="unit">g</span><input id="m-c" type="number" inputmode="decimal"></label>
      </div>
      <details class="micro-manual">
        <summary>ビタミン・ミネラル（わかれば入力・任意）</summary>
        <div class="micro-manual-hint">この食事に含まれる量を入力（空欄は0扱い）</div>
        <div class="micro-inputs">
          ${MICROS.map((m, i) => `<label>${m.label} <span class="unit">${m.unit}</span><input data-mi="${i}" type="number" inputmode="decimal"></label>`).join('')}
        </div>
      </details>
      <label class="check-line"><input id="m-save" type="checkbox"> Myフードにも保存する（分量gの入力が必要）</label>
      <button class="btn btn-big" id="m-go">追加する</button>`;
    pane.querySelector('#m-go').onclick = async () => {
      const name = pane.querySelector('#m-name').value.trim();
      const kcal = +pane.querySelector('#m-kcal').value || 0;
      if (!name) { toast('食品名を入力してください'); return; }
      const g = +pane.querySelector('#m-g').value || null;
      const p = +pane.querySelector('#m-p').value || 0;
      const fat = +pane.querySelector('#m-f').value || 0;
      const c = +pane.querySelector('#m-c').value || 0;
      // ビタミン・ミネラル: 1つでも入力があれば配列で記録に持たせる（集計はmicrosOfが拾う）
      const mi = [...pane.querySelectorAll('[data-mi]')].map(el => +el.value || 0);
      const micros = mi.some(v => v > 0) ? mi.map(r2) : null;
      const base100 = g ? {
        kcal: r1(kcal / g * 100), p: r1(p / g * 100), f: r1(fat / g * 100), c: r1(c / g * 100), salt: 0,
        ...(micros ? { v: micros.map(v => r2(v / g * 100)) } : {}),   // 分量変更時の再計算用（100gあたり）
      } : null;
      // Myフード登録（100gあたりに換算して保存。vがあれば検索から追加した分も集計に乗る）
      if (pane.querySelector('#m-save').checked) {
        if (!g) { toast('Myフード保存には分量gが必要です'); return; }
        await db.put('customFoods', { name, kana: '', ...base100, u: ['1食', g] });
        toast(`Myフード「${name}」を登録しました`);
      }
      save({ name, amount: g, kcal: Math.round(kcal), p: r1(p), f: r1(fat), c: r1(c), salt: 0, base100, micros });
      renderManual();
    };
  }

  renderSearch();
}

// ============ 既存項目の修正シート ============
function openEditSheet(row, onSaved) {
  const canScale = !!(row.base100 && row.amount);
  // ビタミン・ミネラルの100gあたり基準値: 記録が持つ値（手入力・Myフード）→ 内蔵DB照合 の順
  const dbV100 = microsPer100(row.name);
  // canScale時に分量へ按分するための100gあたり基準（手入力があれば書き換わる）
  let mv100 = canScale ? ((row.base100.v && row.base100.v.slice()) || (dbV100 && dbV100.slice()) || null) : null;
  // ユーザーがビタミン・ミネラル欄を手で編集したか（編集時のみ記録へ焼き込む）
  let microDirty = false;

  const body = openSheet('記録の修正', `
    <div class="amount-head">
      <div class="food-name-big">${esc(row.name)}</div>
      <div class="food-sub" id="e-sub"></div>
    </div>
    ${canScale ? `
    <div class="amount-row">
      <button class="step-btn" data-d="-10">−10</button>
      <input id="e-g" type="number" inputmode="decimal" value="${row.amount}"><span class="unit-g">g</span>
      <button class="step-btn" data-d="10">＋10</button>
    </div>
    <div class="preview card" id="e-pv"></div>` : `
    <div class="form-row2">
      <label>カロリー <span class="unit">kcal</span><input id="e-kcal" type="number" value="${row.kcal}"></label>
      <label>P <span class="unit">g</span><input id="e-p" type="number" value="${row.p}"></label>
    </div>
    <div class="form-row2">
      <label>F <span class="unit">g</span><input id="e-f" type="number" value="${row.f}"></label>
      <label>C <span class="unit">g</span><input id="e-c" type="number" value="${row.c}"></label>
    </div>`}
    <details class="micro-manual">
      <summary>ビタミン・ミネラル（この分量あたり・任意）</summary>
      <div class="micro-manual-hint">${canScale
        ? '分量を変えると自動で増減します。数値を書き換えるとその値が優先されます（空欄は0）'
        : 'この食事に含まれる量を入力（空欄は0扱い）'}</div>
      <div class="micro-inputs">
        ${MICROS.map((m, i) => `<label>${m.label} <span class="unit">${m.unit}</span><input data-mi="${i}" type="number" inputmode="decimal"></label>`).join('')}
      </div>
    </details>
    <button class="btn btn-big" id="e-save">保存する</button>
    <button class="btn-danger" id="e-del">この記録を削除</button>`);

  const microInputs = [...body.querySelectorAll('[data-mi]')];
  const gEl = body.querySelector('#e-g');
  const pv = body.querySelector('#e-pv');

  // ビタミン・ミネラル入力欄に「この分量あたり」の値をセットする（0は空欄表示）
  function fillMicroInputs(s) {
    const vals = canScale ? (mv100 ? mv100.map(v => (v || 0) * s) : null) : (row.micros || null);
    microInputs.forEach((el, i) => {
      const v = vals ? (vals[i] || 0) : 0;
      el.value = v ? r2(v) : '';
    });
  }

  if (canScale) {
    // PFCプレビューを更新しつつ、ビタミン・ミネラル欄も分量に合わせて按分し直す
    const recalc = () => {
      const g = Math.max(0, +gEl.value || 0), s = g / 100, b = row.base100;
      pv.innerHTML = `<div class="pv-kcal"><b>${fmt(Math.round(b.kcal * s))}</b> kcal</div>
        <div class="dt-pfc"><span>P ${fmt(b.p * s, 1)}g</span><span>F ${fmt(b.f * s, 1)}g</span><span>C ${fmt(b.c * s, 1)}g</span></div>`;
      fillMicroInputs(s);
    };
    recalc();
    gEl.oninput = recalc;
    body.querySelectorAll('.step-btn').forEach(b => b.onclick = () => {
      gEl.value = Math.max(0, (+gEl.value || 0) + +b.dataset.d);
      recalc();
    });
    // 手入力したら、その値を100gあたり基準に反映して以後の分量変更にも追従させる
    microInputs.forEach((el, i) => el.oninput = () => {
      microDirty = true;
      const s = (Math.max(0, +gEl.value || 0)) / 100;
      if (!s) return;
      if (!mv100) mv100 = new Array(MICROS.length).fill(0);
      mv100[i] = (+el.value || 0) / s;
    });
  } else {
    fillMicroInputs(1);
    microInputs.forEach(el => el.oninput = () => { microDirty = true; });
  }

  body.querySelector('#e-save').onclick = async () => {
    let upd;
    if (canScale) {
      const g = Math.max(0, +gEl.value || 0), s = g / 100, b = row.base100;
      const newBase = { ...b };
      let micros;
      if (microDirty) {
        // 手入力された「この分量あたり」の値を記録へ焼き込み、100gあたりもbase100へ保存
        const mi = microInputs.map(el => +el.value || 0);
        micros = mi.some(v => v > 0) ? mi.map(r2) : null;
        if (micros && s) newBase.v = micros.map(v => r2(v / s));
        else delete newBase.v;
      } else {
        // 未編集: 従来どおり base100.v があれば分量で按分（DB照合のみの食品はnullのまま）
        micros = b.v ? b.v.map(x => r2((x || 0) * s)) : null;
      }
      upd = {
        ...row, amount: g,
        kcal: Math.round(b.kcal * s), p: r1(b.p * s), f: r1(b.f * s), c: r1(b.c * s), salt: r1((b.salt || 0) * s),
        base100: newBase, micros,
      };
    } else {
      upd = {
        ...row,
        kcal: +body.querySelector('#e-kcal').value || 0,
        p: +body.querySelector('#e-p').value || 0,
        f: +body.querySelector('#e-f').value || 0,
        c: +body.querySelector('#e-c').value || 0,
      };
      if (microDirty) {
        const mi = microInputs.map(el => +el.value || 0);
        upd.micros = mi.some(v => v > 0) ? mi.map(r2) : null;
      }
    }
    await db.put('meals', upd);
    toast('修正しました');
    closeSheet();
    onSaved();
  };
  body.querySelector('#e-del').onclick = async () => {
    if (!confirm(`「${row.name}」を削除しますか？`)) return;
    await db.del('meals', row.id);
    toast('削除しました');
    closeSheet();
    onSaved();
  };
}

// 1品分のビタミン・ミネラル内訳（分量換算済みの10値配列）を小さなグリッドで表示する
// vals が null のときは「データなし」の1行を返す（手入力で未入力の食品など）
function microDetailHtml(vals) {
  if (!vals) return '<div class="micro-detail-none">ビタミン・ミネラルのデータはありません</div>';
  return `
    <div class="micro-detail-head">ビタミン・ミネラル（この分量あたり）</div>
    <div class="micro-detail">
      ${MICROS.map((m, i) => {
        const v = vals[i] || 0;
        const dec = v >= 50 ? 0 : v >= 10 ? 1 : 2;   // 大きい値は整数、小さい値は細かく
        return `<span class="md-row"><span>${m.label}</span><b>${fmt(v, dec)}${m.unit}</b></span>`;
      }).join('')}
    </div>`;
}

// 小数1桁に丸める
function r1(n) { return Math.round((n || 0) * 10) / 10; }
// 小数2桁に丸める（ビタミンB群などmg単位の小さい値用）
function r2(n) { return Math.round((n || 0) * 100) / 100; }
