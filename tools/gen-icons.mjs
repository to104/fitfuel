// ============================================================
// gen-icons.mjs — アプリアイコン生成スクリプト
// 外部ライブラリなしでPNGを直接生成する（黒地にオレンジのダンベル）
// 実行: node tools/gen-icons.mjs
// ============================================================
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- PNGエンコード（最小実装） ----
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width, height, rgba) {
  // 各行の先頭にフィルタ種別0を付ける
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- アイコン描画（Apple純正風） ----
// 深いグラファイトの縦グラデーション地に、オレンジグラデーションのダンベル。
// SDF（符号付き距離場＝図形の輪郭までの距離を計算する手法）で
// アンチエイリアス（輪郭のギザギザを滑らかにする処理）をかける。

// 角丸長方形のSDF: 中心(px,py)基準・半サイズ(hx,hy)・角丸r → 輪郭までの距離
function sdRRect(px, py, hx, hy, r) {
  const qx = Math.abs(px) - hx + r, qy = Math.abs(py) - hy + r;
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}
const clamp01 = (t) => Math.max(0, Math.min(1, t));
const lerp = (a, b, t) => [0, 1, 2].map(i => a[i] + (b[i] - a[i]) * t);

function drawIcon(S) {
  const img = Buffer.alloc(S * S * 4);
  const cx = S / 2, cy = S / 2;
  const k = S * 0.60;              // maskable対応: 図柄は中央60%に収める
  // 背景: 上#23232B → 下#0A0A0D（かすかな縦グラデーションで奥行きを出す）
  const bgTop = [35, 35, 43], bgBot = [10, 10, 13];
  // ダンベル: 上#FFB340 → 下#E0710A（Apple風の暖色グラデーション）
  const glTop = [255, 179, 64], glBot = [224, 113, 10];
  const aaW = Math.max(1, S / 180); // アンチエイリアス幅（サイズに比例）

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = Math.abs(x + 0.5 - cx);   // 左右対称なので|x|で判定
      const py = y + 0.5 - cy;
      // ダンベル = バー＋内プレート＋外プレート（角丸長方形3つの合成）
      const dBar = sdRRect(px, py, k * 0.46, k * 0.048, k * 0.048);
      const dIn  = sdRRect(px - k * 0.29, py, k * 0.070, k * 0.235, k * 0.060);
      const dOut = sdRRect(px - k * 0.44, py, k * 0.052, k * 0.160, k * 0.050);
      const d = Math.min(dBar, dIn, dOut);
      const cover = clamp01(0.5 - d / aaW);          // 輪郭で滑らかに0→1

      let col = lerp(bgTop, bgBot, y / S);           // 背景グラデーション
      if (cover > 0) {
        const t = clamp01((py + k * 0.235) / (k * 0.47));
        col = lerp(col, lerp(glTop, glBot, t), cover);
      }
      const o = (y * S + x) * 4;
      img[o] = Math.round(col[0]); img[o + 1] = Math.round(col[1]);
      img[o + 2] = Math.round(col[2]); img[o + 3] = 255;
    }
  }
  return png(S, S, img);
}

writeFileSync(join(OUT, 'icon-192.png'), drawIcon(192));
writeFileSync(join(OUT, 'icon-512.png'), drawIcon(512));
writeFileSync(join(OUT, 'apple-touch-icon.png'), drawIcon(180));
console.log('アイコンを生成しました: icon-192.png / icon-512.png / apple-touch-icon.png');
