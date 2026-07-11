// ============================================================
// sync.js — クラウド同期（Googleドライブ）
// ・全データ（db.exportAll）を1ファイルにまとめてGoogleドライブに置き、
//   PC・スマホ間で共有する（パスワード管理アプリと同じ方式）
// ・認証は Google Identity Services（GIS）のトークン方式（サーバー不要）
// ・スコープは drive.file（このアプリが作ったファイルだけにアクセスできる最小権限）
// ・競合解決は「改訂番号（rev）が大きい方が勝ち」の後勝ち方式
// ============================================================
import * as db from './db.js';
import { toast } from './ui.js';
import { refresh } from './app.js';

const GDRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SYNC_FILE_NAME = 'fitfuel-sync.json';   // ドライブ上の同期ファイル名
// 既定のGoogle Client ID（接続元を to104.github.io に限定済みのため公開して問題なし・pwvaultと共用）
const DEFAULT_GCLIENT = '18371070682-fonja31i8fht760pj9tkm6o4lgh917kp.apps.googleusercontent.com';

// localStorageのキー（端末ごとの状態。同期データ本体には含めない）
const LS_ON = 'ff_sync_on';        // '1'=同期オン
const LS_DIRTY = 'ff_sync_dirty';  // '1'=未アップロードの変更あり
const LS_LAST = 'ff_sync_last';    // 最終同期日時（ISO文字列）
const LS_DEVICE = 'ff_deviceid';   // この端末の識別子
const LS_GCLIENT = 'ff_gclient';   // Client IDの上書き用（通常は未使用）

export function syncOn() { return localStorage.getItem(LS_ON) === '1'; }
export function lastSync() { return localStorage.getItem(LS_LAST) || ''; }
function gClientId() { return (localStorage.getItem(LS_GCLIENT) || DEFAULT_GCLIENT).trim(); }
function deviceId() {
  let d = localStorage.getItem(LS_DEVICE);
  if (!d) {
    d = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
    localStorage.setItem(LS_DEVICE, d);
  }
  return d;
}
function markDirty() { localStorage.setItem(LS_DIRTY, '1'); }
function clearDirty() { localStorage.setItem(LS_DIRTY, ''); }
function isDirty() { return localStorage.getItem(LS_DIRTY) === '1'; }

// ---- Googleログイン用スクリプトを必要時だけ読み込む（同期オフ時はオフラインで完結） ----
let _gisReady = null;
function loadGis() {
  if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
  if (_gisReady) return _gisReady;
  _gisReady = new Promise((ok, ng) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.defer = true;
    s.onload = () => ok();
    s.onerror = () => { _gisReady = null; ng(new Error('Google接続用スクリプトを読み込めませんでした（ネット接続を確認してください）')); };
    document.head.appendChild(s);
  });
  return _gisReady;
}

// ---- アクセストークン取得（約1時間有効・メモリ上にのみ保持） ----
let _tokenClient = null, _accessToken = null, _tokenExp = 0, _tokenWait = null;
// 待機中のトークン要求を1回だけ確定させる（成功/失敗どちらでも必ず決着させる）
function _settleToken(err, val) {
  const w = _tokenWait; _tokenWait = null;
  if (!w) return;
  if (err) w.reject(err); else w.resolve(val);
}
async function getToken({ interactive }) {
  const cid = gClientId();
  if (!cid) throw new Error('Google Client IDが未設定です');
  if (_accessToken && Date.now() < _tokenExp - 60000) return _accessToken; // 有効なら再利用
  await loadGis();
  if (!_tokenClient || _tokenClient.__cid !== cid) {
    _tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: cid, scope: GDRIVE_SCOPE,
      callback: (resp) => {
        if (resp && resp.access_token) {
          _accessToken = resp.access_token;
          _tokenExp = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
          _settleToken(null, _accessToken);
        } else {
          _settleToken(new Error((resp && resp.error) || 'auth_failed'));
        }
      },
      // ポップアップが開けない/閉じられた等の失敗もここで受け取る（これが無いと固まる原因になる）
      error_callback: (err) => { _settleToken(new Error((err && err.type) || 'popup_failed')); },
    });
    _tokenClient.__cid = cid;
  }
  return await new Promise((resolve, reject) => {
    let done = false;
    // 返事が来ないまま固まらないよう、一定時間で打ち切る（タイムアウト）
    const timer = setTimeout(() => { if (!done) { done = true; _tokenWait = null; reject(new Error('token_timeout')); } }, interactive ? 90000 : 15000);
    _tokenWait = {
      resolve: (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      reject: (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } },
    };
    // interactive=true: 必要なら同意画面を出す ／ false: 画面を出さず静かに取得（自動同期用）
    try { _tokenClient.requestAccessToken({ prompt: interactive ? '' : 'none' }); }
    catch (e) { _settleToken(e); }
  });
}
function authHeaders() { return { Authorization: 'Bearer ' + _accessToken }; }
function forgetToken() { _accessToken = null; _tokenExp = 0; }

// ---- Driveファイル操作 ----
let _fileId = null;
async function findSyncFile() {
  const q = encodeURIComponent(`name='${SYNC_FILE_NAME}' and trashed=false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,modifiedTime)`, { headers: authHeaders() });
  if (res.status === 401) { forgetToken(); throw new Error('auth_expired'); }
  if (!res.ok) throw new Error('drive_list_' + res.status);
  const j = await res.json();
  _fileId = (j.files && j.files[0]) ? j.files[0].id : null;
  return _fileId;
}
async function readRemote() {
  const id = await findSyncFile();
  if (!id) return null;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: authHeaders() });
  if (res.status === 401) { forgetToken(); throw new Error('auth_expired'); }
  if (!res.ok) throw new Error('drive_get_' + res.status);
  const env = await res.json();
  if (env.app !== 'fitfuel-sync' || !env.data) throw new Error('同期ファイルの形式が不正です');
  return env;
}
async function buildEnvelope(rev) {
  return {
    app: 'fitfuel-sync', ver: 1,
    rev,
    updatedAt: new Date().toISOString(),
    deviceId: deviceId(),
    data: await db.exportAll(),
  };
}
async function writeRemote(env) {
  const meta = {
    name: SYNC_FILE_NAME, mimeType: 'application/json',
    appProperties: { rev: String(env.rev), updatedAt: env.updatedAt },
  };
  const boundary = '----ff' + Date.now();
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(meta) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
    JSON.stringify(env) +
    `\r\n--${boundary}--`;
  const id = _fileId || await findSyncFile();
  const url = id
    ? `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=multipart&fields=id`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`;
  const res = await fetch(url, {
    method: id ? 'PATCH' : 'POST',
    headers: Object.assign({ 'Content-Type': `multipart/related; boundary=${boundary}` }, authHeaders()),
    body,
  });
  if (res.status === 401) { forgetToken(); throw new Error('auth_expired'); }
  if (!res.ok) throw new Error('drive_put_' + res.status);
  const j = await res.json(); _fileId = j.id;
}

// ---- 改訂番号（rev）はデータ本体（settingsストア）に保存＝データと一緒に同期される ----
async function localRev() { return (await db.getSetting('syncRev', 0)) || 0; }

// ---- ローカル→クラウドへアップロード（revを進めてから上げる） ----
async function push(remoteRev) {
  const rev = Math.max(await localRev(), remoteRev || 0) + 1;
  // 同期処理自身の書き込みで「変更あり」フラグが再び立たないよう silently で書く
  await db.silently(() => db.setSetting('syncRev', rev));
  await writeRemote(await buildEnvelope(rev));
  clearDirty();
}

// ---- クラウド→ローカルへ取り込み（全データ置き換え） ----
async function applyRemote(env) {
  await db.silently(() => db.importAll(env.data));
  clearDirty();
  await refresh();   // 表示中の画面を描き直す
}

// ---- 表示用のエラーメッセージ変換 ----
function niceSyncErr(e) {
  const m = String((e && e.message) || e);
  if (m === 'auth_expired' || m.includes('401')) return 'Google認証の期限切れ。もう一度接続してください';
  if (m === 'access_denied' || m.includes('denied') || m === 'popup_closed') return 'Googleの許可がキャンセルされました';
  if (m === 'token_timeout') return 'Google接続がタイムアウトしました。もう一度お試しください';
  if (m === 'popup_failed' || m === 'interaction_required') return 'Googleのログイン画面を開けませんでした。一度アプリを開き直してお試しください';
  if (m.includes('Failed to fetch') || m.includes('NetworkError')) return 'ネットワークに接続できません';
  return m;
}
function afterSync() { localStorage.setItem(LS_LAST, new Date().toISOString()); }

// ---- 同期の実行（取り込み↔アップロードを自動判定） ----
// 「同期中」が90秒以上続いていたら固まったとみなして再実行を許可する
let _busy = false, _busyAt = 0, _timer = null, _lastAuto = 0;
function busyNow() { return _busy && Date.now() - _busyAt < 90000; }

export async function syncNow({ interactive = true } = {}) {
  if (busyNow()) { if (interactive) toast('同期中です…'); return; }
  _busy = true; _busyAt = Date.now();
  try {
    await getToken({ interactive });
    const remote = await readRemote();
    const rev = await localRev();
    if (isDirty() || !remote) {
      // この端末に未送信の変更がある（または初回）→ アップロード（後勝ち）
      await push(remote ? remote.rev : 0);
      afterSync(); if (interactive) toast('クラウドへアップロードしました');
    } else if (remote.rev > rev) {
      await applyRemote(remote);
      afterSync(); if (interactive) toast('最新の内容を取り込みました');
    } else {
      afterSync(); if (interactive) toast('すでに最新です');
    }
  } catch (e) {
    if (interactive) toast('同期エラー: ' + niceSyncErr(e));
  } finally { _busy = false; }
}

// ---- 自動同期: 保存の4秒後にまとめてアップロード（連続保存を1回にまとめる） ----
function scheduleSync() {
  if (!syncOn()) return;
  clearTimeout(_timer);
  _timer = setTimeout(() => syncNow({ interactive: false }), 4000);
}

// ---- 同期の有効化（初回。クラウドに既存データがあれば取り込むか確認する） ----
// 戻り値: 'pulled'=クラウドを取り込んだ / 'pushed'=この端末の内容を上げた
export async function enableSync() {
  await getToken({ interactive: true });   // Googleの同意画面
  const remote = await readRemote();
  localStorage.setItem(LS_ON, '1');
  if (remote) {
    // 空の端末で上書きしてしまう事故（pwvaultで経験済み）を防ぐため、必ず方向を確認する
    const pull = confirm(
      'クラウド上に同期データが見つかりました。\n\n' +
      '「OK」= クラウドのデータをこの端末に取り込む（2台目の端末はこちら）\n' +
      '「キャンセル」= この端末の内容でクラウドを上書きする'
    );
    if (pull) { await applyRemote(remote); afterSync(); return 'pulled'; }
  }
  await push(remote ? remote.rev : 0);
  afterSync();
  return 'pushed';
}
export function disableSync() {
  localStorage.setItem(LS_ON, '');
  clearTimeout(_timer);
}

// ---- 初期化（起動時に呼ぶ）: 変更検知の登録・起動時/復帰時の自動同期 ----
export function initSync() {
  // データが書き換わったら「変更あり」を立てて自動アップロードを予約する
  db.setWriteHook(() => { markDirty(); scheduleSync(); });

  // アプリに戻ってきたときにクラウドの最新を取り込む（連発しないよう60秒間隔）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !syncOn()) return;
    if (Date.now() - _lastAuto < 60000) return;
    _lastAuto = Date.now();
    syncNow({ interactive: false });
  });

  // 起動直後にもクラウドの最新を取り込む（画面の初期表示を邪魔しないよう少し待つ）
  if (!syncOn()) return;
  setTimeout(() => { _lastAuto = Date.now(); syncNow({ interactive: false }); }, 800);
}

// ---- 設定画面用: 最終同期日時の表示 ----
export function fmtLast() {
  const iso = lastSync(); if (!iso) return '未同期';
  const d = new Date(iso); if (isNaN(d)) return '未同期';
  return `最終同期 ${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
