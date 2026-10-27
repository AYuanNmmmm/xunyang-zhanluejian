// 用 Electron 的 nativeImage 把 build/icon.png 转成多尺寸 build/icon.ico
// （electron-builder 的 win 目标需要 .ico；macOS 只需 .icns，所以原包里没有）
const { app, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const SRC = path.join(__dirname, '..', 'build', 'icon.png');
const OUT = path.join(__dirname, '..', 'build', 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

app.whenReady().then(() => {
  const base = nativeImage.createFromPath(SRC);
  if (base.isEmpty()) { console.error('读不到 ' + SRC); app.exit(1); return; }

  // 每帧用 PNG 负载（Vista 起 Windows 支持 PNG 压缩的 ICO 条目）
  const frames = SIZES.map((s) => {
    const img = s === 256 ? base : base.resize({ width: s, height: s, quality: 'best' });
    return { size: s, data: img.toPNG() };
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type = icon
  header.writeUInt16LE(frames.length, 4);

  const entries = [];
  let offset = 6 + frames.length * 16;
  for (const f of frames) {
    const e = Buffer.alloc(16);
    e.writeUInt8(f.size >= 256 ? 0 : f.size, 0);  // 宽（0 表示 256）
    e.writeUInt8(f.size >= 256 ? 0 : f.size, 1);  // 高
    e.writeUInt8(0, 2);                           // 调色板数
    e.writeUInt8(0, 3);                           // reserved
    e.writeUInt16LE(1, 4);                        // planes
    e.writeUInt16LE(32, 6);                       // bpp
    e.writeUInt32LE(f.data.length, 8);            // 数据长度
    e.writeUInt32LE(offset, 12);                  // 数据偏移
    offset += f.data.length;
    entries.push(e);
  }

  const out = Buffer.concat([header, ...entries, ...frames.map((f) => f.data)]);
  fs.writeFileSync(OUT, out);
  console.log('已生成 ' + OUT + '，尺寸 ' + SIZES.join('/') + '，共 ' + out.length + ' 字节');
  app.exit(0);
});
