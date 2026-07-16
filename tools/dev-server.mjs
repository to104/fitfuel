// fitfuel ローカル動作確認用サーバー
// 8787: fitfuelを静的配信 / 8788: AI Workerのモック（本物と同じ応答形式）
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// このファイル（fitfuel/tools/）の1つ上＝fitfuelフォルダを配信する
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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
}).listen(8787, () => console.log('app: http://localhost:8787'));

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
      note: '【モック応答】揚げ物の衣の量で脂質は±20%程度ぶれます',
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
}).listen(8788, () => console.log('mock-ai: http://localhost:8788'));
