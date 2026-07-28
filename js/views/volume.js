// ============================================================
// volume.js — 部位別ボリューム（記録タブのサブタブ「部位別」）
// 週ごとに、どの部位をどれだけ鍛えたかを積み上げ棒・折れ線・横棒で見る。
// 集計そのものは muscles.js の純関数が担当し、ここは描画と操作だけを持つ。
// ============================================================
import * as db from '../db.js';
import * as M from '../muscles.js';
import { stackedBarChart, trendChart } from '../charts.js';
import { esc, fmt, openSheet, closeSheet, toast, todayStr } from '../ui.js';
import { state, refresh } from '../app.js';

// 期間の選択肢（週数）
const RANGES = [[12, '12週'], [24, '24週'], [52, '1年']];

// 週の月曜を「7/27」の形にする
const wkLabel = (monday) => `${+monday.slice(5, 7)}/${+monday.slice(8)}`;

export async function render(pane) {
  // 文字を一段大きく表示するためのスコープ（.vol-scr の中だけ拡大する）
  pane.classList.add('vol-scr');

  // 表示状態の初期値（タブを行き来しても保つ）
  state.volMetric ??= 'sets';
  state.volRange ??= 12;
  state.volTrend ??= 'chest';
  state.volBalWeek ??= 'prev';
  state.volHidden ??= new Set();

  const [workouts, exercises, weights, profile, custMap, custBw, refBand] = await Promise.all([
    db.all('workouts'),
    db.all('exercises'),
    db.all('weights'),
    db.getSetting('profile', {}),
    db.getSetting('volMap', {}),
    db.getSetting('volBw', {}),
    db.getSetting('volRefBand', M.DEFAULT_REF_BAND),
  ]);

  const agg = M.aggregateVolume(workouts, {
    map: custMap, bw: custBw, weights, fallbackWeight: profile.weight || 0,
  });

  // 記録が1件も無いときは空状態だけ出す
  if (!agg.weeks.length && !agg.unmapped.length) {
    pane.innerHTML = `<div class="card empty-card">トレーニング記録がまだありません。<br>
      トレ画面から記録すると、週ごとの部位別ボリュームがここに表示されます。</div>`;
    return;
  }

  const metric = state.volMetric;
  const weeks = M.lastWeeks(agg.weeks, state.volRange, M.mondayOf(todayStr()));
  const cur = weeks[weeks.length - 1];
  const prev = weeks[weeks.length - 2] || { byMuscle: {} };
  const sumOf = (w, k) => M.MUSCLES.reduce((a, m) => a + M.valueOf(w, m.id, k), 0);
  const inBand = M.MUSCLES.filter(m => {
    const v = M.valueOf(prev, m.id, 'sets');
    return v >= refBand.min && v <= refBand.max;
  }).length;

  pane.innerHTML = `
    ${agg.unmapped.length ? warnCard(agg.unmapped) : ''}

    <div class="card">
      <div class="seg">
        ${[['sets', '週間セット数'], ['tonnage', 'トン数']].map(([v, l]) =>
          `<button class="seg-btn${metric === v ? ' on' : ''}" data-metric="${v}">${l}</button>`).join('')}
      </div>
      <div class="seg seg-sm vol-range">
        ${RANGES.map(([v, l]) =>
          `<button class="seg-btn${state.volRange === v ? ' on' : ''}" data-range="${v}">${l}</button>`).join('')}
      </div>
    </div>

    <div class="stat-grid">
      <div class="card stat"><div class="stat-label">今週のセット数 <span class="mut">進行中</span></div>
        <div class="stat-val">${fmt(sumOf(cur, 'sets'), 1)}<span> set</span></div></div>
      <div class="card stat"><div class="stat-label">先週のセット数</div>
        <div class="stat-val">${fmt(sumOf(prev, 'sets'), 1)}<span> set</span></div></div>
      <div class="card stat"><div class="stat-label">今週のトン数</div>
        <div class="stat-val">${fmt(sumOf(cur, 'tonnage') / 1000, 1)}<span> t</span></div></div>
      <div class="card stat"><div class="stat-label">先週 目安レンジ内</div>
        <div class="stat-val">${inBand}<span> / 10 部位</span></div></div>
    </div>

    <div class="card">
      <div class="card-head"><span>週別の部位別ボリューム</span><b class="mut">${metric === 'sets' ? 'セット' : 'kg'}</b></div>
      <div id="vol-bar"></div>
      <div class="vol-legend">
        ${M.MUSCLES.map(m => `<button class="vol-chip${state.volHidden.has(m.id) ? ' off' : ''}" data-leg="${m.id}">
          <i style="background:${M.muscleColor(m.id)}"></i>${esc(m.name)}</button>`).join('')}
      </div>
      <div class="hint">棒をタップすると、その週・その部位の内訳（セット数・トン数・種目）が出ます。凡例タップで表示/非表示を切り替えられます。</div>
    </div>

    <div class="card">
      <div class="card-head"><span>部位別トレンド</span></div>
      <label>部位<select id="vol-trend-sel">
        ${M.MUSCLES.map(m => `<option value="${m.id}"${state.volTrend === m.id ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}
      </select></label>
      <div id="vol-trend"></div>
      <div class="hint">${metric === 'sets'
        ? `網掛け＝週間 ${refBand.min}〜${refBand.max} セットの目安レンジ（下の「目安レンジ」で変更できます）。`
        : 'トン数表示では目安レンジの網掛けは出ません。'}<br>破線＝4週移動平均（直近4週をならした線）。</div>
    </div>

    <div id="vol-balance"></div>

    <div class="sec-title">目安レンジ</div>
    <div class="card">
      <div class="form-row2">
        <label>下限 <span class="unit">セット/週</span><input id="vol-band-min" type="number" inputmode="numeric" value="${refBand.min}"></label>
        <label>上限 <span class="unit">セット/週</span><input id="vol-band-max" type="number" inputmode="numeric" value="${refBand.max}"></label>
      </div>
      <button class="btn" id="vol-band-save">保存する</button>
      <div class="hint">筋肥大の一般的な目安は週10〜20セットとされています。自分の基準に合わせて変更できます。</div>
    </div>

    <div class="sec-title">部位マッピング</div>
    <div class="card">
      <div class="card-head"><span>記録にある種目</span><b>${usedNames(workouts).length} 件</b></div>
      <div id="vol-map-list"></div>
      <div class="hint">主働筋＝1.0／協働筋＝0.5。この係数はセット数だけに掛かり、トン数は主働筋に全量計上します（二重に数えないため）。<br>
        自重種目は「体重×自重係数＋記録した重量」でトン数を計算します。</div>
    </div>`;

  drawBar(pane, weeks, metric);
  drawTrend(pane, weeks, metric, refBand);
  drawBalance(pane, weeks, metric);
  drawMapList(pane, workouts, custMap, custBw, exercises);

  // ---- 操作 ----
  pane.querySelectorAll('[data-metric]').forEach(b => b.onclick = () => { state.volMetric = b.dataset.metric; refresh(); });
  pane.querySelectorAll('[data-range]').forEach(b => b.onclick = () => { state.volRange = +b.dataset.range; refresh(); });
  pane.querySelectorAll('[data-leg]').forEach(b => b.onclick = () => {
    const id = b.dataset.leg;
    state.volHidden.has(id) ? state.volHidden.delete(id) : state.volHidden.add(id);
    refresh();
  });
  pane.querySelector('#vol-trend-sel').onchange = (e) => { state.volTrend = e.target.value; refresh(); };
  pane.querySelector('#vol-band-save').onclick = async () => {
    const min = +pane.querySelector('#vol-band-min').value;
    const max = +pane.querySelector('#vol-band-max').value;
    if (!(min > 0) || !(max > min)) { toast('下限は1以上、上限は下限より大きい値にしてください'); return; }
    await db.setSetting('volRefBand', { min, max });
    toast('目安レンジを保存しました');
    refresh();
  };
  pane.querySelectorAll('[data-fix]').forEach(b => b.onclick = () =>
    openMapSheet(b.dataset.fix, custMap, custBw, exercises));
}

// ---- 未マッピングの警告カード ----
function warnCard(names) {
  return `<div class="card vol-warn">
    <div class="card-head"><span>⚠️ 部位が未設定の種目があります</span></div>
    <div class="hint">これらの記録は集計に含まれていません。タップして部位を設定すると反映されます。</div>
    ${names.map(n => `<button class="manage-row vol-fix-row" data-fix="${esc(n)}">
      <span>${esc(n)}</span><span class="chev">›</span></button>`).join('')}
  </div>`;
}

// ---- 3-1 積み上げ棒グラフ ----
function drawBar(pane, weeks, metric) {
  const vis = M.MUSCLES.filter(m => !state.volHidden.has(m.id));
  const bars = weeks.map(w => ({
    label: wkLabel(w.week),
    week: w,
    segs: vis.map(m => ({ key: m.id, v: M.valueOf(w, m.id, metric), color: M.muscleColor(m.id) })),
  }));
  stackedBarChart(pane.querySelector('#vol-bar'), bars, {
    tip: (seg, bar) => {
      const cell = bar.week.byMuscle[seg.key];
      if (!cell) return '';
      const exs = Object.entries(cell.exercises).sort((a, b) => b[1] - a[1]);
      return `${esc(bar.label)}の週　<b>${esc(M.MUSCLE_BY_ID[seg.key].name)}</b><br>
        <b>${fmt(cell.sets, 1)}</b> セット ／ <b>${fmt(Math.round(cell.tonnage))}</b> kg<br>
        <span class="mut">${exs.slice(0, 3).map(([n, v]) => `${esc(n)} ${fmt(v, 1)}`).join('・')}${exs.length > 3 ? ` 他${exs.length - 3}` : ''}</span>`;
    },
  });
}

// ---- 3-2 部位別トレンド ----
function drawTrend(pane, weeks, metric, refBand) {
  const id = state.volTrend;
  const vals = weeks.map(w => M.valueOf(w, id, metric));
  const ma = M.movingAverage(vals, 4);
  trendChart(pane.querySelector('#vol-trend'), weeks.map((w, i) => ({ label: wkLabel(w.week), v: vals[i] })), {
    color: M.muscleColor(id),
    ma,
    band: metric === 'sets'
      ? { min: refBand.min, max: refBand.max, label: `目安 ${refBand.min}〜${refBand.max}セット` }
      : null,
    tip: (i) => `${wkLabel(weeks[i].week)}の週　<b>${fmt(vals[i], 1)}</b>${metric === 'sets' ? 'セット' : 'kg'}<br>
      <span class="mut">4週平均 ${fmt(ma[i], 1)}</span>`,
  });
}

// ---- 3-3 週のバランス（横棒・上下比・前週比） ----
function drawBalance(pane, weeks, metric) {
  // 直近週はたいてい進行中なので、既定は「先週（確定）」を見せる
  const off = state.volBalWeek === 'cur' ? 0 : 1;
  const cur = weeks[weeks.length - 1 - off] || { week: '', byMuscle: {} };
  const prev = weeks[weeks.length - 2 - off] || { byMuscle: {} };
  const inProgress = cur.week === M.mondayOf(todayStr());
  const unit = metric === 'sets' ? '' : ' kg';
  const dg = metric === 'sets' ? 1 : 0;

  const rows = M.MUSCLES
    .map(m => ({ m, v: M.valueOf(cur, m.id, metric), p: M.valueOf(prev, m.id, metric) }))
    .filter(r => r.v > 0 || r.p > 0)
    .sort((a, b) => b.v - a.v);
  const max = Math.max(1, ...rows.map(r => r.v));
  const g = M.groupTotals(cur, metric);

  pane.querySelector('#vol-balance').innerHTML = `
    <div class="card">
      <div class="card-head"><span>週のバランス${cur.week ? `（${wkLabel(cur.week)}〜）` : ''}</span>
        ${inProgress ? '<b><span class="vol-badge">進行中</span></b>' : ''}</div>
      <div class="seg seg-sm vol-balseg">
        ${[['prev', '先週（確定）'], ['cur', '今週']].map(([v, l]) =>
          `<button class="seg-btn${state.volBalWeek === v ? ' on' : ''}" data-bal="${v}">${l}</button>`).join('')}
      </div>
      ${rows.map(r => {
        const d = Math.round((r.v - r.p) * 10) / 10;
        return `<div class="vol-bal-row">
          <span class="vol-bal-name">${esc(r.m.name)}</span>
          <span class="vol-bal-bar"><span class="vol-bal-fill" style="width:${r.v / max * 100}%;background:${M.muscleColor(r.m.id)}"></span></span>
          <span class="vol-bal-val"><b>${fmt(r.v, dg)}</b>${unit}
            <i class="${d > 0 ? 'up' : d < 0 ? 'down' : 'mut'}">${d === 0 ? '±0' : (d > 0 ? '＋' : '') + fmt(d, 1)}</i></span>
        </div>`;
      }).join('') || '<div class="chart-empty">この週の記録はありません</div>'}
      <div class="vol-ratio">
        <div><div class="vr-l">上半身</div><div class="vr-v">${fmt(g.upper, dg)}</div></div>
        <div><div class="vr-l">下半身</div><div class="vr-v">${fmt(g.lower, dg)}</div></div>
        <div><div class="vr-l">上：下</div><div class="vr-v">${g.lower > 0 ? fmt(g.upper / g.lower, 2) : '—'}</div></div>
      </div>
      <div class="hint">上半身＝胸・背中・肩・上腕二頭・上腕三頭／下半身＝大腿四頭・ハムストリング・臀部・下腿。
        体幹（${fmt(g.core, dg)}）はどちらでもないため比率の対象外です。<br>
        ±は前週との差です。${inProgress ? '今週はまだ途中のため、前週比はマイナスに出ます。' : ''}</div>
    </div>`;

  pane.querySelectorAll('[data-bal]').forEach(b => b.onclick = () => { state.volBalWeek = b.dataset.bal; refresh(); });
}

// ---- 記録に出てくる種目の一覧（タップでマッピング編集） ----
function usedNames(workouts) {
  return [...new Set(workouts.map(w => w.name))].sort((a, b) => a.localeCompare(b, 'ja'));
}

function drawMapList(pane, workouts, custMap, custBw, exercises) {
  const host = pane.querySelector('#vol-map-list');
  host.innerHTML = usedNames(workouts).map(n => {
    const m = M.mapFor(n, custMap);
    const f = M.bwFactorFor(n, custBw);
    const tags = m
      ? Object.entries(m).sort((a, b) => b[1] - a[1]).map(([id, c]) =>
        `<span class="vol-tag${c < 1 ? ' sub' : ''}" style="background:${M.muscleColor(id)}">${esc(M.MUSCLE_BY_ID[id]?.name || id)} ${c.toFixed(1)}</span>`).join('')
      : '<span class="vol-tag none">未設定</span>';
    return `<button class="vol-map-row" data-map="${esc(n)}">
      <span class="vol-map-name">${esc(n)}${f ? `<i class="mut"> 自重×${f}</i>` : ''}</span>
      <span class="vol-map-tags">${tags}</span>
      <span class="chev">›</span></button>`;
  }).join('') || '<div class="empty-line">記録がありません</div>';

  host.querySelectorAll('[data-map]').forEach(b => b.onclick = () =>
    openMapSheet(b.dataset.map, custMap, custBw, exercises));
}

// ============================================================
// 部位マッピングの編集シート
// 主働筋（1.0）と協働筋（0.5）をタップで選び、settings の volMap に保存する。
// 既存の workouts / exercises には一切書き込まない。
// ============================================================
function openMapSheet(name, custMap, custBw, exercises) {
  const cur = M.mapFor(name, custMap) || {};
  // 既存の種目マスタの部位（胸・背中など）から初期値のあたりを付ける
  const ex = exercises.find(x => x.name === name);
  const hint = M.PART_HINT[ex?.part];
  const sel = new Map(Object.entries(cur).map(([id, c]) => [id, c]));
  if (!sel.size && hint) sel.set(hint, 1);
  let bwF = M.bwFactorFor(name, custBw);

  const chips = () => M.MUSCLES.map(m => {
    const c = sel.get(m.id);
    return `<button class="vol-pick${c === 1 ? ' main' : c === .5 ? ' sub' : ''}" data-pick="${m.id}"
      style="--pick:${M.muscleColor(m.id)}">${esc(m.name)}${c ? `<i>${c.toFixed(1)}</i>` : ''}</button>`;
  }).join('');

  const body = openSheet(`${name} の部位`, `
    <div class="hint">部位をタップするたびに <b>主働1.0 → 協働0.5 → 選択なし</b> と切り替わります。</div>
    <div class="vol-picks" id="vol-picks">${chips()}</div>
    <label>自重係数 <span class="unit">0＝自重ぶんを数えない</span>
      <input id="vol-bw" type="number" inputmode="decimal" step="0.05" min="0" max="1.5" value="${bwF || ''}" placeholder="0">
    </label>
    <div class="hint">懸垂・ディップスなど体を持ち上げる種目に使います。トン数を
      「体重×この係数 ＋ 記録した重量」×回数 で計算します（例: 懸垂=1、腕立て伏せ=0.65）。</div>
    <button class="btn btn-big" id="vol-map-save">保存する</button>
    <button class="btn-ghost" id="vol-map-reset">既定の設定に戻す</button>`);

  const picks = body.querySelector('#vol-picks');
  picks.onclick = (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    const id = b.dataset.pick;
    const c = sel.get(id);
    if (c === 1) sel.set(id, .5);
    else if (c === .5) sel.delete(id);
    else sel.set(id, 1);
    picks.innerHTML = chips();
  };

  body.querySelector('#vol-map-save').onclick = async () => {
    if (!sel.size) { toast('部位を1つ以上選んでください'); return; }
    if (![...sel.values()].includes(1)) { toast('主働筋（1.0）を1つ以上選んでください'); return; }
    bwF = +body.querySelector('#vol-bw').value || 0;
    const map = await db.getSetting('volMap', {});
    const bw = await db.getSetting('volBw', {});
    map[name] = Object.fromEntries(sel);
    if (bwF > 0) bw[name] = bwF; else delete bw[name];
    await db.setSetting('volMap', map);
    await db.setSetting('volBw', bw);
    closeSheet();
    toast(`「${name}」の部位を設定しました`);
    refresh();
  };

  body.querySelector('#vol-map-reset').onclick = async () => {
    const map = await db.getSetting('volMap', {});
    const bw = await db.getSetting('volBw', {});
    delete map[name];
    delete bw[name];
    await db.setSetting('volMap', map);
    await db.setSetting('volBw', bw);
    closeSheet();
    toast(M.EX_MAP[name] ? '既定の設定に戻しました' : '設定を削除しました（未設定に戻ります）');
    refresh();
  };
}
