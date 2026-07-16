// ============================================================
// views/chat.js — AIチャット相談（AIトレーナーとの会話画面）
// ・会話履歴は settingsストア 'chatLog' に保存（同期・バックアップ対象）
// ・AIへ送るのは直近10往復まで。超えるときはユーザーに確認し、
//   「要約して続ける」or「新しい会話」を選んでもらう
// ・返信と同時にAIが抽出した事実をメモリーノート（aiNotes）へ保存
// ============================================================
import * as db from '../db.js';
import * as ai from '../ai.js';
import * as coach from '../coach.js';
import { esc, openSheet, closeSheet, toast } from '../ui.js';
import { setTab } from '../app.js';

const MAX_PAIRS = 10;   // AIへ送る上限（往復数）
const KEEP_PAIRS = 3;   // 要約圧縮時に生のまま残す直近の往復数

const EMPTY_LOG = { messages: [], summary: '' };
async function getLog() {
  const log = await db.getSetting('chatLog', null);
  return log && Array.isArray(log.messages) ? { ...EMPTY_LOG, ...log } : { ...EMPTY_LOG };
}
async function saveLog(log) {
  await db.setSetting('chatLog', log);
}

// 往復数 = ユーザー発言の数（1往復はユーザー→AIの組）
const pairCount = (log) => log.messages.filter(m => m.role === 'user').length;

let sending = false;   // 送信中フラグ（画面を離れても多重送信しないようモジュールに持つ）

export async function render(root) {
  const url = await ai.getWorkerUrl();

  root.innerHTML = `
    <div class="coach-scr chat-scr">
      <header class="coach-head">
        <button class="icon-btn" id="ch-back" aria-label="AIトレーナーへ戻る">‹</button>
        <h1 class="coach-title">AIチャット相談</h1>
        <button class="icon-btn" id="ch-new" aria-label="新しい会話を始める" title="新しい会話">⟳</button>
      </header>
      ${url ? `
      <div class="chat-msgs" id="ch-msgs"></div>
      <div class="chat-bar">
        <textarea id="ch-in" rows="1" placeholder="トレーニングや食事のことを相談" enterkeyhint="send"></textarea>
        <button class="chat-send" id="ch-send" aria-label="送信">↑</button>
      </div>` : `
      <div class="card empty-card">AIチャットを使うには、設定 →「AI連携（Claude）」でWorker URLを登録してください。</div>`}
    </div>`;

  root.querySelector('#ch-back').onclick = () => setTab('coach');
  if (!url) {
    root.querySelector('#ch-new').hidden = true;
    return;
  }

  const log = await getLog();
  const msgsEl = root.querySelector('#ch-msgs');
  const input = root.querySelector('#ch-in');
  const sendBtn = root.querySelector('#ch-send');

  // ---- メッセージ一覧の描画 ----
  const bubble = (m) => `
    <div class="chat-b ${m.role === 'user' ? 'user' : 'ai'}">${esc(m.text)}</div>
    ${m.notes?.length ? m.notes.map(t => `<div class="chat-note">📝 覚えました: ${esc(t)}</div>`).join('') : ''}`;

  const draw = ({ typing = '' } = {}) => {
    msgsEl.innerHTML = `
      ${log.summary ? '<div class="chat-sysline">これまでの会話は要約して引き継いでいます</div>' : ''}
      ${log.messages.length ? '' : bubble({ role: 'assistant', text: 'こんにちは！AIトレーナーです。\nトレーニングのやり方・メニュー・食事や栄養のことなど、何でも聞いてください。記録データを見ながら答えます。' })}
      ${log.messages.map(bubble).join('')}
      ${typing ? `<div class="chat-b ai chat-typing">${esc(typing)}</div>` : ''}
      ${!typing && log.messages.length && log.messages[log.messages.length - 1].role === 'user'
        ? '<button class="btn-ghost chat-retry" id="ch-retry">↻ 返信をもう一度取得する</button>' : ''}`;
    const retry = msgsEl.querySelector('#ch-retry');
    if (retry) retry.onclick = () => requestReply();
    // 最新メッセージまでスクロール
    requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight));
  };

  // ---- AIへ返信を依頼（履歴の最後がユーザー発言の状態で呼ぶ） ----
  const requestReply = async () => {
    if (sending) return;
    sending = true;
    sendBtn.disabled = true;
    draw({ typing: '考え中…' });
    try {
      const [context, notes] = await Promise.all([coach.buildChatContext(), ai.notesText()]);
      const res = await ai.chat({
        messages: log.messages.slice(-MAX_PAIRS * 2).map(m => ({ role: m.role, text: m.text })),
        context,
        notes,
        summary: log.summary || '',
      });
      // メモリーノートへ追記（重複はスキップ）→ 吹き出しの下に表示できるよう記録に持たせる
      const added = [];
      for (const t of res.new_notes || []) {
        if (await ai.addNote(t, 'ai')) added.push(t);
      }
      log.messages.push({ role: 'assistant', text: res.reply, ts: Date.now(), ...(added.length ? { notes: added } : {}) });
      await saveLog(log);
    } catch (err) {
      console.error(err);
      toast('返信を取得できませんでした: ' + err.message, 3500);
    }
    sending = false;
    sendBtn.disabled = false;
    draw();
  };

  // ---- 送信（10往復に達していたら先に確認シート） ----
  const send = async () => {
    const text = input.value.trim();
    if (!text || sending) return;
    if (!navigator.onLine) { toast('オフラインです。電波のある場所でお試しください'); return; }
    if (pairCount(log) >= MAX_PAIRS) { openLimitSheet(text); return; }
    input.value = '';
    input.style.height = '';
    log.messages.push({ role: 'user', text, ts: Date.now() });
    await saveLog(log);
    await requestReply();
  };

  sendBtn.onclick = send;
  // PCではEnterで送信（Shift+Enterで改行）。スマホのEnterは改行のまま
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(hover: hover)').matches) {
      e.preventDefault();
      send();
    }
  });
  // 入力欄の高さを内容に合わせる（最大4行程度）
  input.addEventListener('input', () => {
    input.style.height = '';
    input.style.height = Math.min(input.scrollHeight, 110) + 'px';
  });

  // ---- 10往復に達したときの選択シート ----
  const openLimitSheet = (pendingText) => {
    const body = openSheet('会話が長くなってきました', `
      <p class="hint" style="margin-top:0; font-size:13.5px">会話が${MAX_PAIRS}往復に達しました。このまま続けるとAIへ送るデータが増えていくため、続け方を選んでください。<br>どちらを選んでも、メモリーノート（覚えたこと）は消えません。</p>
      <button class="btn btn-big" id="cl-cont">このまま続ける（古い会話を要約して圧縮）</button>
      <button class="btn-ghost" id="cl-new">新しい会話を始める（履歴をリセット）</button>`);
    body.querySelector('#cl-cont').onclick = async (e) => {
      e.target.disabled = true;
      try {
        await compressLog();
        closeSheet();
        input.value = '';
        input.style.height = '';
        log.messages.push({ role: 'user', text: pendingText, ts: Date.now() });
        await saveLog(log);
        await requestReply();
      } catch (err) {
        console.error(err);
        e.target.disabled = false;
        toast('要約に失敗しました。もう一度お試しください: ' + err.message, 3500);
      }
    };
    body.querySelector('#cl-new').onclick = async () => {
      log.messages = [];
      log.summary = '';
      await saveLog(log);
      closeSheet();
      input.value = '';
      input.style.height = '';
      log.messages.push({ role: 'user', text: pendingText, ts: Date.now() });
      await saveLog(log);
      await requestReply();
    };
  };

  // 古い往復をAIに要約させて1つに圧縮し、直近KEEP_PAIRS往復だけ生のまま残す
  const compressLog = async () => {
    const userIdx = log.messages.map((m, i) => (m.role === 'user' ? i : -1)).filter(i => i >= 0);
    const cut = userIdx[Math.max(0, userIdx.length - KEEP_PAIRS)];
    const old = log.messages.slice(0, cut);
    if (!old.length) return;
    draw({ typing: '古い会話を要約中…' });
    const res = await ai.chatSummary(log.summary || '', old.map(m => ({ role: m.role, text: m.text })));
    log.summary = res.summary;
    log.messages = log.messages.slice(cut);
    await saveLog(log);
    draw();
  };

  // ---- ⟳ 新しい会話 ----
  root.querySelector('#ch-new').onclick = async () => {
    if (!log.messages.length && !log.summary) return;
    if (!confirm('新しい会話を始めますか？\n（今の会話履歴は消えます。メモリーノートに覚えたことは残ります）')) return;
    log.messages = [];
    log.summary = '';
    await saveLog(log);
    draw();
  };

  draw();
}
