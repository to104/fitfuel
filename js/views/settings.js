// ============================================================
// settings.js — 設定画面
// プロフィール・目標の編集 / サプリ・種目・Myフード管理 / バックアップ
// ============================================================
import * as db from '../db.js';
import { ACTIVITY, GOALS, recommend } from '../calc.js';
import { esc, fmt, openSheet, closeSheet, toast, segmented, segValue, todayStr } from '../ui.js';
import { refresh, APP_VER } from '../app.js';

export async function render(root) {
  const [profile, targets, supps, exercises, myFoods] = await Promise.all([
    db.getSetting('profile', {}),
    db.getSetting('targets', {}),
    db.all('supplements'),
    db.all('exercises'),
    db.all('customFoods'),
  ]);

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
      ${exercises.map(x => `<div class="manage-row"><span>${esc(x.name)}<i class="mut"> ${esc(x.part || '')}</i></span><button class="icon-btn" data-del-ex="${x.id}">✕</button></div>`).join('') || '<div class="empty-line">未登録</div>'}
      <p class="hint">種目の追加はトレ画面の「＋種目を記録する」からもできます。</p>
    </div>

    <div class="sec-title">Myフード（自作食品・100gあたり）</div>
    <div class="card">
      ${myFoods.map(x => `<div class="manage-row"><span>${esc(x.name)}<i class="mut"> ${fmt(x.kcal)}kcal/P${fmt(x.p, 1)}</i></span><button class="icon-btn" data-del-food="${x.id}">✕</button></div>`).join('') || '<div class="empty-line">未登録（食事の手入力タブから登録できます）</div>'}
      <button class="btn-ghost" id="food-add">＋ Myフードを直接登録</button>
    </div>

    <div class="sec-title">データ</div>
    <div class="card">
      <button class="btn" id="bk-export">バックアップをエクスポート（JSON）</button>
      <label class="btn-ghost file-btn">バックアップをインポート<input id="bk-import" type="file" accept=".json,application/json" hidden></label>
      <p class="hint">エクスポートしたファイルはiCloudやGoogleドライブ等に保管してください。インポートすると現在のデータは置き換えられます。</p>
      <button class="btn-danger" id="bk-wipe">全データを削除</button>
    </div>

    <div class="app-info">筋トレ・栄養管理 v${APP_VER}<br>栄養値は日本食品標準成分表（八訂）ベースの近似値です</div>`;

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
  root.querySelectorAll('[data-del-ex]').forEach(b => b.onclick = async () => {
    if (!confirm('種目を削除しますか？（過去の記録は残ります）')) return;
    await db.del('exercises', +b.dataset.delEx);
    refresh();
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
      <button class="btn btn-big" id="cf-save">登録する</button>`);
    body.querySelector('#cf-save').onclick = async () => {
      const name = body.querySelector('#cf-name').value.trim();
      if (!name) { toast('食品名を入力してください'); return; }
      await db.put('customFoods', {
        name, kana: '',
        kcal: +body.querySelector('#cf-kcal').value || 0,
        p: +body.querySelector('#cf-p').value || 0,
        f: +body.querySelector('#cf-f').value || 0,
        c: +body.querySelector('#cf-c').value || 0,
        salt: 0,
        u: ['1食', +body.querySelector('#cf-g').value || 100],
      });
      closeSheet();
      toast('登録しました');
      refresh();
    };
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
    if (!confirm('最終確認: 食事・体重・トレーニングの全記録が消えます。')) return;
    for (const s of db.STORES) await db.clearStore(s);
    location.reload();
  };
}
