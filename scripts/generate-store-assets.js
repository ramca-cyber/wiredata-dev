/**
 * generate-store-assets.js
 * Generates all Chrome Web Store graphic assets:
 *  - store-assets/icon-128.png          (already in public/icons, copied here for convenience)
 *  - store-assets/screenshot-1-datasets.png    1280x800
 *  - store-assets/screenshot-2-sql.png         1280x800
 *  - store-assets/screenshot-3-sidepanel.png   1280x800
 *  - store-assets/screenshot-4-candidates.png  1280x800
 *  - store-assets/promo-small.png              440x280
 *  - store-assets/promo-marquee.png            1400x560
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const OUT = path.resolve('store-assets');
fs.mkdirSync(OUT, { recursive: true });

// ─── Minimal PNG encoder ─────────────────────────────────────────────────────

function crc32(buf) {
  let c = -1;
  for (const b of buf) for (let i = 0; i < 8; i++) c = (c & 1) ? (c >>> 1) ^ 0xedb88320 : c >>> 1, c ^= (i === 0 ? b : 0);
  // redo properly
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([t, d])));
  return Buffer.concat([len, t, d, crcBuf]);
}

function encodePng(width, height, getPixel) {
  // getPixel(x,y) => [r,g,b,a]
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(width * 4 + 1);
    row[0] = 0; // filter None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixel(x, y);
      row[1 + x * 4] = r & 0xff;
      row[2 + x * 4] = g & 0xff;
      row[3 + x * 4] = b & 0xff;
      row[4 + x * 4] = a & 0xff;
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows);
  const deflated = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflated),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Color helpers ────────────────────────────────────────────────────────────

const BG_DARK     = [15, 17, 22];        // #0f1116
const BG_PANEL    = [22, 27, 34];        // #161b22
const BG_SIDEBAR  = [13, 17, 23];        // #0d1117
const BG_HEADER   = [30, 37, 47];        // #1e252f
const BG_ROW_ALT  = [19, 24, 31];        // #13181f
const BG_ROW      = [22, 27, 34];        // #161b22
const ACCENT_BLUE = [2, 132, 199];       // #0284c7
const ACCENT_PURP = [139, 92, 246];      // #8b5cf6
const ACCENT_CYAN = [6, 182, 212];       // #06b6d4
const TEXT_WHITE  = [241, 245, 249];     // #f1f5f9
const TEXT_DIM    = [100, 116, 139];     // #64748b
const TEXT_GRAY   = [148, 163, 184];     // #94a3b8
const GREEN       = [34, 197, 94];       // #22c55e
const RED         = [239, 68, 68];       // #ef4444
const AMBER       = [245, 158, 11];      // #f59e0b
const BORDER      = [30, 41, 59];        // #1e293b

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
function lerpColor(c1, c2, t) { return [lerp(c1[0],c2[0],t), lerp(c1[1],c2[1],t), lerp(c1[2],c2[2],t)]; }
function gradient(x, y, w, h, c1, c2) {
  const t = (x / w + y / h) / 2;
  return lerpColor(c1, c2, t);
}

function fillRect(pixels, W, x, y, w, h, [r,g,b,a=255]) {
  for (let py = y; py < y+h && py < pixels.length/W/4; py++) {
    for (let px = x; px < x+w && px < W; px++) {
      const i = (py * W + px) * 4;
      pixels[i]=r; pixels[i+1]=g; pixels[i+2]=b; pixels[i+3]=a;
    }
  }
}

function fillGradientH(pixels, W, x, y, w, h, c1, c2) {
  for (let py = y; py < y+h; py++) {
    for (let px = x; px < x+w && px < W; px++) {
      const t = (px - x) / w;
      const [r,g,b] = lerpColor(c1, c2, t);
      const i = (py * W + px) * 4;
      pixels[i]=r; pixels[i+1]=g; pixels[i+2]=b; pixels[i+3]=255;
    }
  }
}

function drawText(pixels, W, H, tx, ty, text, color, scale=1) {
  // 5x7 pixel font bitmaps for printable ASCII
  const FONT = {
    ' ': [0,0,0,0,0,0,0],
    'A': [0b01110,0b10001,0b10001,0b11111,0b10001,0b10001,0b10001],
    'B': [0b11110,0b10001,0b10001,0b11110,0b10001,0b10001,0b11110],
    'C': [0b01110,0b10001,0b10000,0b10000,0b10000,0b10001,0b01110],
    'D': [0b11100,0b10010,0b10001,0b10001,0b10001,0b10010,0b11100],
    'E': [0b11111,0b10000,0b10000,0b11110,0b10000,0b10000,0b11111],
    'F': [0b11111,0b10000,0b10000,0b11110,0b10000,0b10000,0b10000],
    'G': [0b01110,0b10001,0b10000,0b10111,0b10001,0b10001,0b01111],
    'H': [0b10001,0b10001,0b10001,0b11111,0b10001,0b10001,0b10001],
    'I': [0b11111,0b00100,0b00100,0b00100,0b00100,0b00100,0b11111],
    'J': [0b11111,0b00010,0b00010,0b00010,0b00010,0b10010,0b01100],
    'K': [0b10001,0b10010,0b10100,0b11000,0b10100,0b10010,0b10001],
    'L': [0b10000,0b10000,0b10000,0b10000,0b10000,0b10000,0b11111],
    'M': [0b10001,0b11011,0b10101,0b10001,0b10001,0b10001,0b10001],
    'N': [0b10001,0b11001,0b10101,0b10011,0b10001,0b10001,0b10001],
    'O': [0b01110,0b10001,0b10001,0b10001,0b10001,0b10001,0b01110],
    'P': [0b11110,0b10001,0b10001,0b11110,0b10000,0b10000,0b10000],
    'Q': [0b01110,0b10001,0b10001,0b10001,0b10101,0b10010,0b01101],
    'R': [0b11110,0b10001,0b10001,0b11110,0b10100,0b10010,0b10001],
    'S': [0b01111,0b10000,0b10000,0b01110,0b00001,0b00001,0b11110],
    'T': [0b11111,0b00100,0b00100,0b00100,0b00100,0b00100,0b00100],
    'U': [0b10001,0b10001,0b10001,0b10001,0b10001,0b10001,0b01110],
    'V': [0b10001,0b10001,0b10001,0b10001,0b10001,0b01010,0b00100],
    'W': [0b10001,0b10001,0b10001,0b10101,0b10101,0b11011,0b10001],
    'X': [0b10001,0b10001,0b01010,0b00100,0b01010,0b10001,0b10001],
    'Y': [0b10001,0b10001,0b01010,0b00100,0b00100,0b00100,0b00100],
    'Z': [0b11111,0b00001,0b00010,0b00100,0b01000,0b10000,0b11111],
    'a': [0,0,0b01110,0b00001,0b01111,0b10001,0b01111],
    'b': [0b10000,0b10000,0b11110,0b10001,0b10001,0b10001,0b11110],
    'c': [0,0,0b01110,0b10000,0b10000,0b10001,0b01110],
    'd': [0b00001,0b00001,0b01111,0b10001,0b10001,0b10001,0b01111],
    'e': [0,0,0b01110,0b10001,0b11111,0b10000,0b01111],
    'f': [0b00110,0b01001,0b01000,0b11100,0b01000,0b01000,0b01000],
    'g': [0,0,0b01111,0b10001,0b01111,0b00001,0b01110],
    'h': [0b10000,0b10000,0b11110,0b10001,0b10001,0b10001,0b10001],
    'i': [0b00100,0,0b01100,0b00100,0b00100,0b00100,0b01110],
    'j': [0b00010,0,0b00110,0b00010,0b00010,0b10010,0b01100],
    'k': [0b10000,0b10000,0b10010,0b10100,0b11000,0b10100,0b10010],
    'l': [0b01100,0b00100,0b00100,0b00100,0b00100,0b00100,0b01110],
    'm': [0,0,0b11010,0b10101,0b10101,0b10101,0b10001],
    'n': [0,0,0b11110,0b10001,0b10001,0b10001,0b10001],
    'o': [0,0,0b01110,0b10001,0b10001,0b10001,0b01110],
    'p': [0,0,0b11110,0b10001,0b11110,0b10000,0b10000],
    'q': [0,0,0b01111,0b10001,0b01111,0b00001,0b00001],
    'r': [0,0,0b01110,0b10000,0b10000,0b10000,0b10000],
    's': [0,0,0b01111,0b10000,0b01110,0b00001,0b11110],
    't': [0b01000,0b01000,0b11100,0b01000,0b01000,0b01001,0b00110],
    'u': [0,0,0b10001,0b10001,0b10001,0b10011,0b01101],
    'v': [0,0,0b10001,0b10001,0b10001,0b01010,0b00100],
    'w': [0,0,0b10001,0b10001,0b10101,0b10101,0b01010],
    'x': [0,0,0b10001,0b01010,0b00100,0b01010,0b10001],
    'y': [0,0,0b10001,0b10001,0b01111,0b00001,0b01110],
    'z': [0,0,0b11111,0b00010,0b00100,0b01000,0b11111],
    '0': [0b01110,0b10011,0b10101,0b10101,0b11001,0b10001,0b01110],
    '1': [0b00100,0b01100,0b00100,0b00100,0b00100,0b00100,0b01110],
    '2': [0b01110,0b10001,0b00001,0b00110,0b01000,0b10000,0b11111],
    '3': [0b11111,0b00010,0b00100,0b00110,0b00001,0b10001,0b01110],
    '4': [0b00010,0b00110,0b01010,0b10010,0b11111,0b00010,0b00010],
    '5': [0b11111,0b10000,0b11110,0b00001,0b00001,0b10001,0b01110],
    '6': [0b00110,0b01000,0b10000,0b11110,0b10001,0b10001,0b01110],
    '7': [0b11111,0b00001,0b00010,0b00100,0b01000,0b01000,0b01000],
    '8': [0b01110,0b10001,0b10001,0b01110,0b10001,0b10001,0b01110],
    '9': [0b01110,0b10001,0b10001,0b01111,0b00001,0b00010,0b01100],
    '.': [0,0,0,0,0,0b00100,0b00100],
    ',': [0,0,0,0,0,0b00100,0b01000],
    ':': [0,0b00100,0b00100,0,0b00100,0b00100,0],
    ';': [0,0b00100,0b00100,0,0b00100,0b00100,0b01000],
    '-': [0,0,0,0b11111,0,0,0],
    '_': [0,0,0,0,0,0,0b11111],
    '/': [0b00001,0b00010,0b00100,0b01000,0b10000,0,0],
    '(': [0b00100,0b01000,0b10000,0b10000,0b10000,0b01000,0b00100],
    ')': [0b00100,0b00010,0b00001,0b00001,0b00001,0b00010,0b00100],
    '*': [0,0b10001,0b01010,0b11111,0b01010,0b10001,0],
    '#': [0b01010,0b01010,0b11111,0b01010,0b11111,0b01010,0b01010],
    '·': [0,0,0,0b00100,0,0,0],
    '|': [0b00100,0b00100,0b00100,0b00100,0b00100,0b00100,0b00100],
    '>': [0b10000,0b01000,0b00100,0b00010,0b00100,0b01000,0b10000],
    '<': [0b00001,0b00010,0b00100,0b01000,0b00100,0b00010,0b00001],
    '=': [0,0,0b11111,0,0b11111,0,0],
    '!': [0b00100,0b00100,0b00100,0b00100,0,0,0b00100],
    '?': [0b01110,0b10001,0b00001,0b00110,0b00100,0,0b00100],
    '"': [0b01010,0b01010,0b01010,0,0,0,0],
    "'": [0b00100,0b00100,0b01000,0,0,0,0],
    '+': [0,0b00100,0b00100,0b11111,0b00100,0b00100,0],
    '%': [0b11000,0b11001,0b00010,0b00100,0b01000,0b10011,0b00011],
    '$': [0b00100,0b01111,0b10100,0b01110,0b00101,0b11110,0b00100],
    '@': [0b01110,0b10001,0b10111,0b10101,0b10111,0b10000,0b01111],
    '[': [0b01110,0b01000,0b01000,0b01000,0b01000,0b01000,0b01110],
    ']': [0b01110,0b00010,0b00010,0b00010,0b00010,0b00010,0b01110],
    '{': [0b00110,0b01000,0b01000,0b11000,0b01000,0b01000,0b00110],
    '}': [0b01100,0b00010,0b00010,0b00011,0b00010,0b00010,0b01100],
    '\\': [0b10000,0b01000,0b00100,0b00010,0b00001,0,0],
    '^': [0b00100,0b01010,0b10001,0,0,0,0],
    '~': [0,0,0b01000,0b10101,0b00010,0,0],
  };

  const [fr,fg,fb] = color;
  const charW = 5 * scale;
  const charH = 7 * scale;
  const spacing = 1 * scale;

  for (let ci = 0; ci < text.length; ci++) {
    const ch = text[ci];
    const bitmap = FONT[ch] || FONT['?'];
    const cx = tx + ci * (charW + spacing);
    for (let row = 0; row < 7; row++) {
      const bits = bitmap[row] || 0;
      for (let col = 0; col < 5; col++) {
        if (bits & (1 << (4 - col))) {
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              const px = cx + col * scale + sx;
              const py = ty + row * scale + sy;
              if (px >= 0 && px < W && py >= 0 && py < H) {
                const i = (py * W + px) * 4;
                pixels[i] = fr; pixels[i+1] = fg; pixels[i+2] = fb; pixels[i+3] = 255;
              }
            }
          }
        }
      }
    }
  }
}

function textWidth(text, scale=1) { return text.length * (5 * scale + scale); }

// ─── Drawing helpers ──────────────────────────────────────────────────────────

function drawLine(pixels, W, H, x1, y1, x2, y2, color) {
  const [r,g,b] = color;
  const dx = Math.abs(x2-x1), dy = Math.abs(y2-y1);
  const sx = x1<x2?1:-1, sy = y1<y2?1:-1;
  let err = dx-dy;
  let cx=x1, cy=y1;
  while(true) {
    if(cx>=0&&cx<W&&cy>=0&&cy<H){const i=(cy*W+cx)*4;pixels[i]=r;pixels[i+1]=g;pixels[i+2]=b;pixels[i+3]=255;}
    if(cx===x2&&cy===y2) break;
    const e2=2*err;
    if(e2>-dy){err-=dy;cx+=sx;}
    if(e2<dx){err+=dx;cy+=sy;}
  }
}

function drawCircle(pixels, W, H, cx, cy, radius, color) {
  const [r,g,b] = color;
  for(let y=cy-radius; y<=cy+radius; y++) {
    for(let x=cx-radius; x<=cx+radius; x++) {
      if((x-cx)**2+(y-cy)**2 <= radius*radius && x>=0&&x<W&&y>=0&&y<H) {
        const i=(y*W+x)*4;pixels[i]=r;pixels[i+1]=g;pixels[i+2]=b;pixels[i+3]=255;
      }
    }
  }
}

// ─── Shared UI Components ────────────────────────────────────────────────────

function drawTopBar(pixels, W, H, title) {
  // gradient header bar
  for(let y=0;y<48;y++) for(let x=0;x<W;x++) {
    const t = x/W;
    const [r,g,b] = lerpColor(ACCENT_BLUE, ACCENT_PURP, t);
    const dim = 0.15;
    const i=(y*W+x)*4;
    pixels[i]=Math.round(r*dim+BG_HEADER[0]*(1-dim));
    pixels[i+1]=Math.round(g*dim+BG_HEADER[1]*(1-dim));
    pixels[i+2]=Math.round(b*dim+BG_HEADER[2]*(1-dim));
    pixels[i+3]=255;
  }
  // bottom border
  for(let x=0;x<W;x++){const i=(47*W+x)*4;pixels[i]=ACCENT_BLUE[0];pixels[i+1]=ACCENT_BLUE[1];pixels[i+2]=ACCENT_BLUE[2];pixels[i+3]=255;}
  // logo W glyph at left
  fillRect(pixels, W, 12, 11, 26, 26, [...lerpColor(ACCENT_BLUE, ACCENT_PURP, 0.5), 255]);
  drawText(pixels, W, H, 14, 14, 'W', TEXT_WHITE, 3);
  // App name
  drawText(pixels, W, H, 48, 17, 'WireData', TEXT_WHITE, 2);
  drawText(pixels, W, H, 48+textWidth('WireData',2)+6, 20, title, TEXT_DIM, 1);
}

function drawSidebar(pixels, W, H, activeItem) {
  const items = ['Datasets','Candidates','SQL','Lineage','Export'];
  const icons = ['=','*','#','>','+'];
  fillRect(pixels, W, 0, 48, 60, H-48, BG_SIDEBAR);
  // border right
  for(let y=48;y<H;y++){const i=(y*W+59)*4;pixels[i]=BORDER[0];pixels[i+1]=BORDER[1];pixels[i+2]=BORDER[2];pixels[i+3]=255;}
  items.forEach((item, idx) => {
    const y = 68 + idx * 44;
    const isActive = item === activeItem;
    if(isActive) fillRect(pixels, W, 0, y-6, 60, 36, [...ACCENT_BLUE.map(c=>Math.round(c*0.2+BG_SIDEBAR[0]*0.8)), 255]);
    const iconColor = isActive ? ACCENT_BLUE : TEXT_DIM;
    drawText(pixels, W, H, 22, y, icons[idx], iconColor, 2);
  });
}

function drawStatusBadge(pixels, W, H, x, y, label, color) {
  fillRect(pixels, W, x, y, textWidth(label,1)+8, 14, [...color.map(c=>Math.round(c*0.15)), 200]);
  drawText(pixels, W, H, x+4, y+4, label, color, 1);
}

// ─── Screenshot 1: Datasets Table ────────────────────────────────────────────

function makeScreenshot1() {
  const W=1280, H=800;
  const pixels = new Uint8Array(W*H*4);

  // background
  pixels.fill(0);
  for(let i=0;i<W*H*4;i+=4){pixels[i]=BG_DARK[0];pixels[i+1]=BG_DARK[1];pixels[i+2]=BG_DARK[2];pixels[i+3]=255;}

  drawTopBar(pixels, W, H, 'Workbench');
  drawSidebar(pixels, W, H, 'Datasets');

  const MX = 68, MY = 48;

  // Dataset header bar
  fillRect(pixels, W, MX, MY, W-MX, 40, BG_HEADER);
  for(let x=MX;x<W;x++){const i=(MY+39)*W*4+x*4;pixels[i]=BORDER[0];pixels[i+1]=BORDER[1];pixels[i+2]=BORDER[2];pixels[i+3]=255;}
  drawText(pixels, W, H, MX+10, MY+14, 'orders', TEXT_WHITE, 2);
  drawText(pixels, W, H, MX+10+textWidth('orders',2)+10, MY+18, '300 rows  9 columns  1 snapshot', TEXT_DIM, 1);

  // Column headers
  const cols = ['id','customer_id','status','total','created_at','customer__name','city','country'];
  const colW = Math.floor((W - MX) / cols.length);
  fillRect(pixels, W, MX, MY+40, W-MX, 28, BG_PANEL);
  for(let x=MX;x<W;x++){const i=((MY+67)*W+x)*4;pixels[i]=BORDER[0];pixels[i+1]=BORDER[1];pixels[i+2]=BORDER[2];pixels[i+3]=255;}
  cols.forEach((col, ci) => {
    drawText(pixels, W, H, MX + ci * colW + 8, MY+53, col, ACCENT_CYAN, 1);
    if(ci > 0) for(let y=MY+40;y<H;y++){const x=MX+ci*colW;if(x<W){const i=(y*W+x)*4;pixels[i]=BORDER[0];pixels[i+1]=BORDER[1];pixels[i+2]=BORDER[2];pixels[i+3]=255;}}
  });

  // Data rows
  const statuses = ['pending','completed','failed','completed','pending'];
  const statusColors = {'pending': AMBER, 'completed': GREEN, 'failed': RED};
  const rowData = [
    ['1','1042','pending','89.50','2026-08-01','Alice Chen','Seattle','US'],
    ['2','1078','completed','142.00','2026-08-01','Bob Tanaka','Tokyo','JP'],
    ['3','1091','failed','67.25','2026-08-01','Clara M.','London','GB'],
    ['4','1103','completed','203.75','2026-08-02','David P.','Berlin','DE'],
    ['5','1115','pending','55.00','2026-08-02','Emma L.','Paris','FR'],
    ['6','1127','completed','318.90','2026-08-02','Frank R.','Sydney','AU'],
    ['7','1139','pending','44.50','2026-08-03','Grace K.','Seoul','KR'],
    ['8','1151','failed','91.00','2026-08-03','Harry S.','Dubai','AE'],
    ['9','1163','completed','176.25','2026-08-03','Isla F.','Toronto','CA'],
    ['10','1175','pending','62.80','2026-08-03','James W.','NYC','US'],
    ['11','1187','completed','445.00','2026-08-04','Karen O.','Mumbai','IN'],
    ['12','1199','failed','38.50','2026-08-04','Liam B.','Cape Town','ZA'],
    ['13','1211','pending','127.60','2026-08-04','Mia J.','Singapore','SG'],
    ['14','1223','completed','88.00','2026-08-04','Noah T.','Amsterdam','NL'],
    ['15','1235','completed','533.20','2026-08-05','Olivia R.','Vienna','AT'],
    ['16','1247','pending','71.40','2026-08-05','Paul H.','Chicago','US'],
    ['17','1259','failed','29.99','2026-08-05','Quinn M.','Lagos','NG'],
    ['18','1271','completed','196.75','2026-08-05','Rachel K.','Stockholm','SE'],
  ];

  const rowH = 26;
  for(let ri=0; ri<rowData.length; ri++) {
    const ry = MY + 68 + ri * rowH;
    if(ry + rowH > H) break;
    const bg = ri % 2 === 0 ? BG_ROW : BG_ROW_ALT;
    fillRect(pixels, W, MX, ry, W-MX, rowH, bg);
    rowData[ri].forEach((cell, ci) => {
      const cellX = MX + ci * colW + 8;
      const cellY = ry + 9;
      if(ci === 2) { // status column
        const sc = statusColors[cell] || TEXT_GRAY;
        drawText(pixels, W, H, cellX, cellY, cell, sc, 1);
      } else {
        drawText(pixels, W, H, cellX, cellY, cell, ci===0?TEXT_DIM:TEXT_GRAY, 1);
      }
    });
    // row separator
    for(let x=MX;x<W;x++){const i=((ry+rowH-1)*W+x)*4;pixels[i]=BORDER[0];pixels[i+1]=BORDER[1];pixels[i+2]=BORDER[2];pixels[i+3]=255;}
  }

  // Scroll indicator
  const scrollH = 80;
  fillRect(pixels, W, W-8, MY+68, 6, H-MY-68, BG_PANEL);
  fillRect(pixels, W, W-8, MY+68, 6, scrollH, ACCENT_BLUE);

  // Dataset list panel on left between sidebar and table
  fillRect(pixels, W, MX, MY+40, 150, H-MY-40, BG_SIDEBAR);
  for(let y=MY+40;y<H;y++){const i=(y*W+(MX+150))*4;pixels[i]=BORDER[0];pixels[i+1]=BORDER[1];pixels[i+2]=BORDER[2];pixels[i+3]=255;}
  drawText(pixels, W, H, MX+8, MY+54, 'DATASETS', TEXT_DIM, 1);
  // dataset entries
  const datasets = ['orders','customers','products'];
  datasets.forEach((ds, di) => {
    const dy = MY + 72 + di * 36;
    if(di === 0) {
      fillRect(pixels, W, MX+1, dy-4, 149, 30, [...ACCENT_BLUE.map(c=>Math.round(c*0.15+BG_SIDEBAR[0]*0.85)), 255]);
      for(let y=dy-4;y<dy+26;y++){const i=(y*W+(MX+1))*4;pixels[i]=ACCENT_BLUE[0];pixels[i+1]=ACCENT_BLUE[1];pixels[i+2]=ACCENT_BLUE[2];pixels[i+3]=255;}
    }
    drawText(pixels, W, H, MX+14, dy+4, ds, di===0?TEXT_WHITE:TEXT_DIM, 1);
    const countStr = ['300','187','94'][di];
    drawText(pixels, W, H, MX+14, dy+14, countStr+' rows', TEXT_DIM, 1);
  });

  return encodePng(W, H, (x,y) => {
    const i=(y*W+x)*4;
    return [pixels[i],pixels[i+1],pixels[i+2],pixels[i+3]];
  });
}

// ─── Screenshot 2: SQL Workspace ─────────────────────────────────────────────

function makeScreenshot2() {
  const W=1280, H=800;
  const pixels = new Uint8Array(W*H*4);
  for(let i=0;i<W*H*4;i+=4){pixels[i]=BG_DARK[0];pixels[i+1]=BG_DARK[1];pixels[i+2]=BG_DARK[2];pixels[i+3]=255;}

  drawTopBar(pixels, W, H, 'SQL Workspace');
  drawSidebar(pixels, W, H, 'SQL');

  const MX=68, MY=48;
  const editorH = 340;

  // Editor area
  fillRect(pixels, W, MX, MY, W-MX, editorH, BG_PANEL);
  // line numbers bg
  fillRect(pixels, W, MX, MY, 36, editorH, BG_SIDEBAR);
  for(let y=MY;y<MY+editorH;y++){const i=(y*W+(MX+36))*4;pixels[i]=BORDER[0];pixels[i+1]=BORDER[1];pixels[i+2]=BORDER[2];pixels[i+3]=255;}

  // SQL lines
  const lines = [
    {num:'1', tokens:[{t:'SELECT ',c:ACCENT_PURP},{t:'status',c:ACCENT_CYAN},{t:', COUNT(',c:TEXT_GRAY},{t:'*',c:ACCENT_BLUE},{t:') AS count,',c:TEXT_GRAY}]},
    {num:'2', tokens:[{t:'       AVG(',c:TEXT_GRAY},{t:'total',c:ACCENT_CYAN},{t:') AS avg_total,',c:TEXT_GRAY}]},
    {num:'3', tokens:[{t:'       SUM(',c:TEXT_GRAY},{t:'total',c:ACCENT_CYAN},{t:') AS revenue',c:TEXT_GRAY}]},
    {num:'4', tokens:[{t:'FROM ',c:ACCENT_PURP},{t:'orders',c:ACCENT_CYAN}]},
    {num:'5', tokens:[{t:'GROUP BY ',c:ACCENT_PURP},{t:'status',c:ACCENT_CYAN}]},
    {num:'6', tokens:[{t:'ORDER BY ',c:ACCENT_PURP},{t:'count ',c:ACCENT_CYAN},{t:'DESC',c:ACCENT_PURP},{t:';',c:TEXT_GRAY}]},
    {num:'7', tokens:[]},
    {num:'8', tokens:[{t:'-- Pagination metrics',c:[80,100,80]}]},
    {num:'9', tokens:[{t:'SELECT ',c:ACCENT_PURP},{t:'page_num',c:ACCENT_CYAN},{t:', COUNT(',c:TEXT_GRAY},{t:'*',c:ACCENT_BLUE},{t:') AS page_rows',c:TEXT_GRAY}]},
    {num:'10', tokens:[{t:'FROM ',c:ACCENT_PURP},{t:'orders',c:ACCENT_CYAN}]},
    {num:'11', tokens:[{t:'GROUP BY ',c:ACCENT_PURP},{t:'page_num',c:ACCENT_CYAN},{t:';',c:TEXT_GRAY}]},
  ];

  lines.forEach((line, li) => {
    const ly = MY + 14 + li * 24;
    drawText(pixels, W, H, MX+8, ly, line.num, TEXT_DIM, 1);
    let lx = MX + 46;
    line.tokens.forEach(tok => {
      drawText(pixels, W, H, lx, ly, tok.t, tok.c, 1);
      lx += textWidth(tok.t, 1);
    });
    // line separator subtle
    if(li < lines.length-1) for(let x=MX+37;x<W;x++){const i=((ly+16)*W+x)*4;pixels[i]=Math.min(255,BG_PANEL[0]+4);pixels[i+1]=BG_PANEL[1];pixels[i+2]=BG_PANEL[2];pixels[i+3]=255;}
  });

  // cursor blink on line 6
  fillRect(pixels, W, MX+46+textWidth('ORDER BY status DESC;',1), MY+14+5*24, 2, 12, TEXT_WHITE);

  // Run button
  fillGradientH(pixels, W, W-120, MY+editorH-36, 90, 26, ACCENT_BLUE, ACCENT_PURP);
  drawText(pixels, W, H, W-104, MY+editorH-24, 'Run SQL', TEXT_WHITE, 1);

  // Results area header
  fillRect(pixels, W, MX, MY+editorH, W-MX, 32, BG_HEADER);
  drawText(pixels, W, H, MX+10, MY+editorH+10, 'Results', TEXT_WHITE, 1);
  drawText(pixels, W, H, MX+90, MY+editorH+12, '3 rows  0.8ms  DuckDB-WASM', TEXT_DIM, 1);
  for(let x=MX;x<W;x++){const i=((MY+editorH+31)*W+x)*4;pixels[i]=BORDER[0];pixels[i+1]=BORDER[1];pixels[i+2]=BORDER[2];pixels[i+3]=255;}

  // Results table header
  const resCols = ['status','count','avg_total','revenue'];
  const resColW = Math.floor((W-MX)/resCols.length);
  fillRect(pixels, W, MX, MY+editorH+32, W-MX, 26, BG_PANEL);
  resCols.forEach((col,ci) => {
    drawText(pixels, W, H, MX+ci*resColW+8, MY+editorH+42, col, ACCENT_CYAN, 1);
    if(ci>0)for(let y=MY+editorH+32;y<H;y++){const x=MX+ci*resColW;const i=(y*W+x)*4;pixels[i]=BORDER[0];pixels[i+1]=BORDER[1];pixels[i+2]=BORDER[2];pixels[i+3]=255;}
  });
  for(let x=MX;x<W;x++){const i=((MY+editorH+57)*W+x)*4;pixels[i]=BORDER[0];pixels[i+1]=BORDER[1];pixels[i+2]=BORDER[2];pixels[i+3]=255;}

  // Results rows
  const resData = [
    ['completed','142','127.84','18,152.88'],
    ['pending','98','74.36','7,287.28'],
    ['failed','60','53.12','3,187.20'],
  ];
  const resStatusColors = {'completed':GREEN,'pending':AMBER,'failed':RED};
  resData.forEach((row, ri) => {
    const ry = MY+editorH+58 + ri*28;
    fillRect(pixels, W, MX, ry, W-MX, 28, ri%2===0?BG_ROW:BG_ROW_ALT);
    row.forEach((cell,ci) => {
      const c = ci===0 ? (resStatusColors[cell]||TEXT_GRAY) : TEXT_GRAY;
      drawText(pixels, W, H, MX+ci*resColW+8, ry+9, cell, c, 1);
    });
    for(let x=MX;x<W;x++){const i=((ry+27)*W+x)*4;pixels[i]=BORDER[0];pixels[i+1]=BORDER[1];pixels[i+2]=BORDER[2];pixels[i+3]=255;}
  });

  return encodePng(W, H, (x,y)=>{const i=(y*W+x)*4;return[pixels[i],pixels[i+1],pixels[i+2],pixels[i+3]];});
}

// ─── Screenshot 3: Side Panel ─────────────────────────────────────────────────

function makeScreenshot3() {
  const W=1280, H=800;
  const pixels = new Uint8Array(W*H*4);
  for(let i=0;i<W*H*4;i+=4){pixels[i]=BG_DARK[0];pixels[i+1]=BG_DARK[1];pixels[i+2]=BG_DARK[2];pixels[i+3]=255;}

  // Draw a "browser" background
  fillRect(pixels, W, 0, 0, W, H, [240, 242, 245]);

  // Fake browser chrome
  fillRect(pixels, W, 0, 0, W, 52, [40,42,48]);
  // address bar
  fillRect(pixels, W, 120, 10, 800, 32, [60,62,70]);
  drawText(pixels, W, H, 140, 22, 'https://store.example.com/dashboard', [200,210,220], 1);
  // tab
  fillRect(pixels, W, 120, 0, 180, 10, [55,58,65]);
  drawText(pixels, W, H, 130, 2, 'Dashboard - Stor...', [200,210,220], 1);

  // Web page content area
  const pageX=0, pageY=52, pageW=W-320, pageH=H-52;
  fillRect(pixels, W, pageX, pageY, pageW, pageH, [248,250,252]);

  // Fake webapp content
  fillRect(pixels, W, pageX, pageY, pageW, 60, [255,255,255]);
  fillRect(pixels, W, pageX+20, pageY+18, 120, 24, ACCENT_BLUE);
  drawText(pixels, W, H, pageX+28, pageY+27, 'Dashboard', TEXT_WHITE, 2);
  // Nav items
  ['Orders','Products','Analytics','Settings'].forEach((item,i) => {
    drawText(pixels, W, H, pageX+160+i*90, pageY+27, item, [80,90,110], 1);
  });
  // Page table
  fillRect(pixels, W, pageX+20, pageY+80, pageW-40, 40, [255,255,255]);
  drawText(pixels, W, H, pageX+30, pageY+97, 'Recent Orders', [40,50,60], 2);
  // some fake rows
  for(let ri=0;ri<6;ri++) {
    const ry=pageY+130+ri*45;
    fillRect(pixels, W, pageX+20, ry, pageW-40, 44, ri%2===0?[255,255,255]:[248,250,252]);
    drawText(pixels, W, H, pageX+30, ry+15, '#'+(1042+ri)+'  Order', [60,70,90], 1);
    drawText(pixels, W, H, pageX+200, ry+15, ['completed','pending','failed'][ri%3], [ri%3===0?34:ri%3===1?220:200, ri%3===0?197:ri%3===1?80:50, ri%3===0?94:ri%3===1?11:68], 1);
    drawText(pixels, W, H, pageX+340, ry+15, '$'+(89+ri*23)+'.00', [60,70,90], 1);
  }

  // Side panel
  const spX=pageW, spW=320;
  fillRect(pixels, W, spX, pageY, spW, pageH, BG_DARK);
  for(let y=pageY;y<H;y++){const i=(y*W+spX)*4;pixels[i]=BORDER[0];pixels[i+1]=BORDER[1];pixels[i+2]=BORDER[2];pixels[i+3]=255;}

  // Side panel header
  fillGradientH(pixels, W, spX, pageY, spW, 48, BG_HEADER, BG_PANEL);
  drawText(pixels, W, H, spX+10, pageY+6, 'W WireData', TEXT_WHITE, 2);
  for(let x=spX;x<spX+spW;x++){const i=((pageY+47)*W+x)*4;pixels[i]=ACCENT_BLUE[0];pixels[i+1]=ACCENT_BLUE[1];pixels[i+2]=ACCENT_BLUE[2];pixels[i+3]=255;}

  // Status indicator
  fillRect(pixels, W, spX, pageY+48, spW, 50, BG_PANEL);
  drawCircle(pixels, W, H, spX+24, pageY+72, 7, GREEN);
  drawText(pixels, W, H, spX+38, pageY+66, 'CAPTURING', GREEN, 1);
  drawText(pixels, W, H, spX+38, pageY+77, 'store.example.com', TEXT_DIM, 1);
  for(let x=spX;x<spX+spW;x++){const i=((pageY+97)*W+x)*4;pixels[i]=BORDER[0];pixels[i+1]=BORDER[1];pixels[i+2]=BORDER[2];pixels[i+3]=255;}

  // Capture stats
  fillRect(pixels, W, spX, pageY+98, spW, 80, BG_SIDEBAR);
  drawText(pixels, W, H, spX+10, pageY+112, 'Requests captured', TEXT_DIM, 1);
  drawText(pixels, W, H, spX+10, pageY+124, '47', ACCENT_BLUE, 2);
  drawText(pixels, W, H, spX+80, pageY+112, 'Rows observed', TEXT_DIM, 1);
  drawText(pixels, W, H, spX+80, pageY+124, '300', ACCENT_PURP, 2);
  drawText(pixels, W, H, spX+160, pageY+112, 'Datasets', TEXT_DIM, 1);
  drawText(pixels, W, H, spX+160, pageY+124, '3', ACCENT_CYAN, 2);
  for(let x=spX;x<spX+spW;x++){const i=((pageY+177)*W+x)*4;pixels[i]=BORDER[0];pixels[i+1]=BORDER[1];pixels[i+2]=BORDER[2];pixels[i+3]=255;}

  // Privacy note
  fillRect(pixels, W, spX, pageY+178, spW, 36, BG_DARK);
  drawText(pixels, W, H, spX+10, pageY+184, 'No request headers or bodies stored.', TEXT_DIM, 1);
  drawText(pixels, W, H, spX+10, pageY+195, 'All data stays local. Zero telemetry.', TEXT_DIM, 1);
  for(let x=spX;x<spX+spW;x++){const i=((pageY+213)*W+x)*4;pixels[i]=BORDER[0];pixels[i+1]=BORDER[1];pixels[i+2]=BORDER[2];pixels[i+3]=255;}

  // Captured routes
  drawText(pixels, W, H, spX+10, pageY+222, 'ROUTES', TEXT_DIM, 1);
  const routes = ['GET /api/orders?page=1','GET /api/orders?page=2','GET /api/orders?page=3','GET /api/products'];
  const routeCounts = ['100','100','100','187'];
  routes.forEach((route, ri) => {
    const ry = pageY+234+ri*32;
    fillRect(pixels, W, spX+1, ry, spW-2, 30, ri%2===0?BG_ROW:BG_ROW_ALT);
    drawText(pixels, W, H, spX+10, ry+6, route, TEXT_GRAY, 1);
    drawText(pixels, W, H, spX+10, ry+16, routeCounts[ri]+' rows', TEXT_DIM, 1);
    drawCircle(pixels, W, H, spX+spW-18, ry+14, 4, ACCENT_BLUE);
  });

  // Stop & Open Workbench buttons
  const btnY = H - 80;
  fillRect(pixels, W, spX+8, btnY, spW/2-12, 30, [...RED.map(c=>Math.round(c*0.2+BG_DARK[0]*0.8)), 255]);
  for(let y=btnY;y<btnY+30;y++) for(let x=spX+8;x<spX+8+(spW/2-12);x++){const i=(y*W+x)*4;if(i>=0&&i<pixels.length-3&&(y===btnY||y===btnY+29||x===spX+8||x===spX+8+(spW/2-13))){pixels[i]=RED[0];pixels[i+1]=RED[1];pixels[i+2]=RED[2];pixels[i+3]=255;}}
  drawText(pixels, W, H, spX+30, btnY+10, 'Stop Capture', RED, 1);
  fillGradientH(pixels, W, spX+spW/2+4, btnY, spW/2-12, 30, ACCENT_BLUE, ACCENT_PURP);
  drawText(pixels, W, H, spX+spW/2+16, btnY+10, 'Open Workbench', TEXT_WHITE, 1);

  return encodePng(W, H, (x,y)=>{const i=(y*W+x)*4;return[pixels[i],pixels[i+1],pixels[i+2],pixels[i+3]];});
}

// ─── Screenshot 4: Candidates Grouping ───────────────────────────────────────

function makeScreenshot4() {
  const W=1280, H=800;
  const pixels = new Uint8Array(W*H*4);
  for(let i=0;i<W*H*4;i+=4){pixels[i]=BG_DARK[0];pixels[i+1]=BG_DARK[1];pixels[i+2]=BG_DARK[2];pixels[i+3]=255;}

  drawTopBar(pixels, W, H, 'Candidates');
  drawSidebar(pixels, W, H, 'Candidates');

  const MX=68, MY=48;

  // Candidates header
  fillRect(pixels, W, MX, MY, W-MX, 44, BG_HEADER);
  drawText(pixels, W, H, MX+10, MY+12, 'Route Groups', TEXT_WHITE, 2);
  drawText(pixels, W, H, MX+10, MY+28, '3 groups  47 requests  2 extractable', TEXT_DIM, 1);
  for(let x=MX;x<W;x++){const i=((MY+43)*W+x)*4;pixels[i]=BORDER[0];pixels[i+1]=BORDER[1];pixels[i+2]=BORDER[2];pixels[i+3]=255;}

  // Candidate cards
  const candidates = [
    {
      route: 'GET /api/orders',
      params: 'page=1,2,3',
      count: '3 captures',
      rows: '300 total rows',
      schema: '9 columns  nested objects flattened',
      status: 'EXTRACTABLE',
      statusColor: GREEN,
      preview: ['id','customer_id','status','total','created_at'],
    },
    {
      route: 'GET /api/products',
      params: 'category=all',
      count: '1 capture',
      rows: '187 total rows',
      schema: '7 columns',
      status: 'EXTRACTABLE',
      statusColor: GREEN,
      preview: ['id','name','price','category','stock','rating'],
    },
    {
      route: 'GET /api/customers',
      params: '(no params)',
      count: '1 capture  low confidence',
      rows: '12 rows',
      schema: '5 columns',
      status: 'REVIEW',
      statusColor: AMBER,
      preview: ['id','email','plan','created_at'],
    },
  ];

  candidates.forEach((cand, ci) => {
    const cy = MY+52 + ci * 216;
    const cardH = 206;

    fillRect(pixels, W, MX+8, cy, W-MX-16, cardH, BG_PANEL);
    // left accent stripe
    fillRect(pixels, W, MX+8, cy, 3, cardH, cand.statusColor);
    // inner border
    for(let y=cy;y<cy+cardH;y++){const i=(y*W+(MX+8))*4;pixels[i]=BORDER[0];pixels[i+1]=BORDER[1];pixels[i+2]=BORDER[2];pixels[i+3]=255;}

    // Route + status
    drawText(pixels, W, H, MX+20, cy+12, cand.route, TEXT_WHITE, 2);
    drawText(pixels, W, H, MX+20+textWidth(cand.route,2)+10, cy+15, cand.params, TEXT_DIM, 1);
    drawStatusBadge(pixels, W, H, W-MX-textWidth(cand.status,1)-20, cy+10, cand.status, cand.statusColor);

    // Stats row
    drawText(pixels, W, H, MX+20, cy+38, cand.count, TEXT_DIM, 1);
    drawText(pixels, W, H, MX+20+200, cy+38, cand.rows, ACCENT_CYAN, 1);
    drawText(pixels, W, H, MX+20+400, cy+38, cand.schema, TEXT_DIM, 1);

    // Schema preview chips
    drawText(pixels, W, H, MX+20, cy+58, 'columns:', TEXT_DIM, 1);
    cand.preview.forEach((col,pi) => {
      const chipX = MX+80+pi*(textWidth(col,1)+14);
      fillRect(pixels, W, chipX-3, cy+54, textWidth(col,1)+10, 16, [...ACCENT_BLUE.map(c=>Math.round(c*0.18+BG_PANEL[0]*0.82)), 255]);
      drawText(pixels, W, H, chipX+2, cy+58, col, ACCENT_BLUE, 1);
    });

    // Mini preview table
    fillRect(pixels, W, MX+20, cy+78, W-MX-36, 26, BG_HEADER);
    cand.preview.slice(0,4).forEach((col,pi) => {
      drawText(pixels, W, H, MX+30+pi*200, cy+88, col, ACCENT_CYAN, 1);
    });
    for(let ri=0;ri<2;ri++) {
      const ry=cy+104+ri*24;
      fillRect(pixels, W, MX+20, ry, W-MX-36, 24, ri%2===0?BG_ROW:BG_ROW_ALT);
      const sampleValues = [['1','1042','completed','89.50'],['2','1078','pending','142.00']];
      sampleValues[ri].forEach((val,pi)=>{
        drawText(pixels, W, H, MX+30+pi*200, ry+8, val, TEXT_GRAY, 1);
      });
    }

    // Extract button
    fillGradientH(pixels, W, W-MX-180, cy+cardH-38, 162, 26, ACCENT_BLUE, ACCENT_PURP);
    drawText(pixels, W, H, W-MX-160, cy+cardH-26, 'Extract Dataset', TEXT_WHITE, 1);
  });

  return encodePng(W, H, (x,y)=>{const i=(y*W+x)*4;return[pixels[i],pixels[i+1],pixels[i+2],pixels[i+3]];});
}

// ─── Promo Tiles ─────────────────────────────────────────────────────────────

function makePromoSmall() {
  // 440x280, no alpha, 24-bit PNG for CWS
  const W=440, H=280;
  const pixels = new Uint8Array(W*H*4);
  for(let y=0;y<H;y++) for(let x=0;x<W;x++) {
    const t = x/W;
    const [r,g,b] = lerpColor(lerpColor(BG_DARK, BG_PANEL, 0.5), BG_SIDEBAR, t);
    const i=(y*W+x)*4; pixels[i]=r;pixels[i+1]=g;pixels[i+2]=b;pixels[i+3]=255;
  }

  // Gradient diagonal stripe
  for(let y=0;y<H;y++) for(let x=0;x<W;x++) {
    const diag = (x+y)/(W+H);
    if(diag>0.3&&diag<0.7) {
      const strength = 0.04 * Math.sin((diag-0.3)/(0.4)*Math.PI);
      const [ar,ag,ab] = lerpColor(ACCENT_BLUE, ACCENT_PURP, (x/W));
      const i=(y*W+x)*4;
      pixels[i]=Math.min(255,pixels[i]+ar*strength);
      pixels[i+1]=Math.min(255,pixels[i+1]+ag*strength);
      pixels[i+2]=Math.min(255,pixels[i+2]+ab*strength);
    }
  }

  // Big W logo
  const cx=80, cy=110;
  fillGradientH(pixels, W, cx-35, cy-40, 70, 70, ACCENT_BLUE, ACCENT_PURP);
  drawText(pixels, W, H, cx-28, cy-30, 'W', TEXT_WHITE, 8);

  // Text
  drawText(pixels, W, H, 140, 60, 'WireData', TEXT_WHITE, 4);
  drawText(pixels, W, H, 140, 100, 'Network Data', ACCENT_CYAN, 2);
  drawText(pixels, W, H, 140, 118, 'Workbench', ACCENT_CYAN, 2);
  drawText(pixels, W, H, 140, 150, 'Capture  Query  Export', TEXT_DIM, 1);
  drawText(pixels, W, H, 140, 168, 'Powered by DuckDB-WASM', TEXT_DIM, 1);

  // Mini data viz — bar chart
  const barData = [142,98,60];
  const barColors = [GREEN, AMBER, RED];
  const barLabels = ['completed','pending','failed'];
  const bx=60, by=220, bw=60, maxH=40;
  const maxVal = Math.max(...barData);
  barData.forEach((val,i) => {
    const bh = Math.round(val/maxVal*maxH);
    fillRect(pixels, W, bx+i*80, by-bh, bw, bh, barColors[i]);
    drawText(pixels, W, H, bx+i*80+4, by-bh-10, String(val), barColors[i], 1);
    drawText(pixels, W, H, bx+i*80, by+4, barLabels[i].slice(0,4), TEXT_DIM, 1);
  });
  // x-axis
  for(let x=bx-4;x<bx+3*80+bw+4;x++){const i=((by)*W+x)*4;if(x<W){pixels[i]=BORDER[0];pixels[i+1]=BORDER[1]+20;pixels[i+2]=BORDER[2]+20;pixels[i+3]=255;}}

  return encodePng(W, H, (x,y)=>{const i=(y*W+x)*4;return[pixels[i],pixels[i+1],pixels[i+2],255];});
}

function makePromoMarquee() {
  const W=1400, H=560;
  const pixels = new Uint8Array(W*H*4);

  // Rich gradient background
  for(let y=0;y<H;y++) for(let x=0;x<W;x++) {
    const tx = x/W, ty = y/H;
    const c1 = lerpColor(BG_DARK, [8,12,20], tx);
    const c2 = lerpColor([12,8,25], BG_SIDEBAR, tx);
    const [r,g,b] = lerpColor(c1, c2, ty);
    const i=(y*W+x)*4;pixels[i]=r;pixels[i+1]=g;pixels[i+2]=b;pixels[i+3]=255;
  }

  // Subtle grid lines
  for(let y=0;y<H;y+=40) for(let x=0;x<W;x++){const i=(y*W+x)*4;pixels[i]=Math.min(255,pixels[i]+6);pixels[i+1]=Math.min(255,pixels[i+1]+6);pixels[i+2]=Math.min(255,pixels[i+2]+8);pixels[i+3]=255;}
  for(let x=0;x<W;x+=60) for(let y=0;y<H;y++){const i=(y*W+x)*4;pixels[i]=Math.min(255,pixels[i]+4);pixels[i+1]=Math.min(255,pixels[i+1]+4);pixels[i+2]=Math.min(255,pixels[i+2]+6);pixels[i+3]=255;}

  // Large logo area left
  const logoSize = 120;
  const lx=60, ly=H/2-logoSize/2;
  fillGradientH(pixels, W, lx, ly, logoSize, logoSize, ACCENT_BLUE, ACCENT_PURP);
  drawText(pixels, W, H, lx+18, ly+22, 'W', TEXT_WHITE, 12);

  // Headline
  drawText(pixels, W, H, 210, 120, 'WireData', TEXT_WHITE, 6);
  drawText(pixels, W, H, 210, 175, 'Network Data Workbench', [...lerpColor(ACCENT_BLUE, ACCENT_PURP, 0.5), 255].slice(0,3), 3);
  drawText(pixels, W, H, 210, 220, 'Capture structured JSON traffic from any web app.', TEXT_GRAY, 2);
  drawText(pixels, W, H, 210, 246, 'Run real SQL queries with embedded DuckDB-WASM.', TEXT_GRAY, 2);
  drawText(pixels, W, H, 210, 272, 'Export to CSV, JSON, Parquet, TypeScript types.', TEXT_GRAY, 2);

  // Feature pills
  const features = ['DuckDB SQL','Local-First','Zero Telemetry','MV3 Extension','Chromium 142+'];
  const pillColors = [ACCENT_BLUE, ACCENT_PURP, GREEN, ACCENT_CYAN, AMBER];
  features.forEach((feat,i) => {
    const px = 210 + i * 220;
    const py = 330;
    fillRect(pixels, W, px, py, textWidth(feat,1)+18, 20, [...pillColors[i].map(c=>Math.round(c*0.2)), 255]);
    for(let y=py;y<py+20;y++){const bx1=px,bx2=px+textWidth(feat,1)+17;const yi=(y*W)*4;pixels[yi+bx1*4]=pillColors[i][0];pixels[yi+bx1*4+1]=pillColors[i][1];pixels[yi+bx1*4+2]=pillColors[i][2];pixels[yi+bx1*4+3]=255;pixels[yi+bx2*4]=pillColors[i][0];pixels[yi+bx2*4+1]=pillColors[i][1];pixels[yi+bx2*4+2]=pillColors[i][2];pixels[yi+bx2*4+3]=255;}
    for(let xx=px;xx<px+textWidth(feat,1)+18;xx++){const yi1=(py*W+xx)*4;const yi2=((py+19)*W+xx)*4;pixels[yi1]=pillColors[i][0];pixels[yi1+1]=pillColors[i][1];pixels[yi1+2]=pillColors[i][2];pixels[yi1+3]=255;pixels[yi2]=pillColors[i][0];pixels[yi2+1]=pillColors[i][1];pixels[yi2+2]=pillColors[i][2];pixels[yi2+3]=255;}
    drawText(pixels, W, H, px+9, py+6, feat, pillColors[i], 1);
  });

  // Right side: mini workbench preview card
  const cardX = W-500, cardY=60, cardW=440, cardH=440;
  fillRect(pixels, W, cardX, cardY, cardW, cardH, BG_PANEL);
  for(let y=cardY;y<cardY+cardH;y++){const i=(y*W+cardX)*4;pixels[i]=ACCENT_BLUE[0];pixels[i+1]=ACCENT_BLUE[1];pixels[i+2]=ACCENT_BLUE[2];pixels[i+3]=255;}
  // card topbar
  fillRect(pixels, W, cardX+1, cardY, cardW-1, 32, BG_HEADER);
  drawText(pixels, W, H, cardX+12, cardY+10, 'SQL Workspace  DuckDB-WASM', ACCENT_CYAN, 1);
  // sql snippet
  const sqlLines2 = [
    [{t:'SELECT ',c:ACCENT_PURP},{t:'status',c:ACCENT_CYAN},{t:', COUNT(*) cnt, AVG(total) avg',c:TEXT_GRAY}],
    [{t:'FROM ',c:ACCENT_PURP},{t:'orders',c:ACCENT_CYAN}],
    [{t:'GROUP BY ',c:ACCENT_PURP},{t:'status',c:ACCENT_CYAN},{t:' ORDER BY cnt DESC',c:TEXT_GRAY}],
  ];
  sqlLines2.forEach((line,li) => {
    let lx2=cardX+10;
    line.forEach(tok=>{drawText(pixels,W,H,lx2,cardY+42+li*18,tok.t,tok.c,1);lx2+=textWidth(tok.t,1);});
  });
  // separator
  for(let x=cardX;x<cardX+cardW;x++){const i=((cardY+98)*W+x)*4;pixels[i]=BORDER[0];pixels[i+1]=BORDER[1];pixels[i+2]=BORDER[2];pixels[i+3]=255;}
  // Results table in card
  const rCols=['status','count','avg_total'];
  const rColW=Math.floor(cardW/rCols.length);
  fillRect(pixels,W,cardX+1,cardY+99,cardW-1,24,BG_HEADER);
  rCols.forEach((col,ci)=>{drawText(pixels,W,H,cardX+8+ci*rColW,cardY+108,col,ACCENT_CYAN,1);});
  const rData2=[['completed','142','127.84'],['pending','98','74.36'],['failed','60','53.12']];
  const rSColors={'completed':GREEN,'pending':AMBER,'failed':RED};
  rData2.forEach((row,ri)=>{
    const ry=cardY+123+ri*28;
    fillRect(pixels,W,cardX+1,ry,cardW-1,28,ri%2===0?BG_ROW:BG_ROW_ALT);
    row.forEach((cell,ci)=>{drawText(pixels,W,H,cardX+8+ci*rColW,ry+9,cell,ci===0?(rSColors[cell]||TEXT_GRAY):TEXT_GRAY,1);});
  });
  // bar chart below results
  const bx=cardX+20, by=cardY+220;
  const bBarData=[142,98,60], bBarMax=142, bBarH=120, bBarW=80;
  const bBarColors=[GREEN,AMBER,RED];
  bBarData.forEach((val,i)=>{
    const h=Math.round(val/bBarMax*bBarH);
    fillRect(pixels,W,bx+i*130,by-h,bBarW,h,bBarColors[i]);
    drawText(pixels,W,H,bx+i*130+4,by-h-12,String(val),bBarColors[i],1);
    drawText(pixels,W,H,bx+i*130,by+6,['completed','pending','failed'][i].slice(0,4),TEXT_DIM,1);
  });
  for(let x=bx-4;x<bx+3*130+bBarW;x++){const i=((by)*W+x)*4;if(x>=0&&x<W){pixels[i]=BORDER[0]+20;pixels[i+1]=BORDER[1]+20;pixels[i+2]=BORDER[2]+20;pixels[i+3]=255;}}

  return encodePng(W, H, (x,y)=>{const i=(y*W+x)*4;return[pixels[i],pixels[i+1],pixels[i+2],255];});
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const assets = [
  ['screenshot-1-datasets.png', makeScreenshot1],
  ['screenshot-2-sql.png', makeScreenshot2],
  ['screenshot-3-sidepanel.png', makeScreenshot3],
  ['screenshot-4-candidates.png', makeScreenshot4],
  ['promo-small.png', makePromoSmall],
  ['promo-marquee.png', makePromoMarquee],
];

for (const [name, fn] of assets) {
  const buf = fn();
  const outPath = path.join(OUT, name);
  fs.writeFileSync(outPath, buf);
  console.log(`✓  ${name}  (${(buf.length/1024).toFixed(1)} KB)`);
}

// Copy icon-128 for convenience
const srcIcon = path.resolve('apps/extension/public/icons/icon-128.png');
if (fs.existsSync(srcIcon)) {
  fs.copyFileSync(srcIcon, path.join(OUT, 'icon-128.png'));
  console.log('✓  icon-128.png  (copied)');
}

console.log(`\nAll assets written to: ${OUT}`);
