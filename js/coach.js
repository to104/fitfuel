// ============================================================
// coach.js — AIパーソナルトレーナー（ルールベースのメニュー生成エンジン）
// 過去のトレ記録から「今日やるべき日タイプ・種目・重量・セット」を組み立てる。
// APIキー不要・オフライン動作。Claude API連携（方式B）はPhase2でここに追加する。
// ============================================================
import * as db from './db.js';
import { todayStr, addDays } from './ui.js';

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

// ---- 今日のメニューの保存・読み出し（settingsストアに保存＝同期・バックアップ対象） ----
export async function getMenu() {
  const m = await db.getSetting('coachMenu', null);
  if (!m || m.date !== todayStr()) return null;   // 日付が変わった古いメニューは無視
  // 設定→トレーニング種目との連動:
  // メニューは種目名・部位のコピーを持つため、設定側の改名・部位変更を毎回反映し、
  // 削除された種目は今日のメニューからも外す（記録済みのworkoutsには影響しない）
  const byId = new Map((await db.all('exercises')).map(x => [x.id, x]));
  let changed = false;
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
  if (changed) await saveMenu(m);
  return m;
}
export async function saveMenu(menu) { await db.setSetting('coachMenu', menu); }
export async function clearMenu() { await db.setSetting('coachMenu', null); }

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
// 直近の記録日を分割タイプに分類し、その次のタイプを返す
// ============================================================
export async function suggestDay() {
  const today = todayStr();
  const cutoff = addDays(today, -21);
  const [workouts, exercises] = await Promise.all([db.all('workouts'), db.all('exercises')]);
  const partOf = partMap(exercises);

  // 日付ごとに「どのタイプの日だったか」をメイン部位のセット数で採点して分類
  const byDate = {};
  for (const w of workouts) {
    if (w.date < cutoff || w.date >= today) continue;
    (byDate[w.date] ??= []).push(w);
  }
  const dates = Object.keys(byDate).sort();
  let lastKey = null, lastDate = null;
  for (const d of dates) {
    let best = null, bestScore = 0;
    for (const t of DAY_TYPES) {
      const score = byDate[d].reduce((s, w) =>
        s + (t.mains.includes(partOf(w)) ? (w.sets?.length || 0) : 0), 0);
      if (score > bestScore) { bestScore = score; best = t.key; }
    }
    if (best) { lastKey = best; lastDate = d; }
  }
  if (!lastKey) return { key: 'push', reason: '直近3週間に記録がないため、最初のプッシュから始めます。' };
  const i = DAY_TYPES.findIndex(t => t.key === lastKey);
  const next = DAY_TYPES[(i + 1) % DAY_TYPES.length];
  const lastLabel = DAY_TYPES[i].label;
  const gap = daysBetween(lastDate, todayStr());
  return { key: next.key, reason: `前回（${lastDate.slice(5).replace('-', '/')}）が${lastLabel}だったので、次は${next.label}です。${gap >= 4 ? `中${gap - 1}日空いています。` : ''}` };
}

// ============================================================
// 1種目分の提案を作る（漸進性過負荷＝少しずつ負荷を上げる原則）
//  ・前回全セット8回以上こなせていたら +2.5kg に挑戦
//  ・6回未満のセットがあれば重量据え置き
//  ・自重種目は回数+1
//  ・light=true（回復が浅い部位）はセットを減らして重量も据え置き
// ============================================================
export function proposeFor(ex, history, { light = false } = {}) {
  const today = todayStr();
  const prev = history
    .filter(w => w.date < today && w.sets?.length)
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
export async function generateMenu({ dayKey, time }) {
  const today = todayStr();
  const cutoff = addDays(today, -60);
  const [workouts, exercises, split, carry] = await Promise.all([
    db.all('workouts'), db.all('exercises'), getSplit(), db.getSetting('coachCarry', []),
  ]);
  const partOf = partMap(exercises);
  const day = DAY_TYPES.find(t => t.key === dayKey) || DAY_TYPES[0];
  const extras = (split.extras[day.key] || []).filter(p => !day.mains.includes(p));

  // ---- 部位ごとの回復状態（中1日以下なら軽め扱い） ----
  const lastPart = lastByPart(workouts, partOf, today);
  const isLight = (p) => lastPart[p] != null && daysBetween(lastPart[p], today) <= 2;

  // ---- 種目ランキング（直近60日の使用回数→最終実施日の順。持ち越し種目は最優先） ----
  const usage = new Map(), lastUse = new Map();
  for (const w of workouts) {
    if (w.date >= cutoff && w.date < today) usage.set(w.exerciseId, (usage.get(w.exerciseId) || 0) + 1);
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
    const prop = proposeFor(ex, histByEx.get(ex.id) || [], { light: isLight(part) });
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
  const lines = [];
  lines.push(`今日は${day.label}の日${extras.length ? `＋${extras.join('・')}` : ''}です。`);
  const up = list.find(it => it.badge === 'up');
  if (up) lines.push(`${up.name}は${up.note.replace('・', '。')}。`);
  const lightParts = [...new Set(list.filter(it => it.badge === 'light').map(it => it.part))];
  if (lightParts.length) lines.push(`${lightParts.join('・')}は前回から日が浅いため軽めにしています。`);
  if (dropped.length) lines.push(`${time}分に収めるため「${dropped.join('・')}」は次回に回しました。`);
  if (carry.length && list.some(it => carry.includes(it.name))) lines.push('前回時間切れだった種目を優先して入れています。');

  const menu = {
    date: today, dayKey: day.key, time,
    comment: lines.join(''),
    items: [...warmups, ...list],
    dropped,
  };
  await saveMenu(menu);
  return menu;
}
