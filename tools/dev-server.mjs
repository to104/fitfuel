// fitfuel ローカル動作確認用サーバー
// 8787: fitfuelを静的配信 / 8788: AI Workerのモック（本物と同じ応答形式）
// 引数でポート変更可（例: node dev-server.mjs 8789 → アプリ8789・モック8790）。8787が使用中のとき用
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// このファイル（fitfuel/tools/）の1つ上＝fitfuelフォルダを配信する
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT_APP = +(process.argv[2] || process.env.PORT || 8787);
const PORT_AI = PORT_APP + 1;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.md': 'text/markdown; charset=utf-8',
};

// ---- 静的配信（8787） ----
http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(normalize(ROOT))) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT_APP, () => console.log(`app: http://localhost:${PORT_APP}`));

// ---- AI Workerモック（8788） ----
const cors = (origin) => ({
  'Access-Control-Allow-Origin': origin || '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (req.method === 'OPTIONS') { res.writeHead(204, cors(origin)).end(); return; }
  if (req.method === 'GET') {
    res.writeHead(200, cors(origin)).end(JSON.stringify({ ok: true, service: 'fitfuel-ai' }));
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const url = new URL(req.url, 'http://x');
  console.log(`POST ${url.pathname} body=${body.length}bytes`);
  if (url.pathname === '/photo') {
    await sleep(1200);
    // 補足（hint）があるときは本番同様「公式情報を参照したか」が分かるnoteを返す
    let hint = '';
    try { hint = (JSON.parse(body).hint || '').trim(); } catch { /* 無視 */ }
    res.writeHead(200, cors(origin)).end(JSON.stringify({
      dishes: [
        // micros = [ビタミンD(µg), B1, B2, B6, C, Ca, Mg, Fe, Zn, K]（本番Workerと同じ形式）
        { name: 'ご飯（白米）', amount_g: 150, kcal: 234, p: 3.8, f: 0.5, c: 55.7, salt: 0,
          micros: [0, 0.03, 0.02, 0.03, 0, 5, 10, 0.2, 0.9, 44] },
        { name: '鶏の唐揚げ', amount_g: 90, kcal: 261, p: 19.8, f: 15.5, c: 12, salt: 1,
          micros: [0.4, 0.09, 0.13, 0.28, 2, 14, 25, 0.7, 1.5, 350] },
        { name: 'みそ汁', amount_g: 180, kcal: 40, p: 3.1, f: 1.3, c: 5, salt: 1.8,
          micros: [0, 0.03, 0.04, 0.08, 1, 40, 20, 0.7, 0.3, 250] },
      ],
      note: hint
        ? `【モック応答】「${hint}」の公式情報を参照しました（それ以外は推定値）`
        : '【モック応答】揚げ物の衣の量で脂質は±20%程度ぶれます',
    }));
    return;
  }
  if (url.pathname === '/verify') {
    await sleep(1500);
    let name = '';
    try { name = (JSON.parse(body).name || '').trim(); } catch { /* 無視 */ }
    // 汎用的な手料理（みそ汁など）は「見つからない」パターンを返してUIを検証できるようにする
    if (/みそ汁|味噌汁|サラダ|炒め/.test(name)) {
      res.writeHead(200, cors(origin)).end(JSON.stringify({
        found: false,
        note: `【モック応答】「${name}」は一般的な手料理のため公式の栄養成分情報はありません`,
      }));
      return;
    }
    res.writeHead(200, cors(origin)).end(JSON.stringify({
      found: true,
      source: 'メーカー公式サイト（モック）',
      serving: '1食(120g)あたり',
      values: { amount_g: 120, kcal: 300, p: 21, f: 17.2, c: 14, salt: 1.4,
        micros: [0.5, 0.1, 0.15, 0.3, 0, 15, 27, 0.8, 1.6, 380] },
      note: `【モック応答】「${name}」の公式値です（推定と数%〜数十%ずれるのが正常）`,
    }));
    return;
  }
  if (url.pathname === '/chat') {
    await sleep(1500);
    let last = '', notes = '';
    try {
      const b = JSON.parse(body);
      last = ((b.messages || []).slice(-1)[0]?.text || '').trim();
      notes = b.notes || '';
    } catch { /* 無視 */ }
    // ケガ・目標などのキーワードを含むとメモリーノート抽出ありのパターンを返す
    const newNotes = /ケガ|怪我|痛|目標|アレルギ|苦手|できない|夜勤|器具/.test(last)
      ? [`【モック】${last.slice(0, 40)}`] : [];
    res.writeHead(200, cors(origin)).end(JSON.stringify({
      reply: `【モック応答】「${last.slice(0, 30)}」ですね。直近の記録を見るとベンチプレスは60kg×8を安定してこなせているので、次回は+2.5kgに挑戦して大丈夫です。タンパク質は今日あと30gほど不足しているので、トレ後のプロテインを忘れずに。${notes ? '\n（メモリーノート' + notes.split('\n').length + '件を参照）' : ''}`,
      new_notes: newNotes,
    }));
    return;
  }
  if (url.pathname === '/chat-summary') {
    await sleep(1200);
    let count = 0;
    try { count = (JSON.parse(body).messages || []).length; } catch { /* 無視 */ }
    res.writeHead(200, cors(origin)).end(JSON.stringify({
      summary: `【モック要約】直近の会話${count}件の要約。ユーザーはベンチプレスの伸び悩みを相談し、+2.5kg挑戦とタンパク質摂取の改善（1日130g目標）を助言した。次回はフォーム動画の確認を予定。`,
    }));
    return;
  }
  if (url.pathname === '/trainer') {
    await sleep(1800);
    res.writeHead(200, cors(origin)).end(JSON.stringify({
      comment: '【モック応答】前回のベンチプレスは全セット8回以上こなせているので、今日の+2.5kgは十分いけます。昨日のタンパク質は目標にあと20g足りていないので、トレ後のプロテインを忘れずに。脚は中1日なので軽めの調整で正解です。',
    }));
    return;
  }
  res.writeHead(404, cors(origin)).end(JSON.stringify({ error: '不明なエンドポイントです' }));
}).listen(PORT_AI, () => console.log(`mock-ai: http://localhost:${PORT_AI}`));
