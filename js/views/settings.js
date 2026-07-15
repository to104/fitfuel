// ============================================================
// settings.js — 設定画面
// プロフィール・目標の編集 / サプリ・種目・Myフード管理 / バックアップ
// ============================================================
import * as db from '../db.js';
import * as timer from '../timer.js';
import * as coach from '../coach.js';
import { ACTIVITY, GOALS, recommend, MICROS } from '../calc.js';
import { esc, fmt, openSheet, closeSheet, toast, segmented, segValue, todayStr } from '../ui.js';
import { refresh, APP_VER } from '../app.js';
import * as sync from '../sync.js';

// 種目の部位一覧（トレ画面の種目追加と共通の並び）
const PARTS = ['胸', '背中', '脚', '肩', '腕', '腹', 'その他'];

export async function render(root) {
  const [profile, targets, supps, exercises, myFoods, split] = await Promise.all([
    db.getSetting('profile', {}),
    db.getSetting('targets', {}),
    db.all('supplements'),
    db.all('exercises'),
    db.all('customFoods'),
    coach.getSplit(),
  ]);
  const tp = timer.getPrefs();

  root.innerHTML = `
    <header class="page-head"><h1 class="home-title">設定</h1></header>

    <div class="sec-title">プロフィールと目標</div>
    <div class="card">
      <div class="form-row2">
        <label>身長 <span class="unit">cm</span><input id="s-h" type="number" inputmode="decimal" value="${profile.height ?? ''}"></label>
        <label>体重 <span class="unit">kg</span><input id="s-w" type="number" inputmode="decimal" value="${profile.weight ?? ''}"></label>
      </div>
      <div class="form-row2">
        <label>年齢<input id="s-a" type="number" inputmode="numeric" value="${profile.age ?? ''}"></label>
        <label>性別${segmented('sex', [{ v: 'm', label: '男性' }, { v: 'f', label: '女性' }], profile.sex || 'm')}</label>
      </div>
      <label>活動量<select id="s-act">${ACTIVITY.map(a =>
        `<option value="${a.v}"${a.v === profile.activity ? ' selected' : ''}>${esc(a.label)}</option>`).join('')}</select></label>
      <label>目的${segmented('goal', GOALS.map(g => ({ v: g.v, label: g.label })), profile.goal || 'keep')}</label>
      <button class="btn-ghost" id="s-recalc">目標を自動で再計算する</button>
      <hr class="sep">
      <label>目標カロリー <span class="unit">kcal</span><input id="s-kcal" type="number" value="${targets.kcal ?? ''}"></label>
      <div class="form-row3">
        <label>P <span class="unit">g</span><input id="s-p" type="number" value="${targets.p ?? ''}"></label>
        <label>F <span class="unit">g</span><input id="s-f" type="number" value="${targets.f ?? ''}"></label>
        <label>C <span class="unit">g</span><input id="s-c" type="number" value="${targets.c ?? ''}"></label>
      </div>
      <label>水分目標 <span class="unit">ml</span><input id="s-water" type="number" step="100" value="${targets.water ?? ''}"></label>
      <button class="btn" id="s-save">保存する</button>
    </div>

    <div class="sec-title">サプリメント</div>
    <div class="card" id="supp-box">
      ${supps.map(s => `<div class="manage-row"><span>${esc(s.name)}</span><button class="icon-btn" data-del-supp="${s.id}">✕</button></div>`).join('') || '<div class="empty-line">未登録</div>'}
      <div class="new-ex"><input id="supp-name" type="text" placeholder="サプリ名（例: プロテイン）"><button class="btn" id="supp-add">追加</button></div>
    </div>

    <div class="sec-title">トレーニング種目</div>
    <div class="card">
      ${exercises.map(x => `<div class="manage-row"><span>${esc(x.name)}<i class="mut"> ${esc(x.part || '')}</i></span>
        <span class="manage-btns"><button class="icon-btn" data-edit-ex="${x.id}" aria-label="編集">✎</button><button class="icon-btn" data-del-ex="${x.id}" aria-label="削除">✕</button></span></div>`).join('') || '<div class="empty-line">未登録</div>'}
      <div class="new-ex">
        <input id="ex-name" type="text" placeholder="新しい種目名">
        <select id="ex-part">${PARTS.map(p => `<option>${p}</option>`).join('')}</select>
        <button class="btn" id="ex-add">追加</button>
      </div>
      <p class="hint">✎で種目名・部位を変更できます。トレ画面の「＋種目を記録する」からも追加できます。</p>
    </div>

    <div class="sec-title">AIトレーナー（分割パターン）</div>
    <div class="card">
      ${coach.DAY_TYPES.map(day => `
        <div class="split-day">
          <div class="split-head"><b>${day.label}の日</b><span class="mut">メイン: ${day.mains.join('・')}</span></div>
          <div class="split-chips">
            ${(split.extras[day.key] || []).map(p =>
              `<button class="chip split-chip" data-sp-del="${day.key}|${esc(p)}">＋${esc(p)} ✕</button>`).join('')}
            <select class="sp-add" data-sp-add="${day.key}">
              <option value="">＋追い込み部位</option>
              ${coach.EXTRA_PARTS.filter(p => !day.mains.includes(p) && !(split.extras[day.key] || []).includes(p))
                .map(p => `<option>${esc(p)}</option>`).join('')}
            </select>
          </div>
        </div>`).join('')}
      <hr class="sep">
      <label>基本のトレーニング時間
        <div class="amount-row">
          <button class="step-btn" data-bt="-15">−15</button>
          <input id="sp-time" readonly value="${split.baseTime}分">
          <button class="step-btn" data-bt="15">＋15</button>
        </div>
      </label>
      <p class="hint">追い込み部位＝その日のメインに加えて軽く追加する部位。メニュー生成時に補助種目として1種目ずつ入ります。同じ部位が続く場合はAIが自動でボリュームを軽くします。</p>
    </div>

    <div class="sec-title">休憩タイマー</div>
    <div class="card">
      <label>完了音<select id="t-sound">${Object.entries(timer.SOUNDS).map(([k, s]) =>
        `<option value="${k}"${k === tp.sound ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      <button class="btn-ghost" id="t-test">▶ 試聴する</button>
      <label>音量<input type="range" id="t-vol" min="0" max="1" step="0.05" value="${tp.vol}"></label>
      <label class="check-line"><input type="checkbox" id="t-auto"${tp.autoTimer ? ' checked' : ''}>「✓ セット完了」で自動的に休憩タイマーを開始</label>
      <label style="margin-top:12px">休憩時間（デフォルト）
        <div class="amount-row">
          <button class="step-btn" data-rest="-30">−30</button>
          <input id="t-rest" readonly value="${timer.fmtSec(tp.rest)}">
          <button class="step-btn" data-rest="30">＋30</button>
        </div>
      </label>
    </div>

    <div class="sec-title">Myフード（自作食品・100gあたり）</div>
    <div class="card">
      ${myFoods.map(x => `<div class="manage-row"><span>${esc(x.name)}<i class="mut"> ${fmt(x.kcal)}kcal/P${fmt(x.p, 1)}</i></span><button class="icon-btn" data-del-food="${x.id}">✕</button></div>`).join('') || '<div class="empty-line">未登録（食事の手入力タブから登録できます）</div>'}
      <button class="btn-ghost" id="food-add">＋ Myフードを直接登録</button>
    </div>

    <div class="sec-title">クラウド同期（Googleドライブ）</div>
    <div class="card">
      ${sync.syncOn() ? `
        <p class="hint" style="margin-top:0">✅ 同期はオンです（${esc(sync.fmtLast())}）</p>
        <button class="btn" id="sy-now">🔄 今すぐ同期</button>
        <button class="btn-ghost" id="sy-off">同期をオフにする</button>
      ` : `
        <button class="btn" id="sy-on">Googleに接続して同期を有効化</button>
        <p class="hint">記録をGoogleドライブ経由でPCとスマホの間で自動同期します。<br>
        <b>初回は必ず、データが入っている端末から有効化してください。</b>2台目の端末では有効化時に「クラウドのデータを取り込む」を選べます。</p>
      `}
    </div>

    <div class="sec-title">データ</div>
    <div class="card">
      <button class="btn" id="bk-export">バックアップをエクスポート（JSON）</button>
      <label class="btn-ghost file-btn">バックアップをインポート<input id="bk-import" type="file" accept=".json,application/json" hidden></label>
      <p class="hint">エクスポートしたファイルはiCloudやGoogleドライブ等に保管してください。インポートすると現在のデータは置き換えられます。</p>
      <hr class="sep">
      <button class="btn-ghost" id="wo-csv">トレ記録をCSVで書き出し</button>
      <label class="btn-ghost file-btn">筋トレ記録アプリから移行（JSON）<input id="kt-import" type="file" accept=".json,application/json" hidden></label>
      <p class="hint">「筋トレ記録」アプリの 設定 →「保存（JSON）」で作ったバックアップファイルを選ぶと、トレ記録と種目・タイマー設定をこのアプリへ取り込みます。既存のデータはそのまま残り、同じ日の同じ種目がすでにある場合はスキップされます。</p>
      <hr class="sep">
      <button class="btn-danger" id="bk-wipe">全データを削除</button>
    </div>

    <div class="app-info">筋トレ・栄養管理 v${APP_VER}<br>栄養値は日本食品標準成分表（八訂）ベースの近似値です</div>`;

  // ---- クラウド同期 ----
  const syOn = root.querySelector('#sy-on');
  if (syOn) syOn.onclick = async () => {
    syOn.disabled = true;
    try {
      const r = await sync.enableSync();
      toast(r === 'pulled' ? 'クラウドのデータを取り込みました' : 'この端末の内容をクラウドへ保存しました');
    } catch (e) {
      toast('同期を開始できませんでした: ' + (e && e.message || e));
      sync.disableSync();
    }
    refresh();
  };
  const syNow = root.querySelector('#sy-now');
  if (syNow) syNow.onclick = async () => {
    syNow.disabled = true;
    await sync.syncNow({ interactive: true });
    refresh();
  };
  const syOff = root.querySelector('#sy-off');
  if (syOff) syOff.onclick = () => {
    sync.disableSync();
    toast('同期をオフにしました');
    refresh();
  };

  // ---- プロフィール・目標 ----
  const readProfile = () => ({
    ...profile,
    height: +root.querySelector('#s-h').value || profile.height,
    weight: +root.querySelector('#s-w').value || profile.weight,
    age: +root.querySelector('#s-a').value || profile.age,
    sex: segValue(root, 'sex'),
    activity: +root.querySelector('#s-act').value,
    goal: segValue(root, 'goal'),
  });
  root.querySelector('#s-recalc').onclick = () => {
    const rec = recommend(readProfile());
    root.querySelector('#s-kcal').value = rec.kcal;
    root.querySelector('#s-p').value = rec.p;
    root.querySelector('#s-f').value = rec.f;
    root.querySelector('#s-c').value = rec.c;
    root.querySelector('#s-water').value = rec.water;
    toast('再計算しました。「保存する」で確定します');
  };
  root.querySelector('#s-save').onclick = async () => {
    await db.setSetting('profile', readProfile());
    await db.setSetting('targets', {
      kcal: +root.querySelector('#s-kcal').value || 2200,
      p: +root.querySelector('#s-p').value || 130,
      f: +root.querySelector('#s-f').value || 60,
      c: +root.querySelector('#s-c').value || 280,
      water: +root.querySelector('#s-water').value || 2000,
    });
    toast('保存しました');
    refresh();
  };

  // ---- サプリ ----
  root.querySelector('#supp-add').onclick = async () => {
    const name = root.querySelector('#supp-name').value.trim();
    if (!name) return;
    await db.put('supplements', { name });
    refresh();
  };
  root.querySelectorAll('[data-del-supp]').forEach(b => b.onclick = async () => {
    await db.del('supplements', +b.dataset.delSupp);
    refresh();
  });

  // ---- 種目 ----
  root.querySelector('#ex-add').onclick = async () => {
    const name = root.querySelector('#ex-name').value.trim();
    if (!name) { toast('種目名を入力してください'); return; }
    if (exercises.some(x => x.name === name)) { toast('同じ名前の種目がすでにあります'); return; }
    await db.put('exercises', { name, part: root.querySelector('#ex-part').value });
    toast('種目を追加しました');
    refresh();
  };
  root.querySelectorAll('[data-del-ex]').forEach(b => b.onclick = async () => {
    if (!confirm('種目を削除しますか？（過去の記録は残ります）')) return;
    await db.del('exercises', +b.dataset.delEx);
    refresh();
  });
  root.querySelectorAll('[data-edit-ex]').forEach(b => b.onclick = () => {
    const x = exercises.find(e => e.id === +b.dataset.editEx);
    if (!x) return;
    // 保存済みの部位が一覧にない場合も選べるように先頭へ足す
    const parts = PARTS.includes(x.part) || !x.part ? PARTS : [x.part, ...PARTS];
    const body = openSheet('種目を編集', `
      <label>種目名<input id="ee-name" type="text" value="${esc(x.name)}"></label>
      <label>部位<select id="ee-part">${parts.map(p =>
        `<option${p === (x.part || 'その他') ? ' selected' : ''}>${p}</option>`).join('')}</select></label>
      <button class="btn btn-big" id="ee-save">保存する</button>`);
    body.querySelector('#ee-save').onclick = async () => {
      const name = body.querySelector('#ee-name').value.trim();
      if (!name) { toast('種目名を入力してください'); return; }
      if (exercises.some(e => e.id !== x.id && e.name === name)) { toast('同じ名前の種目がすでにあります'); return; }
      await db.put('exercises', { ...x, name, part: body.querySelector('#ee-part').value });
      // 名前を変えたときは、過去のトレ記録（種目名のコピーを持っている）もまとめて直せるようにする
      if (name !== x.name) {
        const recs = await db.byIndex('workouts', 'exerciseId', x.id);
        if (recs.length && confirm(`過去のトレ記録 ${recs.length}件の種目名も「${name}」に変更しますか？\n（キャンセルすると記録は元の名前のまま残ります）`)) {
          for (const w of recs) await db.put('workouts', { ...w, name });
        }
      }
      closeSheet();
      toast('種目を更新しました');
      refresh();
    };
  });

  // ---- AIトレーナー（分割パターン。変更したら即保存） ----
  root.querySelectorAll('[data-sp-del]').forEach(b => b.onclick = async () => {
    const [key, part] = b.dataset.spDel.split('|');
    const extras = { ...split.extras, [key]: (split.extras[key] || []).filter(p => p !== part) };
    await coach.setSplit({ extras });
    refresh();
  });
  root.querySelectorAll('[data-sp-add]').forEach(sel => sel.onchange = async () => {
    if (!sel.value) return;
    const key = sel.dataset.spAdd;
    const extras = { ...split.extras, [key]: [...(split.extras[key] || []), sel.value] };
    await coach.setSplit({ extras });
    refresh();
  });
  root.querySelectorAll('[data-bt]').forEach(b => b.onclick = async () => {
    const t = Math.min(180, Math.max(30, split.baseTime + (+b.dataset.bt)));
    split.baseTime = t;
    await coach.setSplit({ baseTime: t });
    root.querySelector('#sp-time').value = `${t}分`;
  });

  // ---- Myフード ----
  root.querySelectorAll('[data-del-food]').forEach(b => b.onclick = async () => {
    await db.del('customFoods', +b.dataset.delFood);
    refresh();
  });
  root.querySelector('#food-add').onclick = () => {
    const body = openSheet('Myフード登録（100gあたり）', `
      <label>食品名<input id="cf-name" type="text"></label>
      <div class="form-row2">
        <label>カロリー <span class="unit">kcal</span><input id="cf-kcal" type="number"></label>
        <label>P <span class="unit">g</span><input id="cf-p" type="number"></label>
      </div>
      <div class="form-row2">
        <label>F <span class="unit">g</span><input id="cf-f" type="number"></label>
        <label>C <span class="unit">g</span><input id="cf-c" type="number"></label>
      </div>
      <label>よく使う1回分 <span class="unit">g</span><input id="cf-g" type="number" value="100"></label>
      <details class="micro-manual">
        <summary>ビタミン・ミネラル（わかれば入力・任意）</summary>
        <div class="micro-manual-hint">100gあたりの含有量を入力（空欄は0扱い）</div>
        <div class="micro-inputs">
          ${MICROS.map((m, i) => `<label>${m.label} <span class="unit">${m.unit}</span><input data-mi="${i}" type="number" inputmode="decimal"></label>`).join('')}
        </div>
      </details>
      <button class="btn btn-big" id="cf-save">登録する</button>`);
    body.querySelector('#cf-save').onclick = async () => {
      const name = body.querySelector('#cf-name').value.trim();
      if (!name) { toast('食品名を入力してください'); return; }
      // ビタミン・ミネラル（100gあたり）: 1つでも入力があれば v 配列として保存
      // （v があると検索から追加したときも集計・分量按分に乗る）
      const mi = [...body.querySelectorAll('[data-mi]')].map(el => Math.round((+el.value || 0) * 100) / 100);
      const v = mi.some(x => x > 0) ? mi : null;
      await db.put('customFoods', {
        name, kana: '',
        kcal: +body.querySelector('#cf-kcal').value || 0,
        p: +body.querySelector('#cf-p').value || 0,
        f: +body.querySelector('#cf-f').value || 0,
        c: +body.querySelector('#cf-c').value || 0,
        salt: 0,
        ...(v ? { v } : {}),
        u: ['1食', +body.querySelector('#cf-g').value || 100],
      });
      closeSheet();
      toast('登録しました');
      refresh();
    };
  };

  // ---- 休憩タイマー設定（変更したら即保存） ----
  root.querySelector('#t-sound').onchange = async (e) => {
    await timer.setPrefs({ sound: e.target.value });
    timer.playSound(e.target.value);
  };
  root.querySelector('#t-test').onclick = () => timer.playSound(timer.getPrefs().sound);
  root.querySelector('#t-vol').onchange = async (e) => {
    await timer.setPrefs({ vol: parseFloat(e.target.value) });
    timer.playSound(timer.getPrefs().sound);
  };
  root.querySelector('#t-auto').onchange = async (e) => {
    await timer.setPrefs({ autoTimer: e.target.checked });
  };
  root.querySelectorAll('[data-rest]').forEach(b => b.onclick = async () => {
    const rest = Math.max(30, timer.getPrefs().rest + (+b.dataset.rest));
    await timer.setPrefs({ rest });
    root.querySelector('#t-rest').value = timer.fmtSec(rest);
  });

  // ---- トレ記録のCSV書き出し（PCでの集計用） ----
  root.querySelector('#wo-csv').onclick = async () => {
    const rows = (await db.all('workouts'))
      .sort((a, b) => a.date.localeCompare(b.date) || (a.ts || 0) - (b.ts || 0));
    if (!rows.length) { toast('トレ記録がまだありません'); return; }
    // 先頭のBOM（文字コードの目印）はExcelでの文字化け防止
    const csv = '﻿日付,種目,セット,重量kg,回数,RPE\n' + rows.flatMap(w =>
      w.sets.map((s, i) => `${w.date},${w.name},${i + 1},${s.weight},${s.reps},${s.rpe ?? ''}`)
    ).join('\n');
    const file = new File([csv], `fitfuel-トレ記録-${todayStr()}.csv`, { type: 'text/csv' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'トレ記録CSV' }); } catch (e) { /* キャンセル時 */ }
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  };

  // ---- 筋トレ記録アプリ（kintore-log）からの移行 ----
  root.querySelector('#kt-import').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.logs)) throw new Error('logs（セット記録の配列）が見つかりません');
      if (!confirm(`${data.logs.length}件のセット記録を取り込みます。\n既存のデータはそのまま残ります（同じ日の同じ種目はスキップ）。よろしいですか？`)) return;

      // 1セット1件の記録（{ts,d,ex,w,r}）を「日付×種目」でまとめてfitfuel形式にする
      const groups = {};
      for (const l of data.logs) {
        if (!l.d || !l.ex) continue;
        (groups[`${l.d}|${l.ex}`] ??= []).push(l);
      }
      const have = new Set((await db.all('workouts')).map(w => `${w.date}|${w.name}`));
      const exByName = new Map((await db.all('exercises')).map(x => [x.name, x.id]));
      // 筋トレ記録アプリの標準種目のうちfitfuel未登録のものの部位
      const PART = { 'ローイング': '背中', '腹筋': '腹' };
      const getExId = async (name) => {
        let id = exByName.get(name);
        if (id == null) {
          id = await db.put('exercises', { name, part: PART[name] || 'その他' });
          exByName.set(name, id);
        }
        return id;
      };

      let added = 0, skipped = 0;
      for (const [key, sets] of Object.entries(groups)) {
        if (have.has(key)) { skipped++; continue; }
        const date = key.slice(0, 10), name = key.slice(11);
        sets.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        await db.put('workouts', {
          date, exerciseId: await getExId(name), name,
          sets: sets.map(s => ({ weight: +s.w || 0, reps: +s.r || 0, rpe: null })),
          memo: '', pr: false, ts: sets[0].ts || Date.now(),
        });
        added++;
      }
      // 種目リストとタイマー設定も引き継ぐ
      if (Array.isArray(data.settings?.exercises)) {
        for (const name of data.settings.exercises) await getExId(name);
      }
      if (data.settings) {
        const s = data.settings, patch = {};
        if (timer.SOUNDS[s.sound]) patch.sound = s.sound;
        if (typeof s.vol === 'number') patch.vol = Math.min(1, Math.max(0, s.vol));
        if (typeof s.autoTimer === 'boolean') patch.autoTimer = s.autoTimer;
        if (typeof s.rest === 'number' && s.rest >= 30) patch.rest = s.rest;
        await timer.setPrefs(patch);
      }
      alert(`移行が完了しました。\n・取り込み: ${added}件（日付×種目）\n・スキップ（既存と重複）: ${skipped}件\nトレ画面と記録→トレのグラフで確認できます。`);
      refresh();
    } catch (err) {
      // 原因: 選んだファイルが筋トレ記録アプリのバックアップJSONではない
      // 解決策: 筋トレ記録アプリの設定→「保存（JSON）」で作ったファイルを選び直す
      alert('読み込めませんでした。筋トレ記録アプリでバックアップしたJSONファイルか確認してください。\n詳細: ' + err.message);
    }
  };

  // ---- バックアップ ----
  root.querySelector('#bk-export').onclick = async () => {
    const data = await db.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fitfuel-backup-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('エクスポートしました');
  };
  root.querySelector('#bk-import').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!confirm('現在のデータをバックアップの内容で置き換えます。よろしいですか？')) return;
      await db.importAll(data);
      toast('インポートしました');
      refresh();
    } catch (err) {
      // 原因: ファイルが壊れているか、このアプリのバックアップではない
      // 解決策: エクスポートし直したJSONファイルを選び直す
      alert('読み込めませんでした。このアプリでエクスポートしたJSONファイルか確認してください。\n詳細: ' + err.message);
    }
  };
  root.querySelector('#bk-wipe').onclick = async () => {
    if (!confirm('本当に全データを削除しますか？この操作は元に戻せません。')) return;
    if (!confirm('最終確認: 食事・体重・トレーニングの全記録が消えます。' +
      (sync.syncOn() ? '\n（クラウド同期がオンのため、クラウド上のデータも削除で上書きされます）' : ''))) return;
    for (const s of db.STORES) await db.clearStore(s);
    location.reload();
  };
}
