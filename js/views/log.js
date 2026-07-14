// ============================================================
// log.js — 記録画面（体重グラフ／カレンダー／レポート）
// ============================================================
import * as db from '../db.js';
import { weeklyAverages, e1rm } from '../calc.js';
import { lineChart, barChart } from '../charts.js';
import { esc, fmt, openSheet, closeSheet, toast, todayStr, addDays, weekdayOf } from '../ui.js';
import { state, refresh, setTab } from '../app.js';
import { sumMeals } from './meals.js';

export async function render(root) {
  const sub = state.logTab || 'weight';
  root.innerHTML = `
    <header class="page-head"><h1 class="home-title">記録</h1></header>
    <div class="tabs page-tabs">
      ${[['weight', '体重'], ['train', 'トレ'], ['cal', 'カレンダー'], ['report', 'レポート']].map(([k, l]) =>
        `<button class="tab${sub === k ? ' on' : ''}" data-sub="${k}">${l}</button>`).join('')}
    </div>
    <div id="log-pane"></div>`;

  root.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => {
    state.logTab = b.dataset.sub;
    refresh();
  });

  const pane = root.querySelector('#log-pane');
  if (sub === 'weight') await renderWeight(pane);
  else if (sub === 'train') await renderTrain(pane);
  else if (sub === 'cal') await renderCalendar(pane);
  else await renderReport(pane);
}

// ============ トレ（種目別の推移・集計） ============
async function renderTrain(pane) {
  const workouts = (await db.all('workouts'))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.ts || 0) - (b.ts || 0));
  if (!workouts.length) {
    pane.innerHTML = '<div class="card empty-card">トレーニング記録がまだありません。<br>トレ画面から記録するか、設定→データで筋トレ記録アプリから移行できます。</div>';
    return;
  }

  // 種目リスト（最後にやった日が新しい順）
  const lastDate = new Map();
  workouts.forEach(w => lastDate.set(w.name, w.date));
  const names = [...lastDate.keys()].sort((a, b) => lastDate.get(b).localeCompare(lastDate.get(a)));
  const sel = names.includes(state.trainEx) ? state.trainEx : '';

  const list = sel ? workouts.filter(w => w.name === sel) : workouts;
  const allSets = list.flatMap(w => w.sets);
  const maxW = Math.max(0, ...allSets.map(s => s.weight || 0));
  const best = Math.max(0, ...allSets.map(s => e1rm(s.weight, s.reps)));
  const month = todayStr().slice(0, 7);
  const volMonth = list.filter(w => w.date.startsWith(month))
    .reduce((a, w) => a + w.sets.reduce((x, s) => x + (s.weight || 0) * (s.reps || 0), 0), 0);

  // 直近の記録（日ごとにまとめて新しい順に10日分）
  const byDate = {};
  list.forEach(w => (byDate[w.date] ??= []).push(w));
  const recent = Object.keys(byDate).sort().reverse().slice(0, 10);

  pane.innerHTML = `
    <div class="card">
      <label>種目<select id="tr-ex">
        <option value="">すべての種目</option>
        ${names.map(n => `<option${n === sel ? ' selected' : ''}>${esc(n)}</option>`).join('')}
      </select></label>
    </div>
    <div class="stat-grid">
      <div class="card stat"><div class="stat-label">トレ日数</div><div class="stat-val">${new Set(list.map(w => w.date)).size}<span> 日</span></div></div>
      <div class="card stat"><div class="stat-label">最大重量</div><div class="stat-val">${fmt(maxW, 1)}<span> kg</span></div></div>
      <div class="card stat"><div class="stat-label">今月の総挙上量</div><div class="stat-val">${fmt(Math.round(volMonth))}<span> kg</span></div></div>
      <div class="card stat"><div class="stat-label">推定1RMベスト</div><div class="stat-val">${fmt(best, 1)}<span> kg</span></div></div>
    </div>
    <div class="card">
      <div class="card-head"><span>${sel ? `${esc(sel)}：日別の最大重量` : '重量の推移'}</span></div>
      <div id="tr-chart">${sel ? '' : '<div class="chart-empty">種目を選ぶと推移グラフを表示します</div>'}</div>
    </div>
    <div class="card">
      <div class="card-head"><span>最近の記録</span></div>
      ${recent.map(d => `
        <div class="tr-day-head">${+d.slice(5, 7)}/${+d.slice(8)}（${weekdayOf(d)}）</div>
        ${byDate[d].map(w => `
          <div class="tr-row">
            <span class="tr-name">${esc(w.name)}${w.pr ? ' 🏆' : ''}</span>
            <span class="tr-sets">${w.sets.map(s => `${s.weight > 0 ? fmt(s.weight, 1) + 'kg' : '自重'}×${s.reps}`).join('　')}</span>
          </div>`).join('')}`).join('')}
    </div>`;

  // グラフ: 日別の最大重量（直近20回分）
  if (sel) {
    const byDay = {};
    list.forEach(w => w.sets.forEach(s => { byDay[w.date] = Math.max(byDay[w.date] || 0, s.weight || 0); }));
    const pts = Object.entries(byDay).sort().slice(-20).map(([d, v]) => ({ d, v }));
    if (pts.length >= 2) {
      lineChart(pane.querySelector('#tr-chart'), pts,
        { color: 'var(--p)', unit: 'kg', dates: [pts[0].d, pts[pts.length - 1].d] });
    } else {
      pane.querySelector('#tr-chart').innerHTML = '<div class="chart-empty">グラフは2日分以上の記録で表示されます</div>';
    }
  }

  pane.querySelector('#tr-ex').onchange = (e) => {
    state.trainEx = e.target.value;
    refresh();
  };
}

// ============ 体重 ============
async function renderWeight(pane) {
  const range = state.weightRange || 30; // 表示日数
  const rows = (await db.all('weights')).sort((a, b) => a.date.localeCompare(b.date));
  const from = addDays(todayStr(), -range + 1);
  const inRange = rows.filter(r => r.date >= from);
  const weeks = weeklyAverages(rows);
  const today = await db.get('weights', todayStr());

  pane.innerHTML = `
    <button class="card mini-card wide" id="w-input">
      <div class="mini-label">今日の体重</div>
      <div class="mini-val">${today ? `${fmt(today.weight, 1)}<span> kg</span>` : '<span class="mini-add">＋ 入力する</span>'}</div>
      ${today ? `<div class="mini-sub">${today.bodyFat ? `体脂肪 ${fmt(today.bodyFat, 1)}%　` : ''}${today.muscle ? `筋肉量 ${fmt(today.muscle, 1)}kg` : ''}</div>` : ''}
    </button>

    <div class="card">
      <div class="card-head"><span>体重の推移</span></div>
      <div class="seg seg-sm">
        ${[[14, '2週'], [30, '1ヶ月'], [90, '3ヶ月'], [365, '1年']].map(([v, l]) =>
          `<button class="seg-btn${range === v ? ' on' : ''}" data-range="${v}">${l}</button>`).join('')}
      </div>
      <div id="w-chart"></div>
    </div>

    ${weeks.length ? `
    <div class="card">
      <div class="card-head"><span>週平均</span></div>
      <table class="w-table">
        ${weeks.map((w, i) => {
          const next = weeks[i + 1];
          const diff = next ? Math.round((w.avg - next.avg) * 100) / 100 : null;
          return `<tr><td>${w.monday.slice(5).replace('-', '/')}〜</td>
            <td><b>${fmt(w.avg, 2)}</b> kg</td>
            <td class="${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}">${diff == null ? '' : (diff > 0 ? '＋' : '') + fmt(diff, 2)}</td>
            <td class="mut">${w.count}回</td></tr>`;
        }).join('')}
      </table>
    </div>` : ''}

    ${inRange.filter(r => r.bodyFat).length >= 2 ? `
    <div class="card"><div class="card-head"><span>体脂肪率</span></div><div id="bf-chart"></div></div>` : ''}
    ${inRange.filter(r => r.muscle).length >= 2 ? `
    <div class="card"><div class="card-head"><span>筋肉量</span></div><div id="ms-chart"></div></div>` : ''}`;

  lineChart(pane.querySelector('#w-chart'),
    inRange.map(r => ({ d: r.date, v: r.weight })),
    { color: 'var(--chart-1)', unit: 'kg', dates: [from, todayStr()] });

  const bf = pane.querySelector('#bf-chart');
  if (bf) lineChart(bf, inRange.filter(r => r.bodyFat).map(r => ({ d: r.date, v: r.bodyFat })),
    { color: 'var(--f)', unit: '%', dates: [from, todayStr()] });
  const ms = pane.querySelector('#ms-chart');
  if (ms) lineChart(ms, inRange.filter(r => r.muscle).map(r => ({ d: r.date, v: r.muscle })),
    { color: 'var(--p)', unit: 'kg', dates: [from, todayStr()] });

  pane.querySelector('#w-input').onclick = () => openWeightSheet(todayStr(), refresh);
  pane.querySelectorAll('[data-range]').forEach(b => b.onclick = () => {
    state.weightRange = +b.dataset.range;
    refresh();
  });
}

// 体重入力シート（ホームからも使う）
export async function openWeightSheet(date, onSaved) {
  const cur = await db.get('weights', date);
  const body = openSheet('身体の記録', `
    <label>体重 <span class="unit">kg</span><input id="wt" type="number" inputmode="decimal" step="0.1" value="${cur?.weight ?? ''}"></label>
    <div class="form-row2">
      <label>体脂肪率 <span class="unit">%（任意）</span><input id="bf" type="number" inputmode="decimal" step="0.1" value="${cur?.bodyFat ?? ''}"></label>
      <label>筋肉量 <span class="unit">kg（任意）</span><input id="ms" type="number" inputmode="decimal" step="0.1" value="${cur?.muscle ?? ''}"></label>
    </div>
    <button class="btn btn-big" id="w-save">保存する</button>`);
  body.querySelector('#wt').focus();
  body.querySelector('#w-save').onclick = async () => {
    const weight = +body.querySelector('#wt').value;
    if (!weight || weight < 20 || weight > 300) { toast('体重を入力してください'); return; }
    await db.put('weights', {
      date, weight,
      bodyFat: +body.querySelector('#bf').value || null,
      muscle: +body.querySelector('#ms').value || null,
    });
    closeSheet();
    toast('記録しました');
    onSaved();
  };
}

// ============ カレンダー ============
async function renderCalendar(pane) {
  const ym = state.calMonth || todayStr().slice(0, 7);
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const lead = first.getDay(); // 日曜始まり（日曜=0）

  // 月内データをまとめて取得して日付ごとに集計する
  const [meals, workouts, weights, targets] = await Promise.all([
    db.all('meals'), db.all('workouts'), db.all('weights'),
    db.getSetting('targets', { kcal: 2200 }),
  ]);
  const prefix = `${ym}-`;
  const byDay = {};
  const dayOf = d => { (byDay[d] ??= { meals: [], wo: [], w: null }); return byDay[d]; };
  meals.filter(x => x.date.startsWith(prefix)).forEach(x => dayOf(x.date).meals.push(x));
  workouts.filter(x => x.date.startsWith(prefix)).forEach(x => dayOf(x.date).wo.push(x));
  weights.filter(x => x.date.startsWith(prefix)).forEach(x => dayOf(x.date).w = x);

  const sel = state.calSel && state.calSel.startsWith(prefix) ? state.calSel : null;
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<div></div>');
  for (let d = 1; d <= days; d++) {
    const ds = `${ym}-${String(d).padStart(2, '0')}`;
    const info = byDay[ds];
    const dots = info ? [
      info.meals.length ? '<i class="cdot" style="background:var(--chart-1)"></i>' : '',
      info.wo.length ? '<i class="cdot" style="background:var(--p)"></i>' : '',
      info.w ? '<i class="cdot" style="background:var(--c)"></i>' : '',
    ].join('') : '';
    cells.push(`<button class="cal-cell${ds === todayStr() ? ' today' : ''}${ds === sel ? ' sel' : ''}" data-d="${ds}">
      <span>${d}</span><span class="cdots">${dots}</span></button>`);
  }

  const mNav = (n) => {
    const d = new Date(y, m - 1 + n, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };

  pane.innerHTML = `
    <div class="card">
      <div class="date-nav">
        <button class="icon-btn" data-m="${mNav(-1)}">‹</button>
        <div class="date-title">${y}年${m}月</div>
        <button class="icon-btn" data-m="${mNav(1)}">›</button>
      </div>
      <div class="cal-grid cal-head">${['日', '月', '火', '水', '木', '金', '土'].map(w => `<div>${w}</div>`).join('')}</div>
      <div class="cal-grid">${cells.join('')}</div>
      <div class="cal-legend">
        <span><i class="cdot" style="background:var(--chart-1)"></i>食事</span>
        <span><i class="cdot" style="background:var(--p)"></i>トレ</span>
        <span><i class="cdot" style="background:var(--c)"></i>体重</span>
      </div>
    </div>
    <div id="cal-detail"></div>`;

  pane.querySelectorAll('[data-m]').forEach(b => b.onclick = () => {
    state.calMonth = b.dataset.m;
    refresh();
  });
  pane.querySelectorAll('[data-d]').forEach(b => b.onclick = () => {
    state.calSel = b.dataset.d;
    refresh();
  });

  if (sel && byDay[sel]) {
    const info = byDay[sel];
    const t = sumMeals(info.meals);
    pane.querySelector('#cal-detail').innerHTML = `
      <div class="card">
        <div class="card-head"><span>${+sel.slice(5, 7)}月${+sel.slice(8)}日</span>
          <b>${info.meals.length ? fmt(t.kcal) + ' / ' + fmt(targets.kcal) + ' kcal' : '食事記録なし'}</b></div>
        ${info.meals.length ? `<div class="dt-pfc"><span>P ${fmt(t.p, 1)}g</span><span>F ${fmt(t.f, 1)}g</span><span>C ${fmt(t.c, 1)}g</span></div>` : ''}
        ${info.w ? `<div class="cal-line">体重 <b>${fmt(info.w.weight, 1)}kg</b>${info.w.bodyFat ? `　体脂肪 ${fmt(info.w.bodyFat, 1)}%` : ''}</div>` : ''}
        ${info.wo.length ? `<div class="cal-line">トレ: ${esc(info.wo.map(w => w.name).join('・'))}</div>` : ''}
        <div class="two-col">
          <button class="btn-ghost" id="go-meal">食事を見る</button>
          <button class="btn-ghost" id="go-train">トレを見る</button>
        </div>
      </div>`;
    pane.querySelector('#go-meal').onclick = () => { state.date = sel; setTab('meals'); };
    pane.querySelector('#go-train').onclick = () => { state.date = sel; setTab('train'); };
  }
}

// ============ レポート ============
async function renderReport(pane) {
  const range = state.repRange || 7;
  const from = addDays(todayStr(), -range + 1);
  const [meals, workouts, weights, targets] = await Promise.all([
    db.all('meals'), db.all('workouts'), db.all('weights'),
    db.getSetting('targets', { kcal: 2200, p: 130, f: 60, c: 280 }),
  ]);

  // 日ごとのカロリー集計
  const days = [];
  for (let i = 0; i < range; i++) {
    const d = addDays(from, i);
    const t = sumMeals(meals.filter(x => x.date === d));
    days.push({ d, ...t });
  }
  const logged = days.filter(x => x.kcal > 0);
  const avg = (k) => logged.length ? Math.round(logged.reduce((s, x) => s + x[k], 0) / logged.length) : 0;
  const woDays = new Set(workouts.filter(x => x.date >= from).map(x => x.date)).size;
  const wRows = weights.filter(r => r.date >= from).sort((a, b) => a.date.localeCompare(b.date));
  const wDiff = wRows.length >= 2 ? Math.round((wRows[wRows.length - 1].weight - wRows[0].weight) * 10) / 10 : null;

  pane.innerHTML = `
    <div class="seg seg-sm">
      ${[[7, '週'], [30, '月'], [365, '年']].map(([v, l]) =>
        `<button class="seg-btn${range === v ? ' on' : ''}" data-rep="${v}">${l}</button>`).join('')}
    </div>
    <div class="stat-grid">
      <div class="card stat"><div class="stat-label">平均摂取</div><div class="stat-val">${fmt(avg('kcal'))}<span> kcal</span></div></div>
      <div class="card stat"><div class="stat-label">トレ日数</div><div class="stat-val">${woDays}<span> 日</span></div></div>
      <div class="card stat"><div class="stat-label">平均P</div><div class="stat-val">${fmt(avg('p'))}<span> g</span></div></div>
      <div class="card stat"><div class="stat-label">体重変化</div><div class="stat-val">${wDiff == null ? '-' : (wDiff > 0 ? '＋' : '') + fmt(wDiff, 1)}<span> kg</span></div></div>
    </div>
    <div class="card">
      <div class="card-head"><span>摂取カロリー</span><b class="mut">目標 ${fmt(targets.kcal)}</b></div>
      <div id="r-kcal"></div>
    </div>
    <div class="card">
      <div class="card-head"><span>体重</span></div>
      <div id="r-weight"></div>
    </div>
    <div class="card">
      <div class="card-head"><span>PFC 平均（記録日ベース）</span></div>
      <div class="pfc-bars">
        ${[['p', 'P', 'var(--p)'], ['f', 'F', 'var(--f)'], ['c', 'C', 'var(--c)']].map(([k, l, col]) => `
          <div class="pfc-bar-row">
            <span class="pfc-bar-label">${l}</span>
            <div class="bar"><div class="bar-fill" style="width:${Math.min(100, avg(k) / targets[k] * 100)}%;background:${col}"></div></div>
            <span class="pfc-bar-val">${fmt(avg(k))} / ${fmt(targets[k])}g</span>
          </div>`).join('')}
      </div>
    </div>`;

  // 棒グラフ（年表示は月別に集約）
  let bars;
  if (range <= 31) {
    bars = days.map(x => ({ label: `${+x.d.slice(8)}日`, v: x.kcal }));
  } else {
    const byM = {};
    days.forEach(x => {
      const k = x.d.slice(0, 7);
      (byM[k] ??= { sum: 0, n: 0 });
      if (x.kcal > 0) { byM[k].sum += x.kcal; byM[k].n++; }
    });
    bars = Object.entries(byM).map(([k, v]) => ({ label: `${+k.slice(5)}月`, v: v.n ? Math.round(v.sum / v.n) : 0 }));
  }
  barChart(pane.querySelector('#r-kcal'), bars,
    { color: 'var(--chart-1)', unit: ' kcal', target: targets.kcal });
  lineChart(pane.querySelector('#r-weight'),
    wRows.map(r => ({ d: r.date, v: r.weight })),
    { color: 'var(--c)', unit: 'kg', dates: [from, todayStr()] });

  pane.querySelectorAll('[data-rep]').forEach(b => b.onclick = () => {
    state.repRange = +b.dataset.rep;
    refresh();
  });
}
