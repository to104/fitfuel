// ============================================================
// timer.js — セット間の休憩タイマー
// 筋トレ記録アプリ（kintore-log）から移植・fitfuel向けに再構成。
// ・音はWeb Audio API（ブラウザ内蔵の音声合成機能）で生成（音源ファイル不要）
// ・カウント状態はlocalStorageに保存し、アプリを閉じても続きから再開
// ・設定（音・音量・自動開始・休憩時間）はIndexedDBのsettingsに保存
//   （バックアップJSONに含まれるようにするため）
// ============================================================
import * as db from './db.js';
import { toast } from './ui.js';

const LS_KEY = 'ff_timer';   // カウント状態の保存先（localStorage）
// alarmMode: 'ring'=必ず鳴る（マナーモード無視・鳴る間だけ音楽が一時停止→手動再開）
//            'music'=音楽優先（音楽は止まらないが、マナーモードONだと鳴らない）
// ※iOSの消音スイッチ状態はWebから読めないため自動切替は不可＝ユーザーがタイマーカードで切替
const DEFAULT_PREFS = { sound: 'beep', vol: 0.7, autoTimer: true, rest: 150, alarmMode: 'ring' };

let prefs = { ...DEFAULT_PREFS };
let total = 150, remain = 150, running = false, endAt = 0;
let intervalId = null, lastSec = null, wakeLock = null;
let onOpenTrain = null;      // ミニバータップ時にトレ画面へ移動するコールバック

// ============================================================
// 音（Web Audio APIで合成）
// ============================================================
let AC = null, COMP = null;

// マナーモード（消音スイッチ）対策（Audio Session API・iOS 17以降。未対応の環境では何もしない）
// ・普段は 'transient'（再生中の音楽を止めない設定）
// ・鳴る直前〜直後だけ 'playback'（消音スイッチを無視して必ず鳴る設定。
//   その十数秒間だけ他アプリの音楽が一時停止する副作用あり）
//   ※v1.15〜v1.28の「'transient'常時宣言」は実機で消音スイッチに負けることが
//     判明したため、この2段構えに方式変更（v1.29.0）
// ・iOSは電話・Siri・バックグラウンド移動などでセッション設定を勝手に戻すことが
//   あるため、読み込み時の1回だけでなく音を扱うたびに宣言し直す。
let sessionMode = 'transient';
let sessionRevert = null;
function declareSession(mode) {
  if (mode) sessionMode = mode;
  try { if (navigator.audioSession) navigator.audioSession.type = sessionMode; } catch (e) {}
}
declareSession();

// いまから鳴らす音のために'playback'へ切り替え、ms後に'transient'へ戻す。
// カウント中は戻さない（残り3秒のカウント音〜終了音を確実に鳴らすため）。
// 音楽優先モード（alarmMode:'music'）のときは'playback'に切り替えず'transient'のまま
// ＝音楽は一時停止しないが、マナーモードONでは鳴らない（ユーザー了承済みのトレードオフ）。
function audible(ms) {
  clearTimeout(sessionRevert);
  declareSession(prefs.alarmMode === 'music' ? 'transient' : 'playback');
  ac();   // 停止中なら今のうちに音声機能を復帰させておく（鳴る瞬間に間に合わせる）
  sessionRevert = setTimeout(() => {
    if (running) return;
    declareSession('transient');
    releaseAudio();
  }, ms);
}

// 一時停止させた音楽を再開させるため、音声セッション（このアプリの音の枠）を完全に手放す。
// iOSは割り込んだ側が枠を手放したときに元のアプリへ「再開してよい」通知を出す。
// suspend()（一時停止）では手放した扱いにならず音楽が止まったままだった（v1.29.1の実機報告）
// ため、close()で破棄する。次に必要なとき（✓セット完了・スタート等のタップ内のac()）に作り直す。
function releaseAudio() {
  const old = AC;
  AC = null; COMP = null;
  try { if (old) old.close().catch(() => {}); } catch (e) {}
}

function ac() {
  declareSession();   // リセットされていてもここで必ず「消音スイッチでも鳴る」宣言に戻す
  if (!AC) {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    COMP = AC.createDynamicsCompressor();   // 音割れ防止（大きい音を自動で抑える）
    COMP.connect(AC.destination);
  }
  // "suspended"（一時停止）だけでなくiOSの"interrupted"（電話・Siriによる中断）からも復帰させる
  if (AC.state !== 'running') AC.resume().catch(() => {});
  return AC;
}
// ブラウザの自動再生制限（ユーザー操作の中でしか音を出し始められないルール）対策。
// アプリを閉じている間にタイマーが終わっていた場合（pendingFinish）はここで遅れて鳴らす。
// カウント中は復元直後（タップなしで再開したケース）に備え、タップのついでに音を解禁する。
// ※カウント中以外は何もしない。以前は毎タップac()していたが、それだと解放（releaseAudio）
//   直後のタップで音声セッションを取り直してしまい、音楽の自動再開を妨げるため。
let pendingFinish = false;
document.addEventListener('pointerdown', () => {
  if (pendingFinish) { pendingFinish = false; ac(); playFinish(); return; }
  if (running) ac();
}, { passive: true });

// 単音を鳴らす（周波数, 開始秒, 長さ, 波形, 音量係数, グライド先周波数）
function tone(freq, start, dur, type = 'sine', vol = 1, glide = null) {
  const c = ac(), t0 = c.currentTime + start;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  if (glide) o.frequency.exponentialRampToValueAtTime(glide, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.001, prefs.vol * vol * 0.9), t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(COMP);
  o.start(t0); o.stop(t0 + dur + 0.05);
}

export const SOUNDS = {
  beep:   { name: '電子ビープ（ピピピッ）', play() { for (let i = 0; i < 3; i++) tone(880, i * 0.18, 0.12, 'square', .8); } },
  chime:  { name: 'チャイム（ピンポーン）', play() { tone(659, 0, 0.45, 'sine', 1); tone(523, 0.4, 0.9, 'sine', 1); } },
  bell:   { name: 'ベル（チーン）',         play() { [0, 0.5].forEach(s => { tone(1319, s, 1.1, 'sine', .9); tone(2637, s, 0.55, 'sine', .25); }); } },
  alarm:  { name: 'アラーム（ビービー）',   play() { for (let i = 0; i < 4; i++) tone(i % 2 ? 700 : 920, i * 0.22, 0.18, 'sawtooth', .55); } },
  melody: { name: 'メロディ（ピロリン）',   play() { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.13, 0.3, 'triangle', .9)); } },
};
// 音を鳴らす。音声機能が停止中（バックグラウンド復帰直後など）は復帰を待ってから鳴らす
export function playSound(key) {
  audible(6000);   // マナーモードでも鳴るように（終了音2回分をカバーしたら早めに解放して音楽を戻す）
  const c = ac();
  const go = () => (SOUNDS[key] || SOUNDS.beep).play();
  if (c.state === 'running') go();
  else c.resume().then(go).catch(() => {});
}
function playTick() { tone(1000, 0, 0.06, 'sine', .4); }

function playFinish() {
  try { if (navigator.vibrate) navigator.vibrate([300, 150, 300]); } catch (e) {}
  playSound(prefs.sound);
  setTimeout(() => playSound(prefs.sound), 1400);   // 聞き逃し防止に2回鳴らす
}

// バイブを鳴らす。Androidは標準機能、iPhoneはスイッチ切替の触覚フィードバックを利用
// （ボタンを押した直後＝ユーザー操作中しか動かない点に注意）
export function haptic() {
  try {
    if (navigator.vibrate) navigator.vibrate(80);
    else document.getElementById('haptic-sw')?.click();
  } catch (e) {}
}

// ============================================================
// 画面消灯防止（Wake Lock。iOS 16.4以降のSafariで有効）
// ============================================================
async function requestWake() { try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {} }
function releaseWake() { try { wakeLock && wakeLock.release(); } catch (e) {} wakeLock = null; }

// ============================================================
// タイマー本体
// ============================================================
export function fmtSec(s) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
export function isRunning() { return running; }

function saveState() {
  localStorage.setItem(LS_KEY, JSON.stringify({ total, remain, running, endAt }));
}

function startTicking() {
  running = true; lastSec = remain;
  intervalId = setInterval(tick, 200);
  requestWake();
}
function stopTicking() {
  running = false;
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
  releaseWake();
}
function tick() {
  remain = Math.max(0, Math.round((endAt - Date.now()) / 1000));
  if (remain !== lastSec) {
    lastSec = remain;
    if (remain > 0 && remain <= 4) audible(12000); // 鳴る直前に消音スイッチ無視モードへ
    if (remain > 0 && remain <= 3) playTick();     // 残り3秒からカウント音
  }
  if (remain <= 0) { stopTicking(); playFinish(); saveState(); }
  updateUI();
}

// 休憩をはじめから開始（セット完了時に呼ぶ）
export function startRest() {
  ac();   // 自動開始でも音を解禁（「✓ セット完了」タップの操作中に呼ばれるため有効）
  stopTicking();
  total = prefs.rest; remain = total;
  endAt = Date.now() + remain * 1000;
  startTicking(); saveState(); updateUI();
}
// スタート／一時停止
export function toggle() {
  ac();   // ユーザー操作時に音の準備（iOSの制約対策）
  if (running) {
    remain = Math.max(0, Math.round((endAt - Date.now()) / 1000));
    stopTicking();
  } else {
    if (remain <= 0) remain = total;
    endAt = Date.now() + remain * 1000;
    startTicking();
  }
  saveState(); updateUI();
}
export function reset() {
  stopTicking();
  total = prefs.rest; remain = total;
  saveState(); updateUI();
}
export function adjust(d) {
  total = Math.max(30, total + d);
  remain = running ? Math.max(0, remain + d) : total;
  if (running) endAt = Date.now() + remain * 1000;
  saveState(); updateUI();
}
export function setTo(sec) {
  stopTicking();
  total = remain = sec;
  saveState(); updateUI();
}

// ============================================================
// 設定の読み書き
// ============================================================
export function getPrefs() { return { ...prefs }; }
export async function setPrefs(patch) {
  const restChanged = patch.rest != null && patch.rest !== prefs.rest;
  prefs = { ...prefs, ...patch };
  await db.setSetting('timer', prefs);
  if (restChanged && !running) { total = prefs.rest; remain = total; saveState(); }
  updateUI();
}

// ============================================================
// 起動時の初期化・復元
// ============================================================
export async function initTimer(opts = {}) {
  onOpenTrain = opts.onOpenTrain || null;
  prefs = { ...DEFAULT_PREFS, ...(await db.getSetting('timer', {})) };
  total = prefs.rest; remain = total;
  try {
    const st = JSON.parse(localStorage.getItem(LS_KEY));
    if (st) {
      total = st.total >= 30 ? st.total : prefs.rest;
      if (st.running) {
        const rem = Math.round((st.endAt - Date.now()) / 1000);
        if (rem > 0) {                             // カウント中に閉じた場合：続きから再開
          remain = rem; endAt = st.endAt;
          startTicking();
        } else {
          remain = 0;                              // 閉じている間に終了：0:00で停止表示
          if (rem > -60) pendingFinish = true;     // 終了から1分以内なら最初のタップ時に遅れて鳴らす
        }
      } else {
        remain = Math.min(Math.max(0, st.remain ?? total), total);
      }
    }
  } catch (e) { /* 壊れた保存データは初期値で無視 */ }

  const bar = document.getElementById('rest-bar');
  if (bar) bar.onclick = () => { if (onOpenTrain) onOpenTrain(); };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    declareSession();                                    // 復帰のたびにマナーモード対策を宣言し直す
    if (running) { requestWake(); ac(); }                // 復帰時に音も再開
  });
  updateUI();
}

// ============================================================
// 画面への反映
// タイマーの表示先は3つ。存在するものだけ更新する。
//  1. #rest-bar   … 全画面共通のミニバー（動作中のみ表示）
//  2. タイマーカード … トレ画面にmountCard()で設置
//  3. 休憩ストリップ … セット入力シート内にmountStrip()で設置
// ============================================================
const RING_R = 66, RING_LEN = 2 * Math.PI * RING_R;
let cardEl = null, stripEl = null;

function updateUI() {
  // --- ミニバー ---
  const bar = document.getElementById('rest-bar');
  if (bar) {
    bar.hidden = !running;
    if (running) bar.textContent = `⏱ 休憩 ${fmtSec(remain)}`;
  }
  // --- タイマーカード ---
  if (cardEl && document.body.contains(cardEl)) {
    cardEl.querySelector('#tc-time').textContent = fmtSec(Math.max(0, remain));
    cardEl.querySelector('#tc-sub').textContent = running ? `全体 ${fmtSec(total)}` : 'セット間の休憩';
    const ratio = total > 0 ? remain / total : 0;
    cardEl.querySelector('#tc-arc').style.strokeDashoffset = RING_LEN * (1 - Math.max(0, Math.min(1, ratio)));
    cardEl.querySelector('#tc-toggle').textContent = running ? '一時停止' : 'スタート';
    cardEl.querySelectorAll('[data-sec]').forEach(b =>
      b.classList.toggle('t-on', +b.dataset.sec === total));
    // アラーム方式の切替ボタン（🔔必ず鳴る ⇄ 🎵音楽優先）
    const modeBtn = cardEl.querySelector('#tc-mode');
    if (modeBtn) {
      const music = prefs.alarmMode === 'music';
      modeBtn.textContent = music ? '🎵 音楽優先' : '🔔 必ず鳴る';
      cardEl.querySelector('#tc-mode-hint').textContent = music
        ? '音楽は止まらない／マナーモードでは鳴らない'
        : 'マナーモードでも鳴る／アラーム時は音楽が一時停止';
    }
  } else cardEl = null;
  // --- シート内ストリップ ---
  if (stripEl && document.body.contains(stripEl)) {
    const show = running || (remain > 0 && remain < total);
    stripEl.hidden = !show;
    if (show) {
      stripEl.querySelector('#ts-time').textContent = fmtSec(remain);
      stripEl.querySelector('#ts-toggle').textContent = running ? '⏸' : '▶';
    }
  } else stripEl = null;
}

// トレ画面用のタイマーカードを描画する
export function mountCard(container) {
  container.innerHTML = `
    <div class="card timer-card">
      <div class="t-ring">
        <svg viewBox="0 0 150 150" width="150" height="150">
          <circle cx="75" cy="75" r="${RING_R}" fill="none" stroke="var(--ring-track)" stroke-width="9"/>
          <circle id="tc-arc" cx="75" cy="75" r="${RING_R}" fill="none" stroke="var(--accent)" stroke-width="9"
            stroke-linecap="round" stroke-dasharray="${RING_LEN}" stroke-dashoffset="0"
            transform="rotate(-90 75 75)"/>
        </svg>
        <div class="t-center">
          <div class="t-time" id="tc-time"></div>
          <div class="t-sub" id="tc-sub"></div>
        </div>
      </div>
      <div class="t-presets">
        ${[30, 60, 90, 120, 150, 180].map(s => `<button class="chip" data-sec="${s}">${fmtSec(s)}</button>`).join('')}
      </div>
      <div class="two-col t-adjust">
        <button class="chip" data-adj="-30">−30秒</button>
        <button class="chip" data-adj="30">＋30秒</button>
      </div>
      <div class="two-col t-main">
        <button class="btn" id="tc-toggle"></button>
        <button class="btn-ghost" id="tc-reset">リセット</button>
      </div>
      <div class="t-mode-row">
        <button class="chip" id="tc-mode"></button>
        <div class="t-mode-hint" id="tc-mode-hint"></div>
      </div>
    </div>`;
  cardEl = container;
  container.querySelectorAll('[data-sec]').forEach(b => b.onclick = () => setTo(+b.dataset.sec));
  container.querySelectorAll('[data-adj]').forEach(b => b.onclick = () => adjust(+b.dataset.adj));
  container.querySelector('#tc-toggle').onclick = toggle;
  container.querySelector('#tc-reset').onclick = reset;
  container.querySelector('#tc-mode').onclick = () => {
    const next = prefs.alarmMode === 'music' ? 'ring' : 'music';
    setPrefs({ alarmMode: next });
    declareSession('transient');   // 切替時点の宣言も揃えておく（次のaudible()でモードに応じて再宣言される）
    toast(next === 'music'
      ? '🎵 音楽優先: 音楽は止まりません（マナーモードでは鳴りません）'
      : '🔔 必ず鳴る: マナーモードでも鳴ります（アラーム時は音楽が一時停止）');
  };
  updateUI();
}

// セット入力シート用の休憩ストリップ（残り時間＋操作）を描画する
export function mountStrip(container) {
  container.innerHTML = `
    <div class="rest-strip" hidden>
      <span class="rs-label">⏱ 休憩</span>
      <b id="ts-time"></b>
      <button class="chip" data-adj="30">＋30秒</button>
      <button class="chip" id="ts-toggle"></button>
    </div>`;
  stripEl = container.querySelector('.rest-strip');
  stripEl.querySelector('[data-adj]').onclick = () => adjust(30);
  stripEl.querySelector('#ts-toggle').onclick = toggle;
  updateUI();
}
