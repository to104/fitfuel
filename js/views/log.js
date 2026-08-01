// ============================================================
// log.js — 記録画面（体重グラフ／カレンダー／レポート）
// ============================================================
import * as db from '../db.js';
import { weeklyAverages, e1rm } from '../calc.js';
import { lineChart, barChart } from '../charts.js';
import { esc, fmt, openSheet, closeSheet, toast, todayStr, addDays, weekdayOf } from '../ui.js';
import { state, refresh, setTab } from '../app.js';
import { sumMeals } from './meals.js';
import * as volume from './volume.js';
import * as M from '../muscles.js';

export async function render(root) {
  const sub = state.logTab || 'weight';
  root.innerHTML = `
    <header class="page-head"><h1 class="home-title">記録</h1></header>
    <div class="tabs page-tabs">
      ${[['weight', '体重'], ['train', 'トレ'], ['vol', '部位別'], ['cal', 'カレンダー'], ['report', 'レポート']].map(([k, l]) =>
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
  else if (sub === 'vol') await volume.render(pane);
  else if (sub === 'cal') await renderCalendar(pane);
  else await renderReport(pane);
}

// ============ トレ（種目別・部位別の推移と集計） ============
async function renderTrain(pane) {
  const [rows, custMap, custBw, weights, profile] = await Promise.all([
    db.all('workouts'),
    db.getSetting('volMap', {}),   // 種目→部位の上書き設定（部位別タブと共通）
    db.getSetting('volBw', {}),    // 自重係数の上書き設定
    db.all('weights'),
    db.getSetting('profile', {}),
  ]);
  const workouts = rows.sort((a, b) => a.date.localeCompare(b.date) || (a.ts || 0) - (b.ts || 0));
  if (!workouts.length) {
    pane.innerHTML = '<div class="card empty-card">トレーニング記録がまだありません。<br>トレ画面から記録するか、設定→データで筋トレ記録アプリから移行できます。</div>';
    return;
  }

  // ---- 部位で絞り込む（その部位を主働筋または協働筋にふくむ種目だけ） ----
  const part = M.MUSCLE_BY_ID[state.trainPart] ? state.trainPart : '';
  const partName = part ? M.MUSCLE_BY_ID[part].name : '';
  const partList = part
    ? workouts.filter(w => { const m = M.mapFor(w.name, custMap); return !!(m && m[part]); })
    : workouts;

  // 種目リスト（絞り込んだ中で、最後にやった日が新しい順）
  const lastDate = new Map();
  partList.forEach(w => lastDate.set(w.name, w.date));
  const names = [...lastDate.keys()].sort((a, b) => lastDate.get(b).localeCompare(lastDate.get(a)));
  const sel = names.includes(state.trainEx) ? state.trainEx : '';

  const list = sel ? partList.filter(w => w.name === sel) : partList;
  const allSets = list.flatMap(w => w.sets);
  const maxW = Math.max(0, ...allSets.map(s => s.weight || 0));
  const best = Math.max(0, ...allSets.map(s => e1rm(s.weight, s.reps)));
  const month = todayStr().slice(0, 7);
  const volMonth = list.filter(w => w.date.startsWith(month))
    .reduce((a, w) => a + w.sets.reduce((x, s) => x + (s.weight || 0) * (s.reps || 0), 0), 0);

  // ---- 日ごとの部位別ボリューム（集計ルールは「部位別」タブとまったく同じ） ----
  const agg = M.aggregateByDate(list, {
    map: custMap, bw: custBw, weights, fallbackWeight: profile.weight || 0,
  });
  const volOf = new Map(agg.days.map(d => [d.date, d.byMuscle]));
  // 部位を選んでいるときは、その部位の今月ぶんのトン数を出す
  const partMonth = part
    ? agg.days.filter(d => d.date.startsWith(month))
        .reduce((a, d) => a + (d.byMuscle[part]?.tonnage || 0), 0)
    : 0;

  // 直近の記録（日ごとにまとめて新しい順に10日分）
  const byDate = {};
  list.forEach(w => (byDate[w.date] ??= []).push(w));
  const recent = Object.keys(byDate).sort().reverse().slice(0, 10);

  // 1日ぶんの見出し右側（部位を選んでいればその部位の値、選んでいなければ日合計）
  const dayVol = (d) => {
    if (part) {
      const c = volOf.get(d)?.[part];
      return `${esc(partName)} ${fmt(Math.round(c?.tonnage || 0))} kg・${fmt(c?.sets || 0, 1)} set`;
    }
    const raw = byDate[d].reduce((a, w) =>
      a + w.sets.reduce((x, s) => x + (s.weight || 0) * (s.reps || 0), 0), 0);
    return `ボリューム ${fmt(Math.round(raw))} kg`;
  };

  // 1日ぶんの部位別内訳チップ（セット数の多い順）
  // 部位を選んでいるときは、その部位は見出しに出ているのでチップからは省く
  const dayParts = (d) => {
    const bm = volOf.get(d) || {};
    const cells = M.MUSCLES.filter(m => bm[m.id] && m.id !== part).map(m => ({ m, ...bm[m.id] }))
      .sort((a, b) => b.sets - a.sets);
    if (!cells.length) return '';
    return `<div class="tr-parts">${part ? '<span class="tr-part-lead">いっしょに効いた部位</span>' : ''}${cells.map(c => `
      <span class="tr-part"><i style="background:${M.muscleColor(c.m.id)}"></i>${esc(c.m.name)} ${fmt(c.sets, 1)}set${c.tonnage ? `・${fmt(Math.round(c.tonnage))}kg` : ''}</span>`).join('')}</div>`;
  };

  pane.innerHTML = `
    <div class="card">
      <div class="form-row2">
        <label>部位<select id="tr-part">
          <option value="">すべての部位</option>
          ${M.MUSCLES.map(m => `<option value="${m.id}"${m.id === part ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}
        </select></label>
        <label>種目<select id="tr-ex">
          <option value="">すべての種目</option>
          ${names.map(n => `<option${n === sel ? ' selected' : ''}>${esc(n)}</option>`).join('')}
        </select></label>
      </div>
      ${part ? `<div class="hint">「${esc(partName)}」を主働筋または協働筋にふくむ種目だけを表示しています。</div>` : ''}
    </div>
    <div class="stat-grid">
      <div class="card stat"><div class="stat-label">トレ日数</div><div class="stat-val">${new Set(list.map(w => w.date)).size}<span> 日</span></div></div>
      <div class="card stat"><div class="stat-label">最大重量</div><div class="stat-val">${fmt(maxW, 1)}<span> kg</span></div></div>
      <div class="card stat"><div class="stat-label">今月の${part ? `${esc(partName)}ボリューム` : '総挙上量'}</div><div class="stat-val">${fmt(Math.round(part ? partMonth : volMonth))}<span> kg</span></div></div>
      <div class="card stat"><div class="stat-label">推定1RMベスト</div><div class="stat-val">${fmt(best, 1)}<span> kg</span></div></div>
    </div>
    <div class="card">
      <div class="card-head"><span>${sel ? `${esc(sel)}：日別の最大重量`
        : part ? `${esc(partName)}：日別ボリューム` : '重量の推移'}</span></div>
      <div id="tr-chart">${sel || part ? '' : '<div class="chart-empty">部位または種目を選ぶとグラフを表示します</div>'}</div>
    </div>
    <div class="card">
      <div class="card-head"><span>最近の記録</span><b class="mut">部位別の内訳つき</b></div>
      ${recent.map(d => `
        <div class="tr-day-head">
          <span>${+d.slice(5, 7)}/${+d.slice(8)}（${weekdayOf(d)}）</span>
          <span class="tr-day-vol">${dayVol(d)}</span>
        </div>
        ${dayParts(d)}
        ${byDate[d].map(w => `
          <div class="tr-row">
            <span class="tr-name">${esc(w.name)}${w.pr ? ' 🏆' : ''}</span>
            <span class="tr-sets">${w.sets.map(s => `${s.weight > 0 ? fmt(s.weight, 1) + 'kg' : '自重'}×${s.reps}`).join('　')}</span>
          </div>`).join('')}`).join('') || '<div class="empty-line">この条件の記録はありません</div>'}
      ${recent.length ? `<div class="hint">部位別の内訳は「部位別」タブと同じ集計です（ウォームアップ＝その日・その種目の最大の70%未満は除外、自重ぶんは体重から算入）。
        協働筋はセット数だけ0.5で数え、kgは主働筋にまとめて計上するため、日合計とは一致しません。</div>` : ''}
      ${agg.unmapped.length ? `<div class="hint">部位が未設定のため内訳に入っていない種目: ${esc(agg.unmapped.join('・'))}（「部位別」タブで設定できます）</div>` : ''}
    </div>`;

  const chart = pane.querySelector('#tr-chart');
  if (sel) {
    // グラフ: 日別の最大重量（直近20回分）
    const byDay = {};
    list.forEach(w => w.sets.forEach(s => { byDay[w.date] = Math.max(byDay[w.date] || 0, s.weight || 0); }));
    const pts = Object.entries(byDay).sort().slice(-20).map(([d, v]) => ({ d, v }));
    if (pts.length >= 2) {
      lineChart(chart, pts, { color: 'var(--p)', unit: 'kg', dates: [pts[0].d, pts[pts.length - 1].d] });
    } else {
      chart.innerHTML = '<div class="chart-empty">グラフは2日分以上の記録で表示されます</div>';
    }
  } else if (part) {
    // グラフ: 選んだ部位の日別ボリューム（記録のある直近14日ぶん）
    const bars = agg.days.slice(-14).map(d => ({
      label: `${+d.date.slice(5, 7)}/${+d.date.slice(8)}`,
      v: Math.round(d.byMuscle[part]?.tonnage || 0),
    }));
    barChart(chart, bars, { color: M.muscleColor(part), unit: ' kg' });
  }

  pane.querySelector('#tr-part').onchange = (e) => {
    state.trainPart = e.target.value;
    refresh();
  };
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
