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
          micros:   {
            type: 'array',
            items: { type: 'number' },
            description: 'ビタミン・ミネラル10種の推定量（この品の分量全体に含まれる量）。必ず10要素、順番は [ビタミンD(µg), ビタミンB1(mg), ビタミンB2(mg), ビタミンB6(mg), ビタミンC(mg), カルシウム(mg), マグネシウム(mg), 鉄(mg), 亜鉛(mg), カリウム(mg)]。不明・微量の成分は0',
          },
        },
        required: ['name', 'amount_g', 'kcal', 'p', 'f', 'c', 'salt', 'micros'],
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
- ユーザーから補足があればそれを優先する
- 各品についてビタミン・ミネラル10種（ビタミンD・B1・B2・B6・C、カルシウム・マグネシウム・鉄・亜鉛・カリウム）も八訂ベースで概算する。パッケージの栄養成分表示に記載があればその値を優先し、判断がつかない成分は0とする`;

// ---- Web検索（web_search_20250305 = Haiku 4.5対応の基本版） ----
// コスト注意: 検索は1回あたり約1.5円（$10/1000回）がトークン代に上乗せされる。
// そのため「常時検索」はせず、①補足に商品名があるとき ②再確認ボタン のときだけ使い、
// max_usesで回数上限もかける。
function webSearchTool(maxUses) {
  return { type: 'web_search_20250305', name: 'web_search', max_uses: maxUses };
}

// 検索を使うと応答に引用（citations）が必ず付き、structured outputs（JSONスキーマ強制）と
// 併用できない。そこで検索時は「最後にJSONだけを出力させて取り出す」方式にする。
// 応答テキストの末尾側からJSON1個を切り出してパースする
function extractJson(text) {
  const end = text.lastIndexOf('}');
  if (end < 0) throw new Error('AIの応答からデータを取り出せませんでした。再試行してください');
  // 最後の '}' から対応する '{' まで遡る（値の中に波括弧が来るケースはこの用途ではほぼ無い）
  let depth = 0, start = -1;
  for (let i = end; i >= 0; i--) {
    if (text[i] === '}') depth++;
    else if (text[i] === '{') { depth--; if (depth === 0) { start = i; break; } }
  }
  try {
    if (start >= 0) return JSON.parse(text.slice(start, end + 1));
  } catch { /* 下のフォールバックへ */ }
  // 保険: 最初の '{' から最後の '}' までで再挑戦
  const first = text.indexOf('{');
  if (first >= 0 && first < end) return JSON.parse(text.slice(first, end + 1));
  throw new Error('AIの応答からデータを取り出せませんでした。再試行してください');
}

// 数値化（不正値は0）と、ビタミン・ミネラル10種配列の形をそろえる
const num = (v) => (Number.isFinite(+v) ? +v : 0);
function normMicros(m) {
  return Array.from({ length: 10 }, (_, i) => Math.max(0, num(Array.isArray(m) ? m[i] : 0)));
}
function normDish(d) {
  return {
    name: String(d?.name || ''), amount_g: num(d?.amount_g),
    kcal: num(d?.kcal), p: num(d?.p), f: num(d?.f), c: num(d?.c), salt: num(d?.salt),
    micros: normMicros(d?.micros),
  };
}

// hint（補足）に商品名があるとき用の追加ルール＋出力形式（検索パスはスキーマ強制が使えないため文章で指定）
const PHOTO_SEARCH_RULES = `
- ユーザーの補足に市販商品の商品名・ブランド名らしき語が含まれる場合のみ、web_searchでその商品の公式の栄養成分情報（メーカー公式サイト等）を確認し、見つかればその値を推定より優先する。一般的な料理名だけなら検索しない
- noteには「◯◯は公式情報を参照」または「公式情報は未確認（推定値）」のように、公式情報を参照したかどうかが分かる一言を必ず含める
- 回答の最後に、次の形式のJSONを1つだけ出力する（前置き・コードフェンス不要。JSONの後に文章を続けない）:
{"dishes":[{"name":"料理名（日本語・簡潔に）","amount_g":推定分量g,"kcal":数値,"p":タンパク質g,"f":脂質g,"c":炭水化物g,"salt":食塩相当量g,"micros":[ビタミンD(µg),B1(mg),B2(mg),B6(mg),C(mg),カルシウム(mg),マグネシウム(mg),鉄(mg),亜鉛(mg),カリウム(mg)]}],"note":"推定の前提や注意点をひとこと（日本語）"}
- microsは必ず10要素。値はその品の分量全体に含まれる量。不明・微量は0`;

// ---- 「🔍公式情報で再確認」用（/verify） ----
const VERIFY_SYSTEM = `あなたは日本の管理栄養士です。指定された食品・商品について、web_searchで公式の栄養成分情報を探して確認します。
- 「商品名 栄養成分」などで検索する（最大3回）
- 採用してよいのはメーカー公式サイト・公式オンラインショップ・公式ブランドサイトの栄養成分表示のみ。第三者のカロリー計算サイトやまとめサイトの値は「公式」とみなさず、その場合はfound:falseにする
- 一般的な手料理（例: みそ汁、野菜炒め）で特定商品が想定できない場合は検索せずfound:falseにする
- ナトリウム表記しかない場合は食塩相当量(g)＝ナトリウム(mg)×2.54÷1000で換算する
- 指定の分量(amount_g)があり換算できる場合は、その分量あたりに換算した値を返しvalues.amount_gにその分量を入れる。換算できない場合は公式表示の単位のままにしてservingに基準（例:「1食(214g)あたり」）を明記し、values.amount_gには基準のグラム数（不明なら0）を入れる
- ビタミン・ミネラル10種は公式表示に記載があるものだけ入れ、記載がないものは0にする
- 回答の最後に、次の形式のJSONを1つだけ出力する（前置き・コードフェンス不要。JSONの後に文章を続けない）:
{"found":true/false,"source":"参照した公式サイト名（未発見なら空文字）","serving":"値の基準（例: 1食(214g)あたり）","values":{"amount_g":数値,"kcal":数値,"p":数値,"f":数値,"c":数値,"salt":数値,"micros":[10要素の数値]},"note":"確認結果のひとこと（日本語）"}
- found:falseのときvaluesは省略してよい`;

// ---- AIチャット相談（/chat） ----
// 返信本文と「メモリーノートへの追記」を1回の呼び出しでまとめて返させる
// （structured outputs = 必ずこの形のJSONで返るため、アプリ側の解析が不要）
const CHAT_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'ユーザーへの返信本文（日本語）' },
    new_notes: {
      type: 'array',
      items: { type: 'string' },
      description: 'メモリーノートに新しく覚えるべき事実（なければ空配列・最大2件・各60文字以内）',
    },
  },
  required: ['reply', 'new_notes'],
  additionalProperties: false,
};

const CHAT_SYSTEM = `あなたは筋トレ・栄養管理アプリ「fitfuel」のAIトレーナーです。パーソナルトレーナー兼栄養コーチとして、ユーザーとチャットで会話します。
- 日本語で、親しみやすく簡潔に。基本は2〜5文、手順や複数項目の説明は箇条書きも可
- ユーザーのデータ（記録・目標・メモリーノート）に基づいて具体的に答える。数値に触れられるときは触れる
- 医学的な診断や治療の助言はしない。痛みやケガの相談には無理をさせず、続く場合は医療機関の受診をすすめる
- わからないことは正直にわからないと言う
- アプリの操作方法を聞かれたら、トレ画面のAIトレーナー（メニュー提案）・食事タブ（写真解析あり）・記録タブ・設定を案内できる

返信とは別に、メモリーノート（長期記憶）への追記も判断すること:
- 今後の提案にずっと影響する事実だけをnew_notesに入れる（例: ケガ・既往歴、長期目標、生活の制約、使える器具・環境、強い好みや苦手）
- すでにメモリーノートにある内容や、一時的な話題（今日の体調・今日の予定など）は入れない
- なければ空配列。1回の返信で最大2件、各60文字以内の簡潔な文にする`;

// 会話が10往復を超えたとき、古い部分を要約して圧縮するための指示（/chat-summary）
const CHAT_SUMMARY_SYSTEM = `トレーナーとユーザーのチャットの古い部分を要約します。この要約は今後の会話の文脈としてAIに渡されます。次を落とさず日本語300字以内でまとめること:
- ユーザーが相談した内容と、アドバイスの結論・要点
- 進行中の話題や次回への持ち越し事項
- 重量・回数・目標などの数値は具体的に残す
出力は要約本文のみ（前置き・見出しは不要）`;

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
// リクエスト1回ぶん。エラーは日本語にして返す（アプリ側でそのままトースト表示できる）
async function apiPost(env, body) {
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
    const type = data?.error?.type || '';
    const msg =
      type === 'authentication_error' ? 'APIキーが正しくありません（WorkerのSecretを確認）' :
      type === 'rate_limit_error'     ? 'アクセスが集中しています。少し待って再試行してください' :
      type === 'overloaded_error'     ? 'Claude側が混雑しています。少し待って再試行してください' :
      data?.error?.message || `Claude APIエラー（${res.status}）`;
    throw new Error(msg);
  }
  return data;
}

function joinText(data) {
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

function checkStop(data) {
  if (data.stop_reason === 'refusal') throw new Error('AIが回答を控えました。別の写真・内容でお試しください');
  if (data.stop_reason === 'max_tokens') throw new Error('AIの回答が長すぎて途切れました。再試行してください');
}

// 検索なしの通常呼び出し（応答テキストを返す）
async function callClaude(env, body) {
  const data = await apiPost(env, body);
  checkStop(data);
  const text = joinText(data);
  if (!text) throw new Error('AIから空の応答が返りました。再試行してください');
  return text;
}

// Web検索つき呼び出し。検索が長引くとAPIが途中停止（pause_turn）することがあるので、
// その場合は途中までの応答を付けて続きを依頼する（最大3回）
async function callClaudeSearch(env, { model, max_tokens, system, messages, maxUses }) {
  let msgs = messages;
  let data;
  for (let i = 0; i < 4; i++) {
    data = await apiPost(env, {
      model, max_tokens, system,
      tools: [webSearchTool(maxUses)],
      messages: msgs,
    });
    if (data.stop_reason !== 'pause_turn') break;
    msgs = [...msgs, { role: 'assistant', content: data.content }];
  }
  checkStop(data);
  const text = joinText(data);
  if (!text) throw new Error('AIから空の応答が返りました。再試行してください');
  return text;
}

// ---- 写真解析（Haiku 4.5 / vision + structured outputs） ----
async function handlePhoto(env, body) {
  const { image, media_type, hint } = body || {};
  if (!image || !media_type) throw new Error('画像データがありません');
  if (image.length > 3_000_000) throw new Error('画像が大きすぎます（アプリ側で縮小されるはずです）');

  const hintText = String(hint || '').slice(0, 300).trim();
  const userText = '写真の食事を分析してください。' + (hintText ? `\n補足: ${hintText}` : '');
  const content = [
    { type: 'image', source: { type: 'base64', media_type, data: image } },
    { type: 'text', text: userText },
  ];

  // 補足あり → Web検索つき（商品名なら公式の栄養成分を確認）。
  // 検索応答には引用が付きstructured outputsと併用できないため、JSONを文章で指定して取り出す。
  // 取り出しに失敗したら下の通常解析（スキーマ保証あり）にフォールバックする
  if (hintText) {
    try {
      const text = await callClaudeSearch(env, {
        model: MODEL_PHOTO,
        max_tokens: 3000,
        system: PHOTO_SYSTEM + PHOTO_SEARCH_RULES,
        messages: [{ role: 'user', content }],
        maxUses: 2,   // コスト上限: 1リクエストの検索は最大2回
      });
      const parsed = extractJson(text);
      const dishes = (Array.isArray(parsed.dishes) ? parsed.dishes : []).map(normDish).filter(d => d.name);
      if (dishes.length) return { dishes, note: String(parsed.note || '') };
    } catch (e) {
      // 検索パス失敗時は通常解析へ（原因: 検索の混雑やJSON崩れなど / 解決策: 下で推定のみ実施）
    }
  }

  const text = await callClaude(env, {
    model: MODEL_PHOTO,
    max_tokens: 1500,
    system: PHOTO_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: PHOTO_SCHEMA } },
    messages: [{ role: 'user', content }],
  });
  return JSON.parse(text);   // structured outputsによりPHOTO_SCHEMA準拠のJSONが保証される
}

// ---- 公式情報で再確認（Haiku 4.5 / Web検索） ----
// 解析結果の1品について公式の栄養成分を探し、見つかれば比較用の値を返す
async function handleVerify(env, body) {
  const name = String(body?.name || '').slice(0, 100).trim();
  if (!name) throw new Error('品名がありません');
  const amountG = Math.max(0, +body?.amount_g || 0);

  const text = await callClaudeSearch(env, {
    model: MODEL_PHOTO,
    max_tokens: 2500,
    system: VERIFY_SYSTEM,
    messages: [{
      role: 'user',
      content: `次の食品の公式の栄養成分情報を確認してください。\n品名: ${name}` +
        (amountG ? `\n分量: ${amountG}g` : ''),
    }],
    maxUses: 3,   // コスト上限: 1リクエストの検索は最大3回
  });
  const parsed = extractJson(text);
  const found = parsed.found === true && parsed.values && typeof parsed.values === 'object';
  if (!found) return { found: false, note: String(parsed.note || '公式の栄養成分情報は見つかりませんでした') };
  const v = parsed.values;
  return {
    found: true,
    source: String(parsed.source || ''),
    serving: String(parsed.serving || ''),
    values: {
      amount_g: num(v.amount_g),
      kcal: num(v.kcal), p: num(v.p), f: num(v.f), c: num(v.c), salt: num(v.salt),
      micros: normMicros(v.micros),
    },
    note: String(parsed.note || ''),
  };
}

// ---- チャット用: アプリから届いた会話履歴をAPI形式に整える ----
// 直近20件（=10往復）までに制限し、連続する同じroleはマージする
// （返信の取得に失敗した後にもう一度送信すると user が2連続になるため）
function shapeChatMessages(raw) {
  const msgs = (Array.isArray(raw) ? raw : [])
    .slice(-20)
    .map(m => ({
      role: m?.role === 'assistant' ? 'assistant' : 'user',
      content: String(m?.text || '').slice(0, 2000).trim(),
    }))
    .filter(m => m.content);
  const merged = [];
  for (const m of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += '\n' + m.content;
    else merged.push(m);
  }
  // 先頭はuserでなければならないので、assistantで始まる場合は取り除く
  while (merged.length && merged[0].role !== 'user') merged.shift();
  return merged;
}

// ---- AIチャット相談（Sonnet 5） ----
async function handleChat(env, body) {
  const messages = shapeChatMessages(body?.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    throw new Error('メッセージがありません');
  }
  const notes = String(body?.notes || '').slice(0, 4000).trim();
  const summary = String(body?.summary || '').slice(0, 4000).trim();
  const context = String(body?.context || '').slice(0, 20_000).trim();

  const system = CHAT_SYSTEM
    + (notes ? `\n\n# メモリーノート（これまでに覚えたユーザーの事実）\n${notes}` : '')
    + (summary ? `\n\n# ここまでの会話の要約（古い部分を圧縮したもの）\n${summary}` : '')
    + (context ? `\n\n# ユーザーの最新データ\n${context}` : '');

  const text = await callClaude(env, {
    model: MODEL_TRAINER,
    max_tokens: 4000,                        // 思考（adaptive thinking）ぶんの余裕を含む
    output_config: {
      effort: 'medium',                      // コーチコメントと同じコスト・質バランス
      format: { type: 'json_schema', schema: CHAT_SCHEMA },
    },
    system,
    messages,
  });
  const parsed = JSON.parse(text);           // structured outputsによりCHAT_SCHEMA準拠が保証される
  return {
    reply: String(parsed.reply || '').trim(),
    new_notes: (Array.isArray(parsed.new_notes) ? parsed.new_notes : [])
      .map(s => String(s).trim().slice(0, 100))
      .filter(Boolean)
      .slice(0, 2),
  };
}

// ---- チャット履歴の要約圧縮（Haiku 4.5・会話が長くなったとき用） ----
async function handleChatSummary(env, body) {
  const messages = shapeChatMessages(body?.messages);
  if (!messages.length) throw new Error('要約する会話がありません');
  const prev = String(body?.summary || '').slice(0, 4000).trim();
  const convo = messages
    .map(m => `${m.role === 'user' ? 'ユーザー' : 'トレーナー'}: ${m.content}`)
    .join('\n');
  const text = await callClaude(env, {
    model: MODEL_PHOTO,                      // 要約は速くて安いHaikuで十分
    max_tokens: 800,
    system: CHAT_SUMMARY_SYSTEM,
    messages: [{
      role: 'user',
      content: (prev ? `これまでの要約:\n${prev}\n\n` : '') + `会話:\n${convo}`,
    }],
  });
  return { summary: text.trim().slice(0, 1500) };
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
      if (url.pathname === '/verify') return json(await handleVerify(env, body), 200, origin);
      if (url.pathname === '/trainer') return json(await handleTrainer(env, body), 200, origin);
      if (url.pathname === '/chat') return json(await handleChat(env, body), 200, origin);
      if (url.pathname === '/chat-summary') return json(await handleChatSummary(env, body), 200, origin);
      return json({ error: '不明なエンドポイントです' }, 404, origin);
    } catch (err) {
      return json({ error: err.message || String(err) }, 502, origin);
    }
  },
};
