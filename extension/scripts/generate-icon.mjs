/**
 * Gera media/prometheon-icon.png (256x256, fundo transparente) a partir da mesma
 * geometria de media/prometheon-icon-source.svg.
 *
 * O desenho é rasterizado aqui em vez de convertido do SVG para não adicionar
 * dependência nativa (sharp/resvg) ao projeto. Se a geometria do SVG mudar,
 * ajuste NODES/EDGES abaixo e rode `npm run icon`.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SIZE = 256;
/** Amostras por eixo, por pixel. 4x4 = antialiasing suficiente para 256px. */
const SAMPLES = 4;

const CENTER = { x: 128, y: 128, r: 31, color: [0x7c, 0x5c, 0xff] };

const WORKERS = [
  { x: 128, y: 44 },
  { x: 212, y: 128 },
  { x: 128, y: 212 },
  { x: 44, y: 128 },
].map((p) => ({ ...p, r: 19, color: [0xa7, 0x8b, 0xfa] }));

const RADIAL = WORKERS.map((w) => ({
  a: CENTER,
  b: w,
  width: 9,
  color: [0x6d, 0x5a, 0xe0],
  alpha: 1,
}));

const RING = WORKERS.map((w, i) => ({
  a: w,
  b: WORKERS[(i + 1) % WORKERS.length],
  width: 5,
  color: [0x6d, 0x5a, 0xe0],
  alpha: 0.55,
}));

// Pintado de trás para frente: arestas primeiro, nós por cima.
const EDGES = [...RING, ...RADIAL];
const NODES = [...WORKERS, CENTER];

function distanceToSegment(px, py, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((px - a.x) * dx + (py - a.y) * dy) / lengthSquared));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Cor da amostra em coordenadas contínuas, ou null quando transparente. */
function sampleAt(x, y) {
  for (let i = NODES.length - 1; i >= 0; i--) {
    const node = NODES[i];
    if (Math.hypot(x - node.x, y - node.y) <= node.r) {
      return { color: node.color, alpha: 1 };
    }
  }
  for (let i = EDGES.length - 1; i >= 0; i--) {
    const edge = EDGES[i];
    if (distanceToSegment(x, y, edge.a, edge.b) <= edge.width / 2) {
      return { color: edge.color, alpha: edge.alpha };
    }
  }
  return null;
}

function renderRgba() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const step = 1 / SAMPLES;
  const offset = step / 2;

  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      // Acumula cor pré-multiplicada pelo alpha para que as bordas suavizem
      // contra o fundo transparente sem escurecer.
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const sample = sampleAt(px + offset + sx * step, py + offset + sy * step);
          if (sample === null) {
            continue;
          }
          r += sample.color[0] * sample.alpha;
          g += sample.color[1] * sample.alpha;
          b += sample.color[2] * sample.alpha;
          a += sample.alpha;
        }
      }

      const total = SAMPLES * SAMPLES;
      const index = (py * SIZE + px) * 4;
      if (a > 0) {
        pixels[index] = Math.round(r / a);
        pixels[index + 1] = Math.round(g / a);
        pixels[index + 2] = Math.round(b / a);
        pixels[index + 3] = Math.round((a / total) * 255);
      }
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // color type RGBA
  header[10] = 0; // deflate
  header[11] = 0; // filtro adaptativo
  header[12] = 0; // sem entrelaçamento

  const stride = SIZE * 4;
  const raw = Buffer.alloc((stride + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (stride + 1)] = 0; // filtro None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outputPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'media', 'prometheon-icon.png');
writeFileSync(outputPath, encodePng(renderRgba()));
console.log(`Ícone gerado: ${outputPath} (${SIZE}x${SIZE})`);
