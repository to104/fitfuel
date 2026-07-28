// ============================================================
// muscles.js — 部位別ボリュームの定義と集計
// ・10部位の定義と、種目→部位のマッピング（主働1.0／協働0.5）
// ・自重種目の実効負荷（体重に掛ける係数）
// ・週×部位の集計（すべて純関数＝DBも画面も触らない）
//
// ※既存の exercises.part（胸/背中/脚/肩/腕/腹/その他）は変更しない。
//   AIトレーナーの分割ロジックがそれを使っているため、別レイヤーとして上乗せする。
// ============================================================

// ---- 10部位の定義 ----
// group: 上半身/下半身の比率計算に使う（core はどちらにも入れない）
export const MUSCLES = [
  { id: 'chest',      name: '胸',            group: 'upper' },
  { id: 'back',       name: '背中',          group: 'upper' },
  { id: 'shoulders',  name: '肩',            group: 'upper' },
  { id: 'biceps',     name: '上腕二頭',      group: 'upper' },
  { id: 'triceps',    name: '上腕三頭',      group: 'upper' },
  { id: 'quads',      name: '大腿四頭',      group: 'lower' },
  { id: 'hamstrings', name: 'ハムストリング', group: 'lower' },
  { id: 'glutes',     name: '臀部',          group: 'lower' },
  { id: 'calves',     name: '下腿',          group: 'lower' },
  { id: 'core',       name: '体幹',          group: 'core'  },
];
export const MUSCLE_BY_ID = Object.fromEntries(MUSCLES.map(m => [m.id, m]));
// グラフ・凡例の色（CSS変数 --m-xxx はstyle.cssで定義。ライト/ダーク両対応）
export const muscleColor = (id) => `var(--m-${id})`;

// ---- 既存の7部位 → 10部位の対応（マッピング編集シートの初期値にだけ使う） ----
// 「腕」は二頭/三頭を判別できないため、あえて空にして必ずユーザーに選ばせる
export const PART_HINT = {
  '胸': 'chest', '背中': 'back', '肩': 'shoulders', '腹': 'core', '脚': 'quads',
};

// ============================================================
// 種目 → 部位のマッピング（1.0=主働筋 / 0.5=協働筋）
// ここが唯一の定義元。ユーザーが追加・変更した分は settings の volMap で上書きされる。
// ============================================================
export const EX_MAP = {
  // ---- 胸 ----
  'ベンチプレス':               { chest: 1, triceps: .5, shoulders: .5 },
  'インクラインベンチプレス':   { chest: 1, shoulders: .5, triceps: .5 },
  'デクラインベンチプレス':     { chest: 1, triceps: .5 },
  'ナローベンチプレス':         { triceps: 1, chest: .5, shoulders: .5 },
  'ダンベルプレス':             { chest: 1, triceps: .5, shoulders: .5 },
  'インクラインダンベルプレス': { chest: 1, shoulders: .5, triceps: .5 },
  'ダンベルフライ':             { chest: 1 },
  'ペックフライ':               { chest: 1 },
  'チェストプレス':             { chest: 1, triceps: .5, shoulders: .5 },
  'ケーブルクロスオーバー':     { chest: 1 },
  'ディップス':                 { chest: 1, triceps: 1, shoulders: .5 },
  '腕立て伏せ':                 { chest: 1, triceps: .5, shoulders: .5 },

  // ---- 背中 ----
  'デッドリフト':               { back: 1, glutes: 1, hamstrings: 1, quads: .5 },
  'ルーマニアンデッドリフト':   { hamstrings: 1, glutes: 1, back: .5 },
  'スティフレッグデッドリフト': { hamstrings: 1, glutes: 1, back: .5 },
  'ラットプルダウン':           { back: 1, biceps: .5 },
  '懸垂':                       { back: 1, biceps: .5 },
  'チンニング':                 { back: 1, biceps: .5 },
  'ベントオーバーロウ':         { back: 1, biceps: .5 },
  'ダンベルロウ':               { back: 1, biceps: .5 },
  'シーテッドロウ':             { back: 1, biceps: .5 },
  'Tバーロウ':                  { back: 1, biceps: .5 },
  'プルオーバー':               { back: 1, chest: .5 },
  'バックエクステンション':     { back: 1, glutes: .5, hamstrings: .5 },
  'シュラッグ':                 { back: 1, shoulders: .5 },

  // ---- 肩 ----
  'ショルダープレス':           { shoulders: 1, triceps: .5 },
  'ダンベルショルダープレス':   { shoulders: 1, triceps: .5 },
  'サイドレイズ':               { shoulders: 1 },
  'フロントレイズ':             { shoulders: 1 },
  'リアレイズ':                 { shoulders: 1, back: .5 },
  'アップライトロウ':           { shoulders: 1, back: .5 },
  'フェイスプル':               { shoulders: 1, back: .5 },

  // ---- 上腕二頭 ----
  'アームカール':               { biceps: 1 },
  'ダンベルカール':             { biceps: 1 },
  'バーベルカール':             { biceps: 1 },
  'ハンマーカール':             { biceps: 1 },
  'インクラインカール':         { biceps: 1 },
  'プリーチャーカール':         { biceps: 1 },
  'コンセントレーションカール': { biceps: 1 },

  // ---- 上腕三頭 ----
  'ケーブルプレスダウン':       { triceps: 1 },
  'プレスダウン':               { triceps: 1 },
  'トライセプスエクステンション': { triceps: 1 },
  'フレンチプレス':             { triceps: 1 },
  'キックバック':               { triceps: 1 },

  // ---- 大腿四頭 ----
  'スクワット':                 { quads: 1, glutes: .5, hamstrings: .5 },
  'フロントスクワット':         { quads: 1, glutes: .5, core: .5 },
  'ハックスクワット':           { quads: 1, glutes: .5 },
  'レッグプレス':               { quads: 1, glutes: .5, hamstrings: .5 },
  'レッグエクステンション':     { quads: 1 },
  'ブルガリアンスクワット':     { quads: 1, glutes: 1, hamstrings: .5 },
  'ランジ':                     { quads: 1, glutes: 1, hamstrings: .5 },
  'シシースクワット':           { quads: 1 },

  // ---- ハムストリング ----
  'レッグカール':               { hamstrings: 1 },
  'シーテッドレッグカール':     { hamstrings: 1 },
  'グッドモーニング':           { hamstrings: 1, glutes: .5, back: .5 },

  // ---- 臀部 ----
  'ヒップスラスト':             { glutes: 1, hamstrings: .5 },
  'ヒップアブダクション':       { glutes: 1 },
  'ヒップキックバック':         { glutes: 1, hamstrings: .5 },

  // ---- 下腿 ----
  'カーフレイズ':               { calves: 1 },
  'シーテッドカーフレイズ':     { calves: 1 },

  // ---- 体幹 ----
  'アブローラー':               { core: 1 },
  'クランチ':                   { core: 1 },
  'シットアップ':               { core: 1 },
  'レッグレイズ':               { core: 1 },
  'ハンギングレッグレイズ':     { core: 1 },
  'ケーブルクランチ':           { core: 1 },
  'ロシアンツイスト':           { core: 1 },
  'プランク':                   { core: 1 },
};

// ============================================================
// 自重種目の実効負荷係数
// トン数＝（体重×係数 ＋ 記録した重量）×回数 で計上する。
// 体全体を持ち上げない種目まで体重100%で数えると過大になるための補正。
//   1.0  … 体を丸ごと持ち上げる
//   0.65 … 腕立て伏せ（手にかかる荷重は体重の約64〜75%とされる。その下限側を採用）
//   0.45 … 上体〜体幹のみを起こす
//   0.35 … 上体または下肢のみを動かす
//   （プランクは静止保持で「回数」の意味が他種目と違うため係数を持たせない）
// ============================================================
export const BW_FACTOR = {
  '懸垂': 1, 'チンニング': 1, 'ディップス': 1, 'シシースクワット': 1,
  '腕立て伏せ': 0.65,
  'バックエクステンション': 0.45, 'アブローラー': 0.45,
  'クランチ': 0.35, 'シットアップ': 0.35, 'レッグレイズ': 0.35,
  'ハンギングレッグレイズ': 0.35, 'ロシアンツイスト': 0.35,
};

// ---- 集計の定数 ----
// ウォームアップ判定: その日・その種目の最大実効重量の70%未満のセットは除外する
export const WARMUP_RATIO = 0.7;
// 参照帯（週間セット数の目安レンジ）。設定で変更でき、既定値がこれ
export const DEFAULT_REF_BAND = { min: 10, max: 20 };

// ============================================================
// 名前の照合
// 前後の空白と中黒・記号のゆれを吸収する（「ベンチプレス 」「ベンチ・プレス」も同じ扱い）
// ============================================================
export function normalizeName(s) {
  return String(s ?? '').trim().replace(/[\s・･,，]/g, '');
}

// 既定マッピングを正規化した名前でも引けるようにした索引
const NORM_INDEX = (() => {
  const m = new Map();
  for (const k of Object.keys(EX_MAP)) m.set(normalizeName(k), k);
  return m;
})();

// 種目名に対する部位マッピングを返す（custom＝ユーザーが保存した上書き分）
export function mapFor(name, custom = {}) {
  if (custom[name]) return custom[name];
  if (EX_MAP[name]) return EX_MAP[name];
  const n = normalizeName(name);
  for (const k of Object.keys(custom)) if (normalizeName(k) === n) return custom[k];
  const hit = NORM_INDEX.get(n);
  return hit ? EX_MAP[hit] : null;
}

// 自重係数を返す（該当しなければ0＝記録した重量だけで計算する）
export function bwFactorFor(name, custom = {}) {
  if (custom[name] != null) return custom[name];
  const n = normalizeName(name);
  for (const k of Object.keys(BW_FACTOR)) if (normalizeName(k) === n) return BW_FACTOR[k];
  return 0;
}

// ============================================================
// 日付ユーティリティ（週は月曜始まり）
// ============================================================
export function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return ymd(d);
}
export function addWeeks(monday, n) {
  const d = new Date(monday + 'T00:00:00');
  d.setDate(d.getDate() + n * 7);
  return ymd(d);
}
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ============================================================
// 集計（純関数）
// workouts: [{date, name, sets:[{weight,reps}]}]
// opts: {
//   map        … ユーザーが保存した上書きマッピング {種目名:{部位:係数}}
//   bw         … ユーザーが保存した自重係数の上書き {種目名:係数}
//   weights    … 体重の記録 [{date, weight}]（自重種目のトン数に使う）
//   fallbackWeight … 体重の記録が無いときに使う値（プロフィールの体重）
//   warmupRatio … ウォームアップ除外の閾値
// }
// 戻り値: {
//   weeks:    [{ week:'YYYY-MM-DD'(月曜), byMuscle:{ 部位id:{sets,tonnage,exercises:{種目名:セット数}} } }]
//   unmapped: [部位が未設定の種目名]
// }
// ============================================================
export function aggregateVolume(workouts, opts = {}) {
  const {
    map = {}, bw = {}, weights = [], fallbackWeight = 0, warmupRatio = WARMUP_RATIO,
  } = opts;

  // その日以前で最も新しい体重を引くための表（日付降順）
  const wSorted = weights.filter(w => w && w.weight != null)
    .slice().sort((a, b) => b.date.localeCompare(a.date));
  const bodyWeightAt = (date) => {
    const hit = wSorted.find(w => w.date <= date);
    return hit ? hit.weight : fallbackWeight;
  };

  // 1セットの実効重量（自重種目は体重×係数を足す）
  const effWeight = (s, factor, bwKg) => (s.weight || 0) + factor * bwKg;

  // 同じ日・同じ種目の最大実効重量（ウォームアップ判定の基準）
  const dayMax = new Map();
  for (const w of workouts) {
    if (!w?.sets?.length) continue;
    const f = bwFactorFor(w.name, bw);
    const kg = f ? bodyWeightAt(w.date) : 0;
    const key = `${w.date}|${w.name}`;
    const top = Math.max(...w.sets.map(s => effWeight(s, f, kg)));
    dayMax.set(key, Math.max(dayMax.get(key) || 0, top));
  }

  const weeks = new Map();
  const unmapped = new Map();   // 種目名 → 記録件数

  for (const w of workouts) {
    if (!w?.sets?.length) continue;
    const m = mapFor(w.name, map);
    if (!m) { unmapped.set(w.name, (unmapped.get(w.name) || 0) + 1); continue; }

    const f = bwFactorFor(w.name, bw);
    const kg = f ? bodyWeightAt(w.date) : 0;
    const top = dayMax.get(`${w.date}|${w.name}`) || 0;

    // ウォームアップ除外。実効重量が全部0の種目（プランク等）は全セットを本番扱い
    const work = w.sets.filter(s =>
      (s.reps || 0) > 0 && (top > 0 ? effWeight(s, f, kg) >= top * warmupRatio : true));
    if (!work.length) continue;

    const tonnage = work.reduce((a, s) => a + effWeight(s, f, kg) * (s.reps || 0), 0);
    const wk = mondayOf(w.date);
    if (!weeks.has(wk)) weeks.set(wk, { week: wk, byMuscle: {} });
    const byMuscle = weeks.get(wk).byMuscle;

    for (const [id, coef] of Object.entries(m)) {
      if (!MUSCLE_BY_ID[id] || !coef) continue;
      const cell = (byMuscle[id] ??= { sets: 0, tonnage: 0, exercises: {} });
      cell.sets += work.length * coef;                    // 係数はセット数にだけ掛ける
      if (coef === 1) cell.tonnage += tonnage;            // トン数は主働筋に全量（二重計上を避ける）
      cell.exercises[w.name] = (cell.exercises[w.name] || 0) + work.length * coef;
    }
  }

  return {
    weeks: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)),
    unmapped: [...unmapped.keys()],
  };
}

// 直近n週ぶんを取り出す（記録のない週も0で埋める）
export function lastWeeks(weeks, n, endMonday) {
  const byKey = new Map(weeks.map(w => [w.week, w]));
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const k = addWeeks(endMonday, -i);
    out.push(byKey.get(k) || { week: k, byMuscle: {} });
  }
  return out;
}

// 1週・1部位の値を取り出す（metric: 'sets' | 'tonnage'）
export function valueOf(week, muscleId, metric) {
  return week?.byMuscle?.[muscleId]?.[metric] || 0;
}

// 移動平均（既定4週）
export function movingAverage(values, n = 4) {
  return values.map((_, i) => {
    const s = values.slice(Math.max(0, i - n + 1), i + 1);
    return s.reduce((a, b) => a + b, 0) / s.length;
  });
}

// 上半身／下半身／体幹の合計
export function groupTotals(week, metric) {
  const sum = (g) => MUSCLES.filter(m => m.group === g)
    .reduce((a, m) => a + valueOf(week, m.id, metric), 0);
  return { upper: sum('upper'), lower: sum('lower'), core: sum('core') };
}
