import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

function createPng(size) {
  // Simple PNG encoder
  const width = size;
  const height = size;
  const buffer = Buffer.alloc(height * (width * 4 + 1));

  let offset = 0;
  for (let y = 0; y < height; y++) {
    buffer[offset++] = 0; // Filter type 0 (None)
    for (let x = 0; x < width; x++) {
      // Rounded box with padding
      const pad = Math.max(1, Math.floor(size * 0.08));
      const radius = Math.floor(size * 0.22);
      const isInsideBox = x >= pad && x < width - pad && y >= pad && y < height - pad;

      if (isInsideBox) {
        // Gradient from #0284c7 (2, 132, 199) to #8b5cf6 (139, 92, 246)
        const t = (x + y) / (width + height);
        const r = Math.round(2 * (1 - t) + 139 * t);
        const g = Math.round(132 * (1 - t) + 92 * t);
        const b = Math.round(199 * (1 - t) + 246 * t);

        // Draw letter 'W' in white
        const nx = (x - pad) / (width - 2 * pad);
        const ny = (y - pad) / (height - 2 * pad);

        let isW = false;
        const wThick = 0.12;
        // 4 diagonal strokes of W: (0.15,0.25)->(0.35,0.75), (0.35,0.75)->(0.5,0.45), (0.5,0.45)->(0.65,0.75), (0.65,0.75)->(0.85,0.25)
        const distToSeg = (px, py, x1, y1, x2, y2) => {
          const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
          let t_seg = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
          t_seg = Math.max(0, Math.min(1, t_seg));
          return Math.hypot(px - (x1 + t_seg * (x2 - x1)), py - (y1 + t_seg * (y2 - y1)));
        };

        if (
          distToSeg(nx, ny, 0.2, 0.28, 0.35, 0.72) < wThick ||
          distToSeg(nx, ny, 0.35, 0.72, 0.5, 0.45) < wThick ||
          distToSeg(nx, ny, 0.5, 0.45, 0.65, 0.72) < wThick ||
          distToSeg(nx, ny, 0.65, 0.72, 0.8, 0.28) < wThick
        ) {
          isW = true;
        }

        if (isW) {
          buffer[offset++] = 255;
          buffer[offset++] = 255;
          buffer[offset++] = 255;
          buffer[offset++] = 255;
        } else {
          buffer[offset++] = r;
          buffer[offset++] = g;
          buffer[offset++] = b;
          buffer[offset++] = 255;
        }
      } else {
        buffer[offset++] = 0;
        buffer[offset++] = 0;
        buffer[offset++] = 0;
        buffer[offset++] = 0;
      }
    }
  }

  const deflated = zlib.deflateSync(buffer);

  function crc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i++) {
      let byte = buf[i];
      for (let j = 0; j < 8; j++) {
        const bit = (crc ^ byte) & 1;
        crc = (crc >>> 1) ^ (bit ? 0xedb88320 : 0);
        byte >>>= 1;
      }
    }
    return (crc ^ -1) >>> 0;
  }

  function makeChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    const toCrc = Buffer.concat([typeBuf, data]);
    crcBuf.writeUInt32BE(crc32(toCrc), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const ihdrChunk = makeChunk('IHDR', ihdr);
  const idatChunk = makeChunk('IDAT', deflated);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

const iconsDir = path.resolve('apps/extension/public/icons');
fs.mkdirSync(iconsDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const png = createPng(size);
  fs.writeFileSync(path.join(iconsDir, `icon-${size}.png`), png);
  console.log(`Generated icon-${size}.png (${png.length} bytes)`);
}
