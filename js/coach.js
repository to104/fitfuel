// ============================================================
// coach.js — AIパーソナルトレーナー（ルールベースのメニュー生成エンジン）
// 過去のトレ記録から「今日やるべき日タイプ・種目・重量・セット」を組み立てる。
// APIキー不要・オフライン動作。Claude API連携（方式B）はPhase2でここに追加する。
// ============================================================
import * as db from './db.js';
import { todayStr, addDays, dateLabel } from './ui.js';

// ---- 分割パターン（プッシュ・プル・レッグ） ----
// mains: その日のメイン部位（固定）／extras: ユーザーが設定で足す追い込み部位
export const DAY_TYPES = [
  { key: 'push', label: 'プッシュ', mains: ['胸', '肩'] },
  { key: 'pull', label: 'プル',     mains: ['背中', '腕'] },
  { key: 'legs', label: 'レッグ',   mains: ['脚'] },
];
export const EXTRA_PARTS = ['胸', '背中', '脚', '肩', '腕', '腹', 'その他'];
export const TIME_CHOICES = [30, 45, 60, 90];

const DEFAULT_SPLIT = { extras: { push: [], pull: [], legs: [] }, baseTime: 60 };

export async function getSplit() {
  const s = await db.getSetting('coachSplit', {});
  return { ...DEFAULT_SPLIT, ...s, extras: { ...DEFAULT_SPLIT.extras, ...(s.extras || {}) } };
}
export async function setSplit(patch) {
  await db.setSetting('coachSplit', { ...(await getSplit()), ...patch });
}

// ---- メニューの保存・読み出し（settingsストアに保存＝同期・バックアップ対象） ----
// 保存形式は「日付ごとの一覧」 { '2026-07-16': {date,dayKey,items,...}, ... }
// ＝明日以降のぶんも前もって作成・保持できる。過ぎた日付は読み書き時に自動削除。
// v1.17以前は今日の1件だけを直接保存していたため、旧形式（.itemsを持つ）は読み替える
async function loadMenus() {
  const m = await db.getSetting('coachMenu', null);
  if (!m) return {};
  if (Array.isArray(m.items)) return m.date ? { [m.date]: m } : {};   // 旧形式
  return m;
}
// 昨日以前のメニューを取り除く（戻り値: 取り除いたかどうか）
function pruneOld(menus) {
  const t = todayStr();
  let changed = false;
  for (const d of Object.keys(menus)) {
    if (d < t) { delete menus[d]; changed = true; }
  }
  return changed;
}

export async function getMenu(date = todayStr()) {
  const menus = await loadMenus();
  let changed = pruneOld(menus);
  const m = menus[date] || null;
  if (m) {
    // 設定→トレーニング種目との連動:
    // メニューは種目名・部位のコピーを持つため、設定側の改名・部位変更を毎回反映し、
    // 削除された種目はメニューからも外す（記録済みのworkoutsには影響しない）
    const byId = new Map((await db.all('exercises')).map(x => [x.id, x]));
    m.items = m.items.filter(it => {
      if (it.kind !== 'ex') return true;
      const ex = byId.get(it.exId);
      if (!ex) { changed = true; return false; }
      if (ex.name !== it.name || (ex.part || 'その他') !== it.part) {
        it.name = ex.name;
        it.part = ex.part || 'その他';
        changed = true;
      }
      return true;
    });
  }
  if (changed) await db.setSetting('coachMenu', menus);
  return m;
}
export async function saveMenu(menu) {
  const menus = await loadMenus();
  pruneOld(menus);
  menus[menu.date] = menu;
  await db.setSetting('coachMenu', menus);
}
export async function clearMenu(date = todayStr()) {
  const menus = await loadMenus();
  pruneOld(menus);
  delete menus[date];
  await db.setSetting('coachMenu', menus);
}

// ============================================================
// 記録の集計ヘルパー
// ============================================================

// 種目ID→部位の対応表を作る（記録側は名前しか持たない古いデータにも対応）
function partMap(exercises) {
  const byId = new Map(exercises.map(x => [x.id, x.part || 'その他']));
  const byName = new Map(exercises.map(x => [x.name, x.part || 'その他']));
  return (w) => byId.get(w.exerciseId) || byName.get(w.name) || 'その他';
}

// 部位ごとの「最後にやった日」を返す（回復管理用）
function lastByPart(workouts, partOf, before) {
  const last = {};
  for (const w of workouts) {
    if (w.date >= before) continue;
    const p = partOf(w);
    if (!last[p] || w.date > last[p]) last[p] = w.date;
  }
  return last;
}

// 日付文字列同士の差（日数）
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
}

// 2.5kg刻みに丸める（プレート単位）
const r25 = (w) => Math.round(w / 2.5) * 2.5;

// ============================================================
// 次にやるべき日タイプの提案（ローテーション判定）
// 対象日より前の記録日を分割タイプに分類し、その次のタイプを返す。
// 明日以降の分を前もって作るときは、まだ記録のない「作成済みメニュー（予定）」も
// ローテーションに数える（例: 今日プッシュ予定→明日はプルを提案）
// ============================================================
export async function suggestDay(date = todayStr()) {
  const cutoff = addDays(date, -21);
  const [workouts, exercises] = await Promise.all([db.all('workouts'), db.all('exercises')]);
  const partOf = partMap(exercises);

  // 日付ごとに「どのタイプの日だったか」をメイン部位のセット数で採点して分類
  const byDate = {};
  for (const w of workouts) {
    if (w.date < cutoff || w.date >= date) continue;
    (byDate[w.date] ??= []).push(w);
  }
  const dates = Object.keys(byDate).sort();
  let lastKey = null, lastDate = null, lastIsPlan = false;
  for (const d of dates) {
    let best = null, bestScore = 0;
    for (const t of DAY_TYPES) {
      const score = byDate[d].reduce((s, w) =>
        s + (t.mains.includes(partOf(w)) ? (w.sets?.length || 0) : 0), 0);
      if (score > bestScore) { bestScore = score; best = t.key; }
    }
    if (best) { lastKey = best; lastDate = d; }
  }
  // 記録より新しい「作成済みメニュー（予定）」があればそちらを直近扱いにする
  const menus = await loadMenus();
  let planned = null;
  for (const d of Object.keys(menus)) {
    if (d >= date || d < cutoff || (lastDate && d <= lastDate)) continue;
    if (!planned || d > planned) planned = d;
  }
  if (planned && menus[planned].dayKey) {
    lastKey = menus[planned].dayKey; lastDate = planned; lastIsPlan = true;
  }

  if (!lastKey) return { key: 'push', reason: '直近3週間に記録がないため、最初のプッシュから始めます。' };
  const i = Math.max(0, DAY_TYPES.findIndex(t => t.key === lastKey));
  const next = DAY_TYPES[(i + 1) % DAY_TYPES.length];
  const lastLabel = DAY_TYPES[i].label;
  const gap = daysBetween(lastDate, date);
  return { key: next.key, reason: `前回${lastIsPlan ? 'の予定' : ''}（${lastDate.slice(5).replace('-', '/')}）が${lastLabel}${lastIsPlan ? 'なので' : 'だったので'}、次は${next.label}です。${gap >= 4 ? `中${gap - 1}日空いています。` : ''}` };
}

// ============================================================
// 1種目分の提案を作る（漸進性過負荷＝少しずつ負荷を上げる原則）
//  ・前回全セット8回以上こなせていたら +2.5kg に挑戦
//  ・6回未満のセットがあれば重量据え置き
//  ・自重種目は回数+1
//  ・light=true（回復が浅い部位）はセットを減らして重量も据え置き
// ============================================================
export function proposeFor(ex, history, { light = false, date = todayStr() } = {}) {
  const prev = history
    .filter(w => w.date < date && w.sets?.length)
    .sort((a, b) => b.date.localeCompare(a.date) || (b.ts || 0) - (a.ts || 0))[0];

  if (!prev) {
    return {
      sets: [{ weight: 0, reps: 10, rpe: null }, { weight: 0, reps: 10, rpe: null }, { weight: 0, reps: 10, rpe: null }],
      badge: 'new', note: '初挑戦・重量は自分で調整',
    };
  }

  let sets = prev.sets.map(s => ({ weight: s.weight || 0, reps: s.reps || 10, rpe: null }));
  if (sets.length > 5) sets = sets.slice(0, 5);
  const minReps = Math.min(...sets.map(s => s.reps));
  const topW = Math.max(...sets.map(s => s.weight));
  const prevLabel = `前回 ${topW > 0 ? `${topW}kg` : '自重'}×${prev.sets.map(s => s.reps).join('/')}`;

  if (light) {
    sets = sets.slice(0, 2);
    return { sets, badge: 'light', note: `${prevLabel}・回復優先で軽め`, prevDate: prev.date };
  }
  if (topW === 0) {
    sets = sets.map(s => ({ ...s, reps: s.reps + 1 }));
    return { sets, badge: 'up', note: `${prevLabel} → 回数+1に挑戦`, prevDate: prev.date };
  }
  if (minReps >= 8) {
    // ダンベル等の中途半端な重量を壊さないよう、丸めずに+2.5だけ足す
    sets = sets.map(s => ({ ...s, weight: Math.round((s.weight + 2.5) * 10) / 10 }));
    return { sets, badge: 'up', note: `${prevLabel} → +2.5kgに挑戦`, prevDate: prev.date };
  }
  if (minReps < 6) {
    return { sets, badge: 'keep', note: `${prevLabel}・前回苦戦のため据え置き`, prevDate: prev.date };
  }
  return { sets, badge: 'keep', note: `${prevLabel}・同重量で回数を伸ばす`, prevDate: prev.date };
}

// 休憩時間の目安（高重量ほど長く）
export function restFor(sets, isExtra) {
  if (isExtra) return 90;
  const topW = Math.max(0, ...sets.map(s => s.weight || 0));
  return topW >= 60 ? 180 : topW >= 30 ? 150 : 120;
}

// 種目の所要時間（分）＝セット数×（実施45秒＋休憩）＋準備1分
function exMinutes(it) {
  return it.sets.length * (0.75 + it.rest / 60) + 1;
}
export function estimateMinutes(items) {
  let m = 0;
  for (const it of items) m += it.kind === 'warmup' ? (it.min || 4) : exMinutes(it);
  return Math.round(m);
}

// ============================================================
// メニュー生成本体
// ============================================================
export async function generateMenu({ dayKey, time, date = todayStr() }) {
  const cutoff = addDays(date, -60);
  const [workouts, exercises, split, carry] = await Promise.all([
    db.all('workouts'), db.all('exercises'), getSplit(), db.getSetting('coachCarry', []),
  ]);
  const partOf = partMap(exercises);
  const day = DAY_TYPES.find(t => t.key === dayKey) || DAY_TYPES[0];
  const extras = (split.extras[day.key] || []).filter(p => !day.mains.includes(p));

  // ---- 部位ごとの回復状態（対象日の時点で中1日以下なら軽め扱い） ----
  const lastPart = lastByPart(workouts, partOf, date);
  const isLight = (p) => lastPart[p] != null && daysBetween(lastPart[p], date) <= 2;

  // ---- 種目ランキング（直近60日の使用回数→最終実施日の順。持ち越し種目は最優先） ----
  const usage = new Map(), lastUse = new Map();
  for (const w of workouts) {
    if (w.date >= cutoff && w.date < date) usage.set(w.exerciseId, (usage.get(w.exerciseId) || 0) + 1);
    if (!lastUse.has(w.exerciseId) || w.date > lastUse.get(w.exerciseId)) lastUse.set(w.exerciseId, w.date);
  }
  const histByEx = new Map();
  for (const w of workouts) {
    if (!histByEx.has(w.exerciseId)) histByEx.set(w.exerciseId, []);
    histByEx.get(w.exerciseId).push(w);
  }

  const poolFor = (part) => exercises
    .filter(x => (x.part || 'その他') === part)
    .sort((a, b) =>
      (carry.includes(b.name) - carry.includes(a.name)) ||
      ((usage.get(b.id) || 0) - (usage.get(a.id) || 0)) ||
      String(lastUse.get(b.id) || '').localeCompare(String(lastUse.get(a.id) || '')) ||
      a.id - b.id);

  // ---- メイン部位に3〜4種目を配分（先頭の部位から順番に1つずつ） ----
  const totalMain = time >= 75 ? 4 : 3;
  const picked = [];
  const used = new Set();
  const pools = day.mains.map(p => ({ part: p, pool: poolFor(p), i: 0 }));
  for (let n = 0; n < totalMain; n++) {
    const slot = pools[n % pools.length];
    while (slot.i < slot.pool.length && used.has(slot.pool[slot.i].id)) slot.i++;
    if (slot.i < slot.pool.length) {
      const ex = slot.pool[slot.i++];
      used.add(ex.id);
      picked.push({ ex, part: slot.part, extra: false });
    }
  }
  // ---- 追い込み部位は各1種目 ----
  for (const p of extras) {
    const ex = poolFor(p).find(x => !used.has(x.id));
    if (ex) { used.add(ex.id); picked.push({ ex, part: p, extra: true }); }
  }

  // ---- 種目ごとの提案（重量・回数・休憩） ----
  let uid = 1;
  const items = [];
  for (const { ex, part, extra } of picked) {
    const prop = proposeFor(ex, histByEx.get(ex.id) || [], { light: isLight(part), date });
    items.push({
      uid: uid++, kind: 'ex', exId: ex.id, name: ex.name, part, extra,
      sets: prop.sets, rest: restFor(prop.sets, extra),
      badge: prop.badge, note: prop.note,
    });
  }

  // ---- ウォームアップ（最初のメイン種目の重量から段階的に逆算） ----
  const first = items.find(it => !it.extra);
  const firstW = first ? Math.max(0, ...first.sets.map(s => s.weight || 0)) : 0;
  const warmups = [{ uid: uid++, kind: 'warmup', name: '動的ストレッチ・関節回し', detail: '2〜3分', min: 3, done: false }];
  if (firstW >= 40) {
    const ramp = [[0.45, 8], [0.65, 5], [0.85, 2]]
      .map(([r, reps]) => ({ w: r25(firstW * r), reps }))
      .filter((s, i, arr) => s.w > 20 && s.w < firstW && (i === 0 || s.w > arr[i - 1].w));
    warmups.push({
      uid: uid++, kind: 'warmup', name: `${first.name} アップセット`,
      detail: ['バー×10', ...ramp.map(s => `${s.w}kg×${s.reps}`)].join(' → '), min: 5, done: false,
    });
  }

  // ---- 時間内に収める（①追い込みを外す→②休憩短縮→③補助のセット減） ----
  const dropped = [];
  let list = [...items];
  const total = () => estimateMinutes([...warmups, ...list]);
  let guard = 40;
  while (total() > time && guard-- > 0) {
    const lastExtra = [...list].reverse().find(it => it.extra);
    if (lastExtra) { list = list.filter(it => it !== lastExtra); dropped.push(lastExtra.name); continue; }
    const longRest = [...list].reverse().find(it => it.rest > 90);
    if (longRest) { longRest.rest -= 30; continue; }
    const fat = [...list].reverse().find(it => it.sets.length > 2);
    if (fat) { fat.sets = fat.sets.slice(0, 2); continue; }
    const lastMain = list[list.length - 1];
    if (lastMain) { list = list.filter(it => it !== lastMain); dropped.push(lastMain.name); continue; }
    break;
  }
  // 時間に余裕があれば最初のメイン種目のセットを増やす
  if (time - total() >= 12 && list[0] && list[0].sets.length < 5 && list[0].badge !== 'light') {
    list[0].sets = [...list[0].sets, { ...list[0].sets[list[0].sets.length - 1] }];
    list[0].note += '・余裕があるので1セット追加';
  }

  // ---- 持ち越しリストの更新（時間切れで外れた種目を次回優先） ----
  await db.setSetting('coachCarry', dropped);

  // ---- AIコメント ----
  const dayWord = date === todayStr() ? '今日' : dateLabel(date);
  const lines = [];
  lines.push(`${dayWord}は${day.label}の日${extras.length ? `＋${extras.join('・')}` : ''}です。`);
  const up = list.find(it => it.badge === 'up');
  if (up) lines.push(`${up.name}は${up.note.replace('・', '。')}。`);
  const lightParts = [...new Set(list.filter(it => it.badge === 'light').map(it => it.part))];
  if (lightParts.length) lines.push(`${lightParts.join('・')}は前回から日が浅いため軽めにしています。`);
  if (dropped.length) lines.push(`${time}分に収めるため「${dropped.join('・')}」は次回に回しました。`);
  if (carry.length && list.some(it => carry.includes(it.name))) lines.push('前回時間切れだった種目を優先して入れています。');

  const menu = {
    date, dayKey: day.key, time,
    comment: lines.join(''),
    items: [...warmups, ...list],
    dropped,
  };
  await saveMenu(menu);
  return menu;
}

// ============================================================
// AI連携用の分析データを組み立てる（Claude API連携・Phase2）
// baseContext(): プロフィール・体重・栄養・直近3週間の記録（コメント/チャット共通）
// buildAiContext(): 上記＋メニュー案＋依頼文（コーチコメント用）
// buildChatContext(): 上記＋今日のメニュー概要（チャット用）
// ============================================================
async function baseContext(date) {
  const [profile, targets, weights, workouts, exercises] = await Promise.all([
    db.getSetting('profile', {}),
    db.getSetting('targets', {}),
    db.all('weights'),
    db.all('workouts'),
    db.all('exercises'),
  ]);
  const partOf = partMap(exercises);
  const L = [];

  // プロフィール・目標
  const GOAL_LABEL = { cut: '減量', keep: '維持', bulk: '増量' };
  L.push(`# ユーザー`);
  L.push(`${profile.age ?? '?'}歳${profile.sex === 'f' ? '女性' : '男性'} / 身長${profile.height ?? '?'}cm / 目的: ${GOAL_LABEL[profile.goal] || profile.goal || '維持'}`);

  // 体重の推移（直近と約2週間前の比較）
  const ws = weights.filter(w => w.weight != null).sort((a, b) => a.date.localeCompare(b.date));
  if (ws.length) {
    const now = ws[ws.length - 1];
    const past = [...ws].reverse().find(w => daysBetween(w.date, now.date) >= 10);
    L.push(`体重: ${now.weight}kg（${now.date}）${past ? ` / ${past.date}時点 ${past.weight}kg（${(Math.round((now.weight - past.weight) * 10) / 10) >= 0 ? '+' : ''}${Math.round((now.weight - past.weight) * 10) / 10}kg）` : ''}`);
  }

  // 栄養（昨日の実績と今日ここまで）
  const sumRows = (rows) => rows.reduce((t, r) => ({
    kcal: t.kcal + (r.kcal || 0), p: t.p + (r.p || 0), f: t.f + (r.f || 0), c: t.c + (r.c || 0),
  }), { kcal: 0, p: 0, f: 0, c: 0 });
  const fmtPfc = (t) => `${Math.round(t.kcal)}kcal P${Math.round(t.p)} F${Math.round(t.f)} C${Math.round(t.c)}`;
  const [yRows, tRows] = await Promise.all([
    db.byDate('meals', addDays(date, -1)),
    db.byDate('meals', date),
  ]);
  L.push(`# 栄養`);
  L.push(`目標: ${targets.kcal ?? '?'}kcal P${targets.p ?? '?'} F${targets.f ?? '?'} C${targets.c ?? '?'}`);
  L.push(`昨日の実績: ${yRows.length ? fmtPfc(sumRows(yRows)) : '記録なし'}`);
  L.push(`今日ここまで: ${tRows.length ? fmtPfc(sumRows(tRows)) : '記録なし'}`);

  // 直近21日のトレ記録（日付ごとに種目とトップセット）
  const cutoff = addDays(date, -21);
  const recent = workouts.filter(w => w.date >= cutoff && w.date < date && w.sets?.length);
  const byDate = {};
  for (const w of recent) (byDate[w.date] ??= []).push(w);
  L.push(`# 直近3週間のトレ記録`);
  const dates = Object.keys(byDate).sort();
  if (!dates.length) L.push('記録なし');
  for (const d of dates.slice(-12)) {
    const items = byDate[d].map(w => {
      const top = w.sets.reduce((a, s) => (s.weight || 0) >= (a.weight || 0) ? s : a, w.sets[0]);
      return `${w.name}(${partOf(w)}) ${top.weight > 0 ? `${top.weight}kg` : '自重'}×${top.reps}×${w.sets.length}set${w.pr ? '★PR' : ''}`;
    });
    L.push(`${d}: ${items.join(', ')}`);
  }
  return L;
}

const setsLabelText = (sets) => sets.map(s => `${s.weight > 0 ? `${s.weight}kg` : '自重'}×${s.reps}`).join('/');

// コーチコメント用（メニュー案＋依頼文つき）
export async function buildAiContext(menu) {
  const day = DAY_TYPES.find(t => t.key === menu.dayKey) || DAY_TYPES[0];
  const L = await baseContext(menu.date);
  L.push(`# ${menu.date}のメニュー案（${day.label}の日・${menu.time}分）`);
  for (const it of menu.items) {
    if (it.kind === 'warmup') { L.push(`- ウォームアップ: ${it.name}`); continue; }
    L.push(`- ${it.name}（${it.part}）: ${setsLabelText(it.sets)} ${it.note ? `/ ${it.note}` : ''}`);
  }
  L.push(`# 依頼`);
  L.push(`このメニューに取り組むユーザーへのコーチコメントをください。`);
  return L.join('\n');
}

// AIチャット用（今日のメニューがあれば概要を添える）
export async function buildChatContext() {
  const today = todayStr();
  const L = [`今日の日付: ${today}`, ...(await baseContext(today))];
  const menu = await getMenu(today);
  if (menu) {
    const day = DAY_TYPES.find(t => t.key === menu.dayKey) || DAY_TYPES[0];
    L.push(`# 今日のメニュー（AIトレーナー提案・${day.label}の日・${menu.time}分）`);
    for (const it of menu.items) {
      if (it.kind === 'warmup') continue;
      L.push(`- ${it.name}（${it.part}）: ${setsLabelText(it.sets)}`);
    }
  } else {
    L.push(`# 今日のメニュー`);
    L.push(`未作成（トレ画面のAIトレーナーから作成できる）`);
  }
  return L.join('\n');
}
