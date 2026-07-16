// ============================================================
// fitfuel AI中継 Worker（Cloudflare Workers に貼り付けて使う）
// アプリ（GitHub Pages）→ このWorker → Claude API の中継役。
// APIキーは Worker の Secret（環境変数 ANTHROPIC_API_KEY）にだけ置き、
// 公開リポジトリのアプリ側には一切持たせない。
// デプロイ手順: リポジトリの docs/AI連携セットアップ.md を参照
// ※Cloudflareダッシュボードに直接貼り付ける前提のため、SDKを使わず
//   素のfetchでClaude API（Messages API）を呼んでいる
// ============================================================

// 呼び出しを許可するアプリのオリジン（ドメイン）。これ以外からのブラウザ呼び出しは拒否
const ALLOWED_ORIGINS = [
  'https://to104.github.io',
];

// ローカル開発（PCでの動作確認）用に localhost / 127.0.0.1 は全ポート許可
function originAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL_PHOTO = 'claude-haiku-4-5';    // 写真解析: 速くて安い（定型JSON返しで十分）
const MODEL_TRAINER = 'claude-sonnet-5';   // トレーナー: 推論の質が体感に直結

// ---- 写真解析の出力形式（structured outputs = 必ずこの形のJSONで返させる） ----
const PHOTO_SCHEMA = {
  type: 'object',
  properties: {
    dishes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name:     { type: 'string', description: '料理名（日本語・簡潔に）' },
          amount_g: { type: 'number', description: '推定分量（グラム）' },
          kcal:     { type: 'number', description: '推定カロリー（kcal）' },
          p:        { type: 'number', description: 'タンパク質（g）' },
          f:        { type: 'number', description: '脂質（g）' },
          c:        { type: 'number', description: '炭水化物（g）' },
          salt:     { type: 'number', description: '食塩相当量（g）' },
        },
        required: ['name', 'amount_g', 'kcal', 'p', 'f', 'c', 'salt'],
        additionalProperties: false,
      },
    },
    note: { type: 'string', description: '推定の前提や注意点をひとこと（日本語）' },
  },
  required: ['dishes', 'note'],
  additionalProperties: false,
};

const PHOTO_SYSTEM = `あなたは日本の管理栄養士です。食事の写真を分析し、写っている料理を1品ずつ特定して栄養価を推定します。
- 日本食品標準成分表（八訂）相当の一般的な値を基準にする
- 分量は器のサイズや盛り付けから現実的に推定する
- 判別できない料理は最も可能性の高い解釈で推定し、noteでその旨に触れる
- 飲み物や小鉢も見落とさない
- ユーザーから補足があればそれを優先する`;

const TRAINER_SYSTEM = `あなたは筋力トレーニングのパーソナルトレーナーです。ユーザーの記録データと今日のメニュー案を分析し、コーチコメントを日本語で返します。
- 3〜6文・250文字以内。親しみやすく、でも具体的に
- 前回の重量・回数、部位のローテーション、栄養（PFC）の達成状況など、データ内の具体的な数値に必ず1つ以上言及する
- 重量アップに挑戦する種目があれば背中を押す。回復が浅い部位には無理をさせない
- 栄養面で今日意識すべきこと（タンパク質不足など）があれば1文添える
- 医学的な診断や治療の助言はしない
- 出力はコメント本文のみ。前置き・見出し・箇条書きは不要`;

// ---- CORSヘッダー（プリフライト＝ブラウザの事前確認にも応答する） ----
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) },
  });
}

// ---- Claude API（Messages API）を呼ぶ共通処理 ----
async function callClaude(env, body) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    // 原因を日本語にして返す（アプリ側でそのままトースト表示できる）
    const type = data?.error?.type || '';
    const msg =
      type === 'authentication_error' ? 'APIキーが正しくありません（WorkerのSecretを確認）' :
      type === 'rate_limit_error'     ? 'アクセスが集中しています。少し待って再試行してください' :
      type === 'overloaded_error'     ? 'Claude側が混雑しています。少し待って再試行してください' :
      data?.error?.message || `Claude APIエラー（${res.status}）`;
    throw new Error(msg);
  }
  if (data.stop_reason === 'refusal') throw new Error('AIが回答を控えました。別の写真・内容でお試しください');
  if (data.stop_reason === 'max_tokens') throw new Error('AIの回答が長すぎて途切れました。再試行してください');
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  if (!text) throw new Error('AIから空の応答が返りました。再試行してください');
  return text;
}

// ---- 写真解析（Haiku 4.5 / vision + structured outputs） ----
async function handlePhoto(env, body) {
  const { image, media_type, hint } = body || {};
  if (!image || !media_type) throw new Error('画像データがありません');
  if (image.length > 3_000_000) throw new Error('画像が大きすぎます（アプリ側で縮小されるはずです）');

  const userText = '写真の食事を分析してください。' + (hint ? `\n補足: ${String(hint).slice(0, 300)}` : '');
  const text = await callClaude(env, {
    model: MODEL_PHOTO,
    max_tokens: 1500,
    system: PHOTO_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: PHOTO_SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type, data: image } },
        { type: 'text', text: userText },
      ],
    }],
  });
  return JSON.parse(text);   // structured outputsによりPHOTO_SCHEMA準拠のJSONが保証される
}

// ---- トレーナーコメント（Sonnet 5） ----
async function handleTrainer(env, body) {
  const summary = String(body?.summary || '').slice(0, 20_000);
  if (!summary) throw new Error('分析用データがありません');
  const comment = await callClaude(env, {
    model: MODEL_TRAINER,
    max_tokens: 3000,                        // 思考（adaptive thinking）ぶんの余裕を含む
    output_config: { effort: 'medium' },     // コスト（月額試算）と質のバランス
    system: TRAINER_SYSTEM,
    messages: [{ role: 'user', content: summary }],
  });
  return { comment: comment.trim() };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    // ブラウザの事前確認（プリフライト）
    if (request.method === 'OPTIONS') {
      if (!originAllowed(origin)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // 接続テスト用（アプリの設定画面「接続テスト」が叩く）
    if (request.method === 'GET') {
      return json({ ok: true, service: 'fitfuel-ai' }, 200, originAllowed(origin) ? origin : '*');
    }

    if (request.method !== 'POST') return json({ error: 'POSTのみ対応' }, 405, origin);
    if (!originAllowed(origin)) return json({ error: '許可されていないオリジンです' }, 403, origin);
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'WorkerにANTHROPIC_API_KEYが設定されていません' }, 500, origin);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'JSONを解釈できません' }, 400, origin); }

    try {
      if (url.pathname === '/photo') return json(await handlePhoto(env, body), 200, origin);
      if (url.pathname === '/trainer') return json(await handleTrainer(env, body), 200, origin);
      return json({ error: '不明なエンドポイントです' }, 404, origin);
    } catch (err) {
      return json({ error: err.message || String(err) }, 502, origin);
    }
  },
};
