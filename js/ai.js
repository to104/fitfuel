// ============================================================
// ai.js — Claude API連携（Cloudflare Worker中継）
// APIキーはWorker側のSecretにあり、アプリはWorkerのURLだけを知っていればよい。
// URLは settings ストアに保存＝Googleドライブ同期に乗るので、1台で設定すれば全端末に行き渡る。
// ============================================================
import * as db from './db.js';

// ---- Worker URLの設定 ----
export async function getWorkerUrl() {
  return ((await db.getSetting('aiWorkerUrl', '')) || '').trim().replace(/\/+$/, '');
}
export async function setWorkerUrl(url) {
  await db.setSetting('aiWorkerUrl', (url || '').trim().replace(/\/+$/, ''));
}

// AI機能が使える状態か（URL設定済み かつ オンライン）
export async function aiReady() {
  const url = await getWorkerUrl();
  return !!url && navigator.onLine;
}

// ---- Worker呼び出しの共通処理（タイムアウトつき） ----
async function call(path, body, timeoutMs) {
  const base = await getWorkerUrl();
  if (!base) throw new Error('Worker URLが未設定です（設定 → AI連携）');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    // 原因: タイムアウト・圏外・URL間違いなど / 解決策: 電波状況とURLを確認して再試行
    throw new Error(e.name === 'AbortError' ? '時間切れです。電波の良い場所で再試行してください' : '接続できません。オンライン状態とWorker URLを確認してください');
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラー（${res.status}）`);
  return data;
}

// ---- 接続テスト（設定画面用） ----
export async function testConnection(url) {
  const base = (url || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('URLを入力してください');
  let res;
  try {
    res = await fetch(base, { method: 'GET' });
  } catch {
    throw new Error('接続できません。URLを確認してください');
  }
  const data = await res.json().catch(() => ({}));
  if (data.service !== 'fitfuel-ai') throw new Error('fitfuel用のWorkerではないようです（貼り付けたコードを確認）');
  return true;
}

// ---- 食事写真の解析 ----
// image: resizeImage()の戻り値（縮小済み画像）→ Workerへ → {dishes:[...], note}
export async function analyzePhoto(image, hint = '') {
  return call('/photo', { image: image.data, media_type: image.mediaType, hint }, 60_000);
}

// ---- 解析結果の1品を公式情報で再確認（Web検索） ----
// name: 品名 / amountG: 分量g → {found, source, serving, values:{amount_g,kcal,p,f,c,salt,micros}, note}
export async function verifyFood(name, amountG) {
  return call('/verify', { name, amount_g: amountG || 0 }, 60_000);
}

// ---- AIトレーナーのコーチコメント ----
// summary: coach.jsが組み立てた記録・メニュー・栄養のテキスト → コメント文字列
export async function trainerComment(summary) {
  const res = await call('/trainer', { summary }, 90_000);
  return res.comment;
}

// ---- 画像の縮小（送信トークン・通信量の削減） ----
// 長辺maxPxに縮小してJPEG化し、base64文字列（データ本体のみ）を返す
export async function resizeImage(file, maxPx = 1024) {
  const img = await loadImage(file);
  const scale = Math.min(1, maxPx / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  const w = Math.round((img.naturalWidth || img.width) * scale);
  const h = Math.round((img.naturalHeight || img.height) * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
  return { data: dataUrl.split(',')[1], mediaType: 'image/jpeg', dataUrl };
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めません')); };
    img.src = url;
  });
}
