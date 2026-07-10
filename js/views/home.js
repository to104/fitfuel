// ============================================================
// home.js — ホーム（ダッシュボード）
// 今日のカロリー・PFC・水分・体重・トレ・サプリ・アドバイスを一覧表示。
// ホームは常に「今日」を表示する。
// ============================================================
import * as db from '../db.js';
import { advice, workoutsKcal, microTargets } from '../calc.js';
import { microsOf } from '../foods.js';
import { esc, fmt, ring, toast, todayStr } from '../ui.js';
import { mealsOf, sumMeals, openAddSheet, SLOTS, microCardHtml } from './meals.js';
import { openWeightSheet } from './log.js';
import { refresh, setTab } from '../app.js';

export async function render(root) {
  const date = todayStr();
  const [targets, profile, rows, waterRow, weightRow, workouts, supps, suppLog] = await Promise.all([
    db.getSetting('targets', { kcal: 2200, p: 130, f: 60, c: 280, water: 2000 }),
    db.getSetting('profile', {}),
    mealsOf(date),
    db.get('water', date),
    db.get('weights', date),
    db.byDate('workouts', date),
    db.all('supplements'),
    db.get('suppLog', date),
  ]);
  const total = sumMeals(rows);
  const water = waterRow?.ml || 0;
  // トレ消費カロリー推定（体重は今日の記録→過去の最新→プロフィールの順で採用）
  const bw = weightRow?.weight ?? (await db.latestWeightUpTo(date)) ?? profile.weight ?? 0;
  const burn = workoutsKcal(workouts, bw);
  // ビタミン・ミネラル: 食事記録を内蔵DBと照合して自動集計
  const micros = microsOf(rows);
  const mTargets = microTargets(profile);
  const taken = new Set(suppLog?.taken || []);
  const remain = Math.max(0, targets.kcal - total.kcal);

  const tips = advice(total, targets, {
    trained: workouts.length > 0,
    waterMl: water,
    goal: profile.goal,
    micros,                    // 不足栄養素のアドバイス用
    microTargets: mTargets,
  });

  const d = new Date();
  const slotSums = Object.fromEntries(SLOTS.map(s => [s.k, sumMeals(rows.filter(r => r.slot === s.k)).kcal]));

  root.innerHTML = `
    <header class="page-head home-head">
      <div>
        <div class="home-date">${d.getMonth() + 1}月${d.getDate()}日（${['日', '月', '火', '水', '木', '金', '土'][d.getDay()]}）</div>
        <h1 class="home-title">今日のコンディション</h1>
      </div>
    </header>

    <!-- カロリーリング -->
    <div class="card hero">
      ${ring({
        pct: total.kcal / targets.kcal, color: 'var(--accent)', size: 168, stroke: 13,
        center: `<span class="hero-num">${fmt(remain)}</span>`, sub: '残り kcal', label: '',
      })}
      <div class="hero-side">
        <div class="hs-row"><span>摂取</span><b>${fmt(total.kcal)}</b></div>
        <div class="hs-row"><span>目標</span><b>${fmt(targets.kcal)}</b></div>
        <div class="hs-row"><span>達成率</span><b>${Math.round(total.kcal / targets.kcal * 100)}%</b></div>
      </div>
    </div>

    <!-- PFCリング -->
    <div class="card pfc-card">
      ${[
        { k: 'p', label: 'タンパク質', color: 'var(--p)' },
        { k: 'f', label: '脂質', color: 'var(--f)' },
        { k: 'c', label: '炭水化物', color: 'var(--c)' },
      ].map(x => ring({
        pct: total[x.k] / targets[x.k], color: x.color, size: 92, stroke: 8,
        center: `<b class="pfc-num">${fmt(total[x.k])}</b>`, sub: `/ ${fmt(targets[x.k])}g`, label: x.label,
      })).join('')}
    </div>

    <!-- 食事クイック追加 -->
    <div class="sec-title">食事を記録</div>
    <div class="quick-grid">
      ${SLOTS.map(s => `
        <button class="quick-slot card" data-slot="${s.k}">
          <span class="qs-label">${s.label}</span>
          <span class="qs-kcal">${slotSums[s.k] ? fmt(slotSums[s.k]) + ' kcal' : '＋ 追加'}</span>
        </button>`).join('')}
    </div>

    <!-- 水分 -->
    <div class="card">
      <div class="card-head"><span>水分</span><b>${fmt(water)} / ${fmt(targets.water)} ml</b></div>
      <div class="bar"><div class="bar-fill bar-water" style="width:${Math.min(100, water / targets.water * 100)}%"></div></div>
      <div class="water-btns">
        <button class="chip" data-water="250">＋250ml</button>
        <button class="chip" data-water="500">＋500ml</button>
        <button class="chip" data-water="1000">＋1L</button>
        <button class="chip chip-mut" data-water="-250">−250</button>
      </div>
    </div>

    <!-- ビタミン・ミネラル -->
    ${microCardHtml(rows, profile)}

    <!-- 体重・トレ -->
    <div class="two-col">
      <button class="card mini-card" id="hw">
        <div class="mini-label">今日の体重</div>
        <div class="mini-val">${weightRow ? `${fmt(weightRow.weight, 1)}<span> kg</span>` : '<span class="mini-add">＋ 入力</span>'}</div>
        ${weightRow?.bodyFat ? `<div class="mini-sub">体脂肪 ${fmt(weightRow.bodyFat, 1)}%</div>` : ''}
      </button>
      <button class="card mini-card" id="ht">
        <div class="mini-label">今日のトレーニング</div>
        <div class="mini-val">${workouts.length ? `${workouts.length}<span> 種目</span>` : '<span class="mini-add">＋ 記録</span>'}</div>
        ${workouts.length ? `<div class="mini-sub">${esc(workouts.map(w => w.name).slice(0, 3).join('・'))}</div>` : ''}
        ${burn ? `<div class="mini-sub">🔥 消費 約${fmt(burn)} kcal</div>` : ''}
      </button>
    </div>

    <!-- サプリ -->
    ${supps.length ? `
    <div class="card">
      <div class="card-head"><span>サプリメント</span><b>${taken.size} / ${supps.length}</b></div>
      <div class="supp-chips">
        ${supps.map(s => `<button class="chip supp${taken.has(s.id) ? ' on' : ''}" data-supp="${s.id}">${taken.has(s.id) ? '✓ ' : ''}${esc(s.name)}</button>`).join('')}
      </div>
    </div>` : ''}

    <!-- アドバイス -->
    <div class="card advice-card">
      <div class="card-head"><span>今日のアドバイス</span></div>
      ${tips.map(t => `<div class="advice-row"><span class="advice-ic advice-${t.icon.toLowerCase()}">${t.icon}</span><p>${esc(t.text)}</p></div>`).join('')}
    </div>`;

  // ---- イベント ----
  root.querySelectorAll('[data-slot]').forEach(b =>
    b.onclick = () => openAddSheet(b.dataset.slot, date, refresh));

  root.querySelectorAll('[data-water]').forEach(b => b.onclick = async () => {
    const ml = Math.max(0, water + +b.dataset.water);
    await db.put('water', { date, ml });
    refresh();
  });

  root.querySelector('#hw').onclick = () => openWeightSheet(date, refresh);
  root.querySelector('#ht').onclick = () => setTab('train');

  root.querySelectorAll('[data-supp]').forEach(b => b.onclick = async () => {
    const id = +b.dataset.supp;
    if (taken.has(id)) taken.delete(id); else taken.add(id);
    await db.put('suppLog', { date, taken: [...taken] });
    refresh();
  });
}
