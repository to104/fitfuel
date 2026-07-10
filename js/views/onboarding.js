// ============================================================
// onboarding.js — 初回設定画面
// プロフィール入力 → 推奨カロリー・PFC自動計算 → 確認・修正 → 保存
// ============================================================
import * as db from '../db.js';
import { ACTIVITY, GOALS, recommend, bmr, tdee } from '../calc.js';
import { esc, fmt, segmented, segValue, todayStr, toast } from '../ui.js';

export function render(root, onDone) {
  root.innerHTML = `
  <div class="ob">
    <div class="ob-step" id="ob1">
      <div class="ob-hero">
        <div class="ob-logo"></div>
        <h1>はじめに、あなたのことを<br>教えてください</h1>
        <p class="sub">推奨カロリーとPFC（タンパク質・脂質・炭水化物）を自動計算します</p>
      </div>
      <div class="card">
        <div class="form-row2">
          <label>身長 <span class="unit">cm</span><input id="ob-h" type="number" inputmode="decimal" value="170"></label>
          <label>体重 <span class="unit">kg</span><input id="ob-w" type="number" inputmode="decimal" value="65"></label>
        </div>
        <div class="form-row2">
          <label>年齢<input id="ob-a" type="number" inputmode="numeric" value="40"></label>
          <label>性別${segmented('sex', [{ v: 'm', label: '男性' }, { v: 'f', label: '女性' }], 'm')}</label>
        </div>
        <label>活動量（トレーニング以外の日常）
          <select id="ob-act">${ACTIVITY.map((a, i) => `<option value="${a.v}"${i === 1 ? ' selected' : ''}>${esc(a.label)}</option>`).join('')}</select>
        </label>
        <label>筋トレ頻度
          <select id="ob-freq">${[0, 1, 2, 3, 4, 5, 6, 7].map(n => `<option value="${n}"${n === 3 ? ' selected' : ''}>週${n}回</option>`).join('')}</select>
        </label>
        <label>目的${segmented('goal', GOALS.map(g => ({ v: g.v, label: g.label })), 'bulk')}</label>
      </div>
      <button class="btn btn-big" id="ob-calc">目標を計算する</button>
    </div>

    <div class="ob-step" id="ob2" hidden>
      <div class="ob-hero"><h1>あなたの目標</h1><p class="sub" id="ob-meta"></p></div>
      <div class="card">
        <label>目標カロリー <span class="unit">kcal</span><input id="t-kcal" type="number" inputmode="numeric"></label>
        <div class="form-row3">
          <label><span class="dot dot-p"></span>P <span class="unit">g</span><input id="t-p" type="number" inputmode="numeric"></label>
          <label><span class="dot dot-f"></span>F <span class="unit">g</span><input id="t-f" type="number" inputmode="numeric"></label>
          <label><span class="dot dot-c"></span>C <span class="unit">g</span><input id="t-c" type="number" inputmode="numeric"></label>
        </div>
        <label>水分目標 <span class="unit">ml</span><input id="t-water" type="number" inputmode="numeric" step="100"></label>
        <p class="hint">数値は後から「設定」でいつでも変更できます。</p>
      </div>
      <button class="btn btn-big" id="ob-save">この目標ではじめる</button>
      <button class="btn-ghost" id="ob-back">← 入力に戻る</button>
    </div>
  </div>`;

  const readProfile = () => ({
    height: +root.querySelector('#ob-h').value || 170,
    weight: +root.querySelector('#ob-w').value || 65,
    age: +root.querySelector('#ob-a').value || 40,
    sex: segValue(root, 'sex') || 'm',
    activity: +root.querySelector('#ob-act').value,
    freq: +root.querySelector('#ob-freq').value,
    goal: segValue(root, 'goal') || 'bulk',
  });

  root.querySelector('#ob-calc').onclick = () => {
    const p = readProfile();
    if (p.height < 100 || p.height > 250 || p.weight < 30 || p.weight > 200 || p.age < 10 || p.age > 100) {
      toast('入力値を確認してください（身長・体重・年齢が範囲外です）');
      return;
    }
    const rec = recommend(p);
    root.querySelector('#ob-meta').textContent =
      `基礎代謝 ${fmt(bmr(p))} kcal ／ 推定消費 ${fmt(tdee(p))} kcal ／ ${GOALS.find(g => g.v === p.goal).label}`;
    root.querySelector('#t-kcal').value = rec.kcal;
    root.querySelector('#t-p').value = rec.p;
    root.querySelector('#t-f').value = rec.f;
    root.querySelector('#t-c').value = rec.c;
    root.querySelector('#t-water').value = rec.water;
    root.querySelector('#ob1').hidden = true;
    root.querySelector('#ob2').hidden = false;
  };

  root.querySelector('#ob-back').onclick = () => {
    root.querySelector('#ob2').hidden = true;
    root.querySelector('#ob1').hidden = false;
  };

  root.querySelector('#ob-save').onclick = async () => {
    const p = readProfile();
    const targets = {
      kcal: +root.querySelector('#t-kcal').value || 2200,
      p: +root.querySelector('#t-p').value || 130,
      f: +root.querySelector('#t-f').value || 60,
      c: +root.querySelector('#t-c').value || 280,
      water: +root.querySelector('#t-water').value || 2000,
    };
    await db.setSetting('profile', p);
    await db.setSetting('targets', targets);
    await db.setSetting('onboarded', true);
    // 入力した体重を今日の記録としても保存しておく
    await db.put('weights', { date: todayStr(), weight: p.weight });
    toast('目標を設定しました');
    onDone();
  };
}
