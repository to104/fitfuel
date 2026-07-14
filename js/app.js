// ============================================================
// app.js — アプリ本体
// 起動処理・タブ切り替え・初期データ投入・Service Worker登録
// ※更新時は APP_VER と sw.js の CACHE 名を両方上げること
// ============================================================
import * as db from './db.js';
import { todayStr, addDays } from './ui.js';
import { initTimer } from './timer.js';
import * as home from './views/home.js';
import * as meals from './views/meals.js';
import * as train from './views/train.js';
import * as log from './views/log.js';
import * as settings from './views/settings.js';
import * as onboarding from './views/onboarding.js';
import { initSync } from './sync.js';

export const APP_VER = '1.14.0';

// アプリ全体で共有する状態（いま開いているタブ・日付など）
export const state = {
  tab: 'home',
  date: todayStr(),   // 食事・トレ画面が表示している日付
};

const VIEWS = { home, meals, train, log, settings };

// タブを切り替える
export function setTab(tab) {
  state.tab = tab;
  window.scrollTo(0, 0);
  refresh();
}

// 表示中の日付を前後に動かす（n=+1で翌日、-1で前日）。矢印ボタンとスワイプで共用
export function changeDay(n) {
  state.date = addDays(state.date, n);
  const view = document.getElementById('view');
  view.classList.remove('slide-next', 'slide-prev');
  void view.offsetWidth;   // 連続で動かしてもアニメーションを再生し直すための再計算
  view.classList.add(n > 0 ? 'slide-next' : 'slide-prev');
  window.scrollTo(0, 0);
  refresh();
}

// 左右スワイプで日付を前後させる（ホーム・食事・トレ画面のみ）
const SWIPE_TABS = ['home', 'meals', 'train'];
function initSwipeNav() {
  const view = document.getElementById('view');
  let sx = 0, sy = 0, active = false;
  view.addEventListener('touchstart', (e) => {
    active = false;
    if (!SWIPE_TABS.includes(state.tab)) return;
    if (e.touches.length !== 1) return;
    // 初回設定（オンボーディング）中は無効
    if (document.querySelector('.tabbar').style.display === 'none') return;
    // スライダー・入力欄の上から始まった横操作は日付切り替えにしない
    if (e.target.closest('input, select, textarea')) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    active = true;
  }, { passive: true });
  view.addEventListener('touchend', (e) => {
    if (!active) return;
    active = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    // 横に56px以上、かつ縦の1.6倍以上動いたときだけ切り替える（縦スクロールと区別）
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
    changeDay(dx < 0 ? 1 : -1);   // 左へスワイプ=翌日 / 右へスワイプ=前日
  }, { passive: true });
}

// いま開いている画面を描き直す（データ変更後に呼ぶ）
export async function refresh() {
  document.querySelectorAll('.tabbar button').forEach(b =>
    b.classList.toggle('on', b.dataset.tab === state.tab));
  // トレ画面だけオレンジの明るさ設定を反映し、他の画面では標準色に戻す
  await train.applyAccent(state.tab === 'train');
  try {
    await VIEWS[state.tab].render(document.getElementById('view'));
  } catch (err) {
    console.error(err);
    document.getElementById('view').innerHTML =
      `<div class="card empty-card">画面の表示に失敗しました。<br>原因: ${err.message}<br>解決策: 再読み込みしてください。</div>`;
  }
}

// 初回起動時にトレ種目とサプリの定番を登録しておく
async function seed() {
  if (await db.getSetting('seeded')) return;
  const EX = [
    ['ベンチプレス', '胸'], ['ダンベルプレス', '胸'], ['スクワット', '脚'],
    ['レッグプレス', '脚'], ['デッドリフト', '背中'], ['ラットプルダウン', '背中'],
    ['懸垂', '背中'], ['ショルダープレス', '肩'], ['サイドレイズ', '肩'], ['アームカール', '腕'],
  ];
  for (const [name, part] of EX) await db.put('exercises', { name, part });
  for (const name of ['プロテイン', 'クレアチン', 'EAA', 'マルチビタミン'])
    await db.put('supplements', { name });
  await db.setSetting('seeded', true);
}

async function init() {
  await db.openDB();
  await seed();
  // クラウド同期の初期化（変更検知の登録・同期オンなら起動時に自動取り込み）。
  // seed()の後に登録することで、初期データ投入を「未送信の変更」として扱わない
  // （新しい端末で同期をオンにしたとき、クラウド側を正しく取り込めるようにするため）
  initSync();
  // 休憩タイマー（前回カウント中に閉じた場合はここで自動再開する）
  await initTimer({ onOpenTrain: () => { state.date = todayStr(); setTab('train'); } });

  // 下部タブのイベント
  document.querySelectorAll('.tabbar button').forEach(b => b.onclick = () => {
    // ホーム・食事・トレのタブを押したときは「今日」に戻す
    if (b.dataset.tab !== state.tab && SWIPE_TABS.includes(b.dataset.tab)) {
      state.date = todayStr();
    }
    setTab(b.dataset.tab);
  });

  // 左右スワイプで日付移動
  initSwipeNav();

  // 初回はオンボーディング（目標設定）から
  if (!(await db.getSetting('onboarded', false))) {
    document.querySelector('.tabbar').style.display = 'none';
    onboarding.render(document.getElementById('view'), () => {
      document.querySelector('.tabbar').style.display = '';
      setTab('home');
    });
  } else {
    refresh();
  }

  // Service Worker（オフライン対応）
  if ('serviceWorker' in navigator) {
    // 既にSWが動いている状態で新バージョンに切り替わったら、画面を自動で再読み込みする
    // （従来の「2回リロード」を不要にする。初回インストール時は対象外）
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      location.reload();
    });
    navigator.serviceWorker.register('./sw.js').catch(() => { /* http環境では失敗してよい */ });
  }
}

init();
