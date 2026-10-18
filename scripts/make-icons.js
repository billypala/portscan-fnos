'use strict';
// 生成应用图标（无第三方依赖，手写最小 PNG 编码器）
// 输出 ICON.PNG(256) / ICON_256.PNG(256) / app/ui/images/icon_64.png / icon_128.png / icon_256.png
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.join(__dirname, '..');
const packDir = path.join(root, 'apps', 'portscan');
const imagesDir = path.join(packDir, 'app', 'ui', 'images');

// ---------- PNG 编码 ----------
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- 绘制 ----------
const BG_TOP = [0x3f, 0x7a, 0xf0];
const BG_BOTTOM = [0x2a, 0x55, 0xc4];
const FG = [0xff, 0xff, 0xff];

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

// 抗锯齿覆盖率：4x4 超采样
function coverage(px, py, sdf) {
  let hits = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      if (sdf(px + (sx + 0.5) / 4, py + (sy + 0.5) / 4)) hits++;
    }
  }
  return hits / 16;
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const S = size;
  const c = S / 2;
  const rOuter = S * 0.44;
  const ringW = Math.max(1.2, S * 0.055);
  const gap = Math.max(1, S * 0.028); // 右上缺口

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const i = (y * S + x) * 4;

      // 圆角方形底
      const half = S / 2;
      const rad = S * 0.22;
      const qx = Math.abs(px - half) - (half - rad);
      const qy = Math.abs(py - half) - (half - rad);
      const qd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;
      const covBg = qd <= 0 ? 1 : 0;

      if (covBg === 0) {
        rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = 0;
        continue;
      }

      const t = py / S;
      let color = mix(BG_TOP, BG_BOTTOM, t);
      let alpha = 255;

      // 雷达环：外圈 + 中圈 + 中心点
      const dx = px - c;
      const dy = py - c;
      const dist = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx); // -PI..PI, 0 = 右

      // 右上缺口：以 45 度为中心，宽 gap 弧度
      const gapCenter = -Math.PI / 4;
      let da = ang - gapCenter;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      const inGap = Math.abs(da) < (gap / Math.max(rOuter, 1)) * 1.6;

      const ringOuter = Math.abs(dist - rOuter) <= ringW / 2;
      const ringMid = Math.abs(dist - rOuter * 0.62) <= ringW / 2.4;
      const dot = dist <= S * 0.075;

      if (!inGap && (ringOuter || ringMid || dot)) {
        color = FG;
      }

      // 扫描扇形（从中心指向左下，深一点的白）
      const scanAng = Math.PI * 0.75;
      let dsa = ang - scanAng;
      while (dsa > Math.PI) dsa -= Math.PI * 2;
      while (dsa < -Math.PI) dsa += Math.PI * 2;
      if (dist > S * 0.075 && dist < rOuter - ringW / 2 && Math.abs(dsa) < 0.16) {
        color = mix(color, FG, 0.55);
      }

      rgba[i] = color[0];
      rgba[i + 1] = color[1];
      rgba[i + 2] = color[2];
      rgba[i + 3] = alpha;
    }
  }

  return encodePng(S, S, rgba);
}

// ---------- 输出 ----------
fs.mkdirSync(imagesDir, { recursive: true });

const targets = [
  [64, path.join(imagesDir, 'icon_64.png')],
  [128, path.join(imagesDir, 'icon_128.png')],
  [256, path.join(imagesDir, 'icon_256.png')],
  [256, path.join(packDir, 'ICON.PNG')],
  [256, path.join(packDir, 'ICON_256.PNG')]
];

for (const [size, out] of targets) {
  const buf = drawIcon(size);
  fs.writeFileSync(out, buf);
  console.log(`[icon] ${path.relative(root, out)} (${size}x${size}, ${buf.length} bytes)`);
}
