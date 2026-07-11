// ============================================================
// db.js — データ層
// IndexedDB（ブラウザ内蔵のデータベース）の読み書きを一手に引き受ける。
// 将来Firebase同期を足す場合もこのファイルに処理を追加すればよい。
// ============================================================

const DB_NAME = 'fitfuel';
const DB_VER = 1;

// 全ストア（テーブルに相当）の一覧。バックアップ対象もこれと同じ。
export const STORES = [
  'settings', 'meals', 'weights', 'water',
  'exercises', 'workouts', 'supplements', 'suppLog', 'customFoods',
];

let _db = null;

// データベースを開く（初回はストアを作成する）
export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const mk = (name, opt) =>
        db.objectStoreNames.contains(name) ? null : db.createObjectStore(name, opt);
      mk('settings', { keyPath: 'key' });
      const meals = mk('meals', { keyPath: 'id', autoIncrement: true });
      if (meals) meals.createIndex('date', 'date');
      mk('weights', { keyPath: 'date' });
      mk('water', { keyPath: 'date' });
      mk('exercises', { keyPath: 'id', autoIncrement: true });
      const wo = mk('workouts', { keyPath: 'id', autoIncrement: true });
      if (wo) { wo.createIndex('date', 'date'); wo.createIndex('exerciseId', 'exerciseId'); }
      mk('supplements', { keyPath: 'id', autoIncrement: true });
      mk('suppLog', { keyPath: 'date' });
      mk('customFoods', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

// IDBRequest（IndexedDBの非同期リクエスト）をPromiseに変換する小道具
function wrap(r) {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

// ---- 書き込み検知（クラウド同期用） ----
// put/del/clearStore のたびに呼ばれるフックを1つ登録できる。
// 同期処理自身の書き込みでフックが再発火しないよう silently() で囲めるようにする。
let _onWrite = null;
let _silent = false;
export function setWriteHook(fn) { _onWrite = fn; }
export async function silently(fn) {
  _silent = true;
  try { return await fn(); } finally { _silent = false; }
}
function notifyWrite() { if (!_silent && _onWrite) _onWrite(); }

// ---- 基本操作 ----
export async function get(name, key) { return wrap((await store(name)).get(key)); }
export async function all(name) { return wrap((await store(name)).getAll()); }
export async function put(name, val) {
  const r = await wrap((await store(name, 'readwrite')).put(val));
  notifyWrite();
  return r;
}
export async function del(name, key) {
  const r = await wrap((await store(name, 'readwrite')).delete(key));
  notifyWrite();
  return r;
}
export async function clearStore(name) {
  const r = await wrap((await store(name, 'readwrite')).clear());
  notifyWrite();
  return r;
}

// 日付インデックスで絞り込み（meals / workouts 用）
export async function byDate(name, date) {
  return wrap((await store(name)).index('date').getAll(date));
}
export async function byIndex(name, index, value) {
  return wrap((await store(name)).index(index).getAll(value));
}

// その日以前で最も新しい体重を返す（消費カロリー推定用。記録がなければnull）
export async function latestWeightUpTo(date) {
  const rows = await all('weights');
  const hit = rows
    .filter(r => r.date <= date && r.weight != null)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  return hit ? hit.weight : null;
}

// ---- 設定（key-value形式） ----
export async function getSetting(key, def = null) {
  const row = await get('settings', key);
  return row ? row.value : def;
}
export async function setSetting(key, value) {
  return put('settings', { key, value });
}

// ---- バックアップ ----
// 全ストアをまとめて1つのJSONオブジェクトにする（エクスポート用）
export async function exportAll() {
  const out = { _app: 'fitfuel', _ver: DB_VER, _exported: new Date().toISOString() };
  for (const s of STORES) out[s] = await all(s);
  return out;
}

// JSONから全ストアを復元する（既存データは置き換え）
export async function importAll(data) {
  if (!data || data._app !== 'fitfuel') throw new Error('このアプリのバックアップファイルではありません');
  for (const s of STORES) {
    if (!Array.isArray(data[s])) continue;
    await clearStore(s);
    for (const row of data[s]) await put(s, row);
  }
}
