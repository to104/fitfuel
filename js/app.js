// ============================================================
// app.js — アプリ本体
// 起動処理・タブ切り替え・初期データ投入・Service Worker登録
// ※更新時は APP_VER と sw.js の CACHE 名を両方上げること
// ============================================================
import * as db from './db.js';
import { todayStr } from './ui.js';
import * as home from './views/home.js';
import * as meals from './views/meals.js';
import * as train from './views/train.js';
import * as log from './views/log.js';
import * as settings from './views/settings.js';
import * as onboarding from './views/onboarding.js';

export const APP_VER = '1.1.0';

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

// いま開いている画面を描き直す（データ変更後に呼ぶ）
export async function refresh() {
  document.querySelectorAll('.tabbar button').forEach(b =>
    b.classList.toggle('on', b.dataset.tab === state.tab));
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

  // 下部タブのイベント
  document.querySelectorAll('.tabbar button').forEach(b => b.onclick = () => {
    // 食事・トレのタブを押したときは「今日」に戻す
    if (b.dataset.tab !== state.tab && (b.dataset.tab === 'meals' || b.dataset.tab === 'train')) {
      state.date = todayStr();
    }
    setTab(b.dataset.tab);
  });

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
    navigator.serviceWorker.register('./sw.js').catch(() => { /* http環境では失敗してよい */ });
  }
}

init();
