// ============================================================
// calc.js — 栄養計算ロジック
// 基礎代謝(BMR)・消費カロリー(TDEE)・目標PFCの計算と、
// ルールベースの栄養アドバイス（AI版はPhase2で置き換え予定）。
// ============================================================

// 活動量の選択肢（係数はTDEE計算で使う標準値）
export const ACTIVITY = [
  { v: 1.2,   label: 'ほぼ座り仕事・運動なし' },
  { v: 1.375, label: '軽い運動（週1〜2回）' },
  { v: 1.55,  label: '中程度の運動（週3〜5回）' },
  { v: 1.725, label: '激しい運動（週6〜7回）' },
  { v: 1.9,   label: '肉体労働＋ハードなトレーニング' },
];

export const GOALS = [
  { v: 'bulk', label: '増量', diff: +300, pPerKg: 2.0 },
  { v: 'keep', label: '維持', diff: 0,    pPerKg: 1.8 },
  { v: 'cut',  label: '減量', diff: -400, pPerKg: 2.2 },
];

// 基礎代謝（Mifflin-St Jeor式＝現在最も標準的な推定式）
export function bmr(p) {
  const base = 10 * p.weight + 6.25 * p.height - 5 * p.age;
  return Math.round(base + (p.sex === 'f' ? -161 : 5));
}

// 1日の総消費カロリー（TDEE）＝基礎代謝×活動係数
export function tdee(p) {
  return Math.round(bmr(p) * (p.activity || 1.55));
}

// プロフィールから推奨カロリー・PFC・水分目標を計算する
export function recommend(p) {
  const goal = GOALS.find(g => g.v === p.goal) || GOALS[1];
  const kcal = Math.max(1200, tdee(p) + goal.diff);
  const prot = Math.round(p.weight * goal.pPerKg);          // タンパク質: 体重×係数
  const fat = Math.round(kcal * 0.25 / 9);                  // 脂質: 総カロリーの25%
  const carb = Math.max(0, Math.round((kcal - prot * 4 - fat * 9) / 4)); // 残りが炭水化物
  const water = Math.round(p.weight * 35 / 100) * 100;      // 水分: 体重×35ml
  return { kcal, p: prot, f: fat, c: carb, water };
}

// ============================================================
// 栄養アドバイス（ルールベース）
// totals: 今日の摂取合計 / targets: 目標 / opts: {trained, waterMl, hour, goal}
// 戻り値: [{icon, text}] の配列
// ============================================================
export function advice(totals, targets, opts = {}) {
  const out = [];
  const remP = Math.round(targets.p - totals.p);
  const remK = Math.round(targets.kcal - totals.kcal);
  const remC = Math.round(targets.c - totals.c);
  const hour = opts.hour ?? new Date().getHours();

  // タンパク質チェック（最優先）
  if (remP >= 20) {
    const chicken = Math.round(remP / 0.233 / 10) * 10;   // 鶏むね肉(皮なし)換算
    const shakes = Math.ceil(remP / 22);                   // プロテイン1杯≒22g換算
    let text = `タンパク質があと ${remP}g 不足しています。`;
    if (remP <= 30) text += `プロテイン${shakes}杯、またはギリシャヨーグルト＋卵で補えます。`;
    else text += `鶏むね肉 約${chicken}g、またはプロテイン${shakes}杯が目安です。`;
    out.push({ icon: 'P', text });
  } else if (remP <= -30) {
    out.push({ icon: 'P', text: `タンパク質は目標を ${-remP}g 超えています。十分足りているので他の栄養素を優先しましょう。` });
  } else if (totals.p > 0) {
    out.push({ icon: 'P', text: 'タンパク質は順調です。この調子で続けましょう。' });
  }

  // 脂質チェック
  if (totals.f > targets.f * 1.15) {
    out.push({ icon: 'F', text: `脂質が多めです（目標＋${totals.f - targets.f}g）。揚げ物・脂身は控えめに。` });
  }

  // カロリー・炭水化物チェック（目的別）
  if (remK < -100) {
    out.push({ icon: 'K', text: opts.goal === 'bulk'
      ? `目標カロリーを ${-remK}kcal 超えています。増量中でも脂肪がつきすぎないよう±300kcal以内が理想です。`
      : `目標カロリーを ${-remK}kcal オーバーしています。明日は少し調整しましょう。` });
  } else if (hour >= 18 && remK > 600) {
    out.push({ icon: 'K', text: `残り ${remK}kcal 摂取できます。夕食でしっかり食べましょう。` });
  }

  // トレーニング日の炭水化物
  if (opts.trained && remC > 50) {
    out.push({ icon: 'C', text: `今日はトレーニング日です。回復のため炭水化物をあと ${remC}g（ご飯 約${Math.round(remC / 0.371 / 50) * 50}g）摂るのがおすすめです。` });
  }

  // 水分
  if (opts.waterMl != null && targets.water && hour >= 12 && opts.waterMl < targets.water * 0.4) {
    out.push({ icon: 'W', text: `水分が不足気味です（${opts.waterMl}ml / 目標${targets.water}ml）。こまめに飲みましょう。` });
  }

  // ビタミン・ミネラル: 最も不足している1項目を参考食品つきで提案
  // （何か食べた後なら時間帯を問わず表示。件数制限で消えないよう2番目に挿入）
  if (opts.micros && opts.microTargets && totals.kcal > 0) {
    let worst = -1, worstRatio = 1;
    opts.micros.forEach((v, i) => {
      const t = opts.microTargets[i];
      const ratio = t ? v / t : 1;
      if (ratio < worstRatio) { worstRatio = ratio; worst = i; }
    });
    if (worst >= 0 && worstRatio < 0.6) {
      const m = MICROS[worst];
      out.splice(Math.min(1, out.length), 0,
        { icon: 'V', text: `${m.label}が不足気味です（目標の${Math.round(worstRatio * 100)}%）。${m.foods}などで補えます。` });
    }
  }

  if (!out.length) {
    out.push({ icon: 'OK', text: '今日の栄養バランスは良好です。' });
  }
  return out.slice(0, 4); // 多すぎると読まれないので4件まで
}

// 体重の週平均を計算する（月曜始まり・直近weeks週分）
export function weeklyAverages(rows, weeks = 4) {
  // rows: [{date:'YYYY-MM-DD', weight}] 昇順でなくてもよい
  const byWeek = new Map();
  for (const r of rows) {
    if (r.weight == null) continue;
    const d = new Date(r.date + 'T00:00:00');
    const day = (d.getDay() + 6) % 7;            // 月曜=0
    d.setDate(d.getDate() - day);                // その週の月曜日に揃える
    const key = d.toISOString().slice(0, 10);
    if (!byWeek.has(key)) byWeek.set(key, []);
    byWeek.get(key).push(r.weight);
  }
  return [...byWeek.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, weeks)
    .map(([monday, arr]) => ({
      monday,
      avg: Math.round(arr.reduce((s, v) => s + v, 0) / arr.length * 100) / 100,
      count: arr.length,
    }));
}

// 推定1RM（Epley式: 重量×(1＋回数÷30)）— 自己ベスト判定に使う
export function e1rm(weight, reps) {
  if (!weight || !reps) return 0;
  return weight * (1 + reps / 30);
}

// ============================================================
// ビタミン・ミネラルの目標値
// 厚生労働省「日本人の食事摂取基準」の推奨量（RDA＝ほとんどの人が
// 必要量を満たす摂取量）・目安量をもとにした成人向けの簡易テーブル。
// 並び順はfoods.jsのv配列と同じ:
// [ビタミンD(µg), B1(mg), B2(mg), B6(mg), C(mg), Ca(mg), Mg(mg), 鉄(mg), 亜鉛(mg)]
// ============================================================
export const MICROS = [
  { k: 'vd', label: 'ビタミンD', unit: 'µg', foods: '鮭・さば缶・卵・まいたけ' },
  { k: 'b1', label: 'ビタミンB1', unit: 'mg', foods: '豚ヒレ肉・玄米・納豆' },
  { k: 'b2', label: 'ビタミンB2', unit: 'mg', foods: '卵・納豆・さば・牛乳' },
  { k: 'b6', label: 'ビタミンB6', unit: 'mg', foods: '鶏むね肉・まぐろ・かつお・バナナ' },
  { k: 'vc', label: 'ビタミンC', unit: 'mg', foods: 'ピーマン・ブロッコリー・キウイ・いちご' },
  { k: 'ca', label: 'カルシウム', unit: 'mg', foods: '牛乳・チーズ・さば缶・小松菜' },
  { k: 'mg', label: 'マグネシウム', unit: 'mg', foods: '納豆・アーモンド・オートミール・豆腐' },
  { k: 'fe', label: '鉄', unit: 'mg', foods: '牛もも肉・小松菜・納豆・厚揚げ' },
  { k: 'zn', label: '亜鉛', unit: 'mg', foods: '牛肉・豚肉・チーズ・アーモンド' },
];

// 性別×年齢区分（18-29 / 30-49 / 50-64 / 65+）の目標値テーブル
const MICRO_TARGETS = {
  m: {
    18: [8.5, 1.4, 1.6, 1.4, 100, 800, 340, 7.5, 11],
    30: [8.5, 1.4, 1.6, 1.4, 100, 750, 370, 7.5, 11],
    50: [8.5, 1.3, 1.5, 1.4, 100, 750, 370, 7.5, 11],
    65: [8.5, 1.3, 1.5, 1.4, 100, 750, 350, 7.5, 11],
  },
  f: {
    18: [8.5, 1.1, 1.2, 1.1, 100, 650, 270, 10.5, 8],
    30: [8.5, 1.1, 1.2, 1.1, 100, 650, 290, 10.5, 8],
    50: [8.5, 1.1, 1.2, 1.1, 100, 650, 290, 6.5, 8],  // 鉄は月経なし想定
    65: [8.5, 1.1, 1.2, 1.1, 100, 650, 280, 6.0, 8],
  },
};

// プロフィール（sex/age）からその人の目標値配列を返す
export function microTargets(p = {}) {
  const sex = p.sex === 'f' ? 'f' : 'm';
  const age = p.age || 40;
  const bracket = age < 30 ? 18 : age < 50 ? 30 : age < 65 ? 50 : 65;
  return MICRO_TARGETS[sex][bracket];
}

// ============================================================
// トレーニング消費カロリー推定（METs法）
// METs（メッツ＝安静時の何倍のエネルギーを使うかを表す運動強度の単位）
// を使い、消費kcal ≒ METs × 体重(kg) × 時間(h) で概算する。
// 所要時間は記録していないため「1セット≒3分（休憩込み）」で推定し、
// 強度はRPE（主観的運動強度・10が限界）から換算する。
// 参考: 身体活動のメッツ表でウエイトトレーニングは軽め3.5〜高強度6.0
// ============================================================
const MIN_PER_SET = 3; // 1セットあたりの所要時間の目安（実施＋休憩・分）

// RPE→METs換算（RPE5以下=3.5、RPE10=6.0を直線補間。RPE未入力は中間の5.0）
function metFromRpe(rpe) {
  if (rpe == null) return 5.0;
  const t = Math.min(1, Math.max(0, (rpe - 5) / 5));
  return 3.5 + t * 2.5;
}

// 1種目分の消費カロリー推定（wはworkoutsの1レコード、bodyWeightはkg）
export function workoutKcal(w, bodyWeight) {
  if (!bodyWeight || !w?.sets?.length) return 0;
  const rpes = w.sets.map(s => s.rpe).filter(v => v != null && v > 0);
  const avgRpe = rpes.length ? rpes.reduce((s, v) => s + v, 0) / rpes.length : null;
  const hours = w.sets.length * MIN_PER_SET / 60;
  return metFromRpe(avgRpe) * bodyWeight * hours;
}

// 1日分（複数種目）の合計消費カロリー
export function workoutsKcal(list, bodyWeight) {
  return Math.round(list.reduce((s, w) => s + workoutKcal(w, bodyWeight), 0));
}
