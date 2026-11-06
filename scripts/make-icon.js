// Genera build/icon.ico disegnando il logo (stessa geometria di public/logo.svg).
// Nessuna dipendenza: rasterizza a mano e codifica PNG con zlib.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ACCENT = [0xff, 0x4a, 0x2e];
const DARK = [0x10, 0x11, 0x13];

// geometria nel sistema 64x64 del logo
function inTriangle(x, y) {
  const [ax, ay, bx, by, cx, cy] = [15, 14, 49, 14, 32, 42];
  const d = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = d(x, y, ax, ay, bx, by);
  const d2 = d(x, y, bx, by, cx, cy);
  const d3 = d(x, y, cx, cy, ax, ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
const inBar = (x, y) => x >= 15 && x <= 49 && y >= 48 && y <= 54;

function render(size) {
  const SS = 4; // supersampling per bordi lisci
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let dark = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px + (sx + 0.5) / SS) / size) * 64;
          const y = ((py + (sy + 0.5) / SS) / size) * 64;
          if (inTriangle(x, y) || inBar(x, y)) dark++;
        }
      }
      const t = dark / (SS * SS);
      const o = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) rgba[o + c] = Math.round(ACCENT[c] * (1 - t) + DARK[c] * t);
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filtro: nessuno
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeIco(sizes) {
  const images = sizes.map((s) => png(s, render(s)));
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2); // tipo: icona
  head.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const entries = sizes.map((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s;
    e[1] = s >= 256 ? 0 : s;
    e.writeUInt16LE(1, 4); // piani
    e.writeUInt16LE(32, 6); // bit per pixel
    e.writeUInt32LE(images[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += images[i].length;
    return e;
  });
  return Buffer.concat([head, ...entries, ...images]);
}

const out = path.join(__dirname, '..', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, makeIco([16, 24, 32, 48, 64, 128, 256]));
console.log(`Icona scritta in ${out}`);
