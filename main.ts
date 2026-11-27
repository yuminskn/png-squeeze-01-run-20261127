// png-squeeze — lossless PNG re-encoder.
//
// Reads 1280x720 screenshots and rewrites each one as the smallest valid
// PNG that reproduces every pixel exactly, including the RGB values of
// fully transparent pixels. Inputs may be PNG files (the house hands each
// instance as a stored PNG: colour type 6, bit depth 8, unfiltered rows)
// or raw RGBA byte files. Node built-ins only (node:fs, node:path,
// node:zlib); no packages, no network, no randomness, no timestamps —
// the same input always produces the same output bytes.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { constants as zlibConstants, deflateSync, inflateSync } from "node:zlib";

const W = 1280;
const H = 720;
const PX = W * H;
const RGBA_LEN = PX * 4;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ------------------------------------------------------------------ CRC32 --
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "ascii");
  data.copy(out, 8);
  const crcInput = Buffer.alloc(4 + data.length);
  crcInput.write(type, 0, 4, "ascii");
  data.copy(crcInput, 4);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// ------------------------------------------------------------ PNG decoding --
// Decodes a bit-depth-8, non-interlaced PNG of colour type 0/2/3/4/6 with
// dimensions exactly 1280x720 back into raw RGBA bytes. All five row
// filters are undone. Returns null for anything else.
function decodePng(buf: Buffer): Buffer | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let plte: Buffer | null = null;
  let trns: Buffer | null = null;
  const idatParts: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") {
      plte = Buffer.from(data);
    } else if (type === "tRNS") {
      trns = Buffer.from(data);
    } else if (type === "IDAT") {
      idatParts.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (width !== W || height !== H || bitDepth !== 8 || interlace !== 0) return null;
  if (colorType !== 0 && colorType !== 2 && colorType !== 3 && colorType !== 4 && colorType !== 6) return null;
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  const rowBytes = W * channels;
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idatParts));
  } catch {
    return null;
  }
  if (inflated.length !== H * (1 + rowBytes)) return null;
  const rgba = Buffer.alloc(RGBA_LEN);
  const prevRow = Buffer.alloc(rowBytes);
  const bpp = channels;
  for (let y = 0; y < H; y++) {
    const rowStart = y * (1 + rowBytes);
    const filter = inflated[rowStart];
    const src = inflated.subarray(rowStart + 1, rowStart + 1 + rowBytes);
    const recon = Buffer.alloc(rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const left = i >= bpp ? recon[i - bpp] : 0;
      const up = prevRow[i];
      const upLeft = i >= bpp ? prevRow[i - bpp] : 0;
      let v = src[i];
      if (filter === 1) v = (v + left) & 0xff;
      else if (filter === 2) v = (v + up) & 0xff;
      else if (filter === 3) v = (v + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) v = (v + paeth(left, up, upLeft)) & 0xff;
      else if (filter !== 0) return null;
      recon[i] = v;
    }
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      if (colorType === 6) {
        rgba[o] = recon[x * 4];
        rgba[o + 1] = recon[x * 4 + 1];
        rgba[o + 2] = recon[x * 4 + 2];
        rgba[o + 3] = recon[x * 4 + 3];
      } else if (colorType === 2) {
        rgba[o] = recon[x * 3];
        rgba[o + 1] = recon[x * 3 + 1];
        rgba[o + 2] = recon[x * 3 + 2];
        rgba[o + 3] = 255;
      } else if (colorType === 0) {
        const g = recon[x];
        rgba[o] = g;
        rgba[o + 1] = g;
        rgba[o + 2] = g;
        rgba[o + 3] = 255;
      } else if (colorType === 4) {
        const g = recon[x * 2];
        rgba[o] = g;
        rgba[o + 1] = g;
        rgba[o + 2] = g;
        rgba[o + 3] = recon[x * 2 + 1];
      } else {
        // colour type 3: palette index
        const idx = recon[x];
        if (plte === null || idx * 3 + 2 >= plte.length) return null;
        rgba[o] = plte[idx * 3];
        rgba[o + 1] = plte[idx * 3 + 1];
        rgba[o + 2] = plte[idx * 3 + 2];
        rgba[o + 3] = trns !== null && idx < trns.length ? trns[idx] : 255;
      }
    }
    prevRow.set(recon);
  }
  return rgba;
}

// Accepts a file's bytes either as raw RGBA (exactly 3,686,400 bytes) or
// as a PNG that decodePng understands. Anything else yields null.
function toRgba(data: Buffer): Buffer | null {
  if (data.length === RGBA_LEN) return data;
  return decodePng(data);
}

// ------------------------------------------------------------ input intake --
interface InputItem {
  name: string; // output base name, without extension
  rgba: Buffer;
}

function sanitizeName(id: string): string {
  const clean = String(id).replace(/[^A-Za-z0-9._-]+/g, "_");
  return clean.length > 0 ? clean : "image";
}

function collectInputs(inputDir: string): InputItem[] {
  const names = readdirSync(inputDir)
    .filter((n) => {
      try {
        return statSync(join(inputDir, n)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
  const items: InputItem[] = [];

  // JSON manifest first: cases.json (or any .json) holding either
  // {"cases": [{"id", "input"}, ...]} or a bare array of the same shape.
  // Each "input" is a file name in this directory or base64 raw RGBA.
  const manifestName = names.find((n) => n.toLowerCase().endsWith(".json"));
  if (manifestName !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(join(inputDir, manifestName), "utf8"));
      const cases: Array<{ id?: string; input?: string }> = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.cases)
          ? parsed.cases
          : [];
      for (const entry of cases) {
        if (!entry || typeof entry.input !== "string") continue;
        const id = sanitizeName(entry.id ?? basename(entry.input, extname(entry.input)));
        const filePath = join(inputDir, entry.input);
        if (existsSync(filePath)) {
          const rgba = toRgba(readFileSync(filePath));
          if (rgba !== null) items.push({ name: id, rgba });
          else process.stderr.write(`skip manifest input ${entry.input}: not raw RGBA or a supported PNG\n`);
        } else {
          const decoded = Buffer.from(entry.input, "base64");
          if (decoded.length === RGBA_LEN) items.push({ name: id, rgba: decoded });
          else process.stderr.write(`skip manifest input for ${id}: base64 payload is not raw RGBA\n`);
        }
      }
      if (items.length > 0) return items;
    } catch {
      // fall through to plain-file handling
    }
  }

  for (const n of names) {
    if (n.toLowerCase().endsWith(".json")) continue;
    const rgba = toRgba(readFileSync(join(inputDir, n)));
    if (rgba === null) {
      process.stderr.write(`skip ${n}: not raw RGBA or a supported PNG\n`);
      continue;
    }
    const base = basename(n, extname(n));
    items.push({ name: base.length > 0 ? base : "image", rgba });
  }
  return items;
}

// -------------------------------------------------------------- analysis ---
interface Analysis {
  allOpaque: boolean;
  isGrey: boolean;
  palette: number[]; // packed RGBA keys, first-seen order; length 257 = "too many"
  paletteIndex: Map<number, number>;
}

function analyze(rgba: Buffer): Analysis {
  let allOpaque = true;
  let isGrey = true;
  const palette: number[] = [];
  const paletteIndex = new Map<number, number>();
  for (let i = 0; i < PX; i++) {
    const o = i * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    const a = rgba[o + 3];
    if (a !== 255) allOpaque = false;
    if (r !== g || g !== b) isGrey = false;
    if (palette.length <= 256) {
      const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      if (!paletteIndex.has(key)) {
        paletteIndex.set(key, palette.length);
        palette.push(key);
      }
    }
  }
  return { allOpaque, isGrey, palette, paletteIndex };
}

// ------------------------------------------------------------ conversions --
function convGrey(rgba: Buffer): Buffer {
  const out = Buffer.alloc(PX);
  for (let i = 0; i < PX; i++) out[i] = rgba[i * 4];
  return out;
}

function convGreyAlpha(rgba: Buffer): Buffer {
  const out = Buffer.alloc(PX * 2);
  for (let i = 0; i < PX; i++) {
    out[i * 2] = rgba[i * 4];
    out[i * 2 + 1] = rgba[i * 4 + 3];
  }
  return out;
}

function convRgb(rgba: Buffer): Buffer {
  const out = Buffer.alloc(PX * 3);
  for (let i = 0; i < PX; i++) {
    out[i * 3] = rgba[i * 4];
    out[i * 3 + 1] = rgba[i * 4 + 1];
    out[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return out;
}

function convPalette(rgba: Buffer, index: Map<number, number>): Buffer {
  const out = Buffer.alloc(PX);
  for (let i = 0; i < PX; i++) {
    const o = i * 4;
    const key = ((rgba[o] << 24) | (rgba[o + 1] << 16) | (rgba[o + 2] << 8) | rgba[o + 3]) >>> 0;
    out[i] = index.get(key) as number;
  }
  return out;
}

// -------------------------------------------------------------- filtering --
// Cost of a filtered row: sum over bytes of the signed-byte magnitude
// (v < 128 ? v : 256 - v). Lower tends to deflate smaller.
function filterCost(buf: Buffer, off: number, len: number): number {
  let s = 0;
  for (let i = 0; i < len; i++) {
    const v = buf[off + i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// Writes one filtered row into dst and returns its cost.
function applyFilter(
  dst: Buffer,
  cur: Buffer,
  curOff: number,
  prev: Buffer | null,
  prevOff: number,
  rowBytes: number,
  bpp: number,
  filter: number,
): number {
  if (filter === 0) {
    cur.copy(dst, 0, curOff, curOff + rowBytes);
    return filterCost(dst, 0, rowBytes);
  }
  let cost = 0;
  for (let i = 0; i < rowBytes; i++) {
    const left = i >= bpp ? cur[curOff + i - bpp] : 0;
    const up = prev !== null ? prev[prevOff + i] : 0;
    const upLeft = i >= bpp && prev !== null ? prev[prevOff + i - bpp] : 0;
    let pred = 0;
    if (filter === 1) pred = left;
    else if (filter === 2) pred = up;
    else if (filter === 3) pred = (left + up) >> 1;
    else pred = paeth(left, up, upLeft);
    const v = (cur[curOff + i] - pred) & 0xff;
    dst[i] = v;
    cost += v < 128 ? v : 256 - v;
  }
  return cost;
}

// Filters every row of raw (H rows of rowBytes) with its cheapest filter.
function filterAll(raw: Buffer, rowBytes: number, bpp: number): Buffer {
  const out = Buffer.alloc(H * (1 + rowBytes));
  const trial = Buffer.alloc(rowBytes);
  const winner = Buffer.alloc(rowBytes);
  for (let y = 0; y < H; y++) {
    const curOff = y * rowBytes;
    const prev = y > 0 ? raw : null;
    const prevOff = y > 0 ? (y - 1) * rowBytes : 0;
    let bestCost = Infinity;
    let bestFilter = 0;
    for (let f = 0; f <= 4; f++) {
      const c = applyFilter(trial, raw, curOff, prev, prevOff, rowBytes, bpp, f);
      if (c < bestCost) {
        bestCost = c;
        bestFilter = f;
        winner.set(trial);
      }
    }
    const outOff = y * (1 + rowBytes);
    out[outOff] = bestFilter;
    winner.copy(out, outOff + 1);
  }
  return out;
}

// -------------------------------------------------------------- encoding ---
const DEFLATE_TRIES: Array<Record<string, number>> = [
  { level: 9 },
  { level: 9, memLevel: 9 },
  { level: 9, strategy: zlibConstants.Z_FILTERED },
];

function deflateSmallest(filtered: Buffer): Buffer {
  let best: Buffer | null = null;
  for (const opts of DEFLATE_TRIES) {
    const c = deflateSync(filtered, opts);
    if (best === null || c.length < best.length) best = c;
  }
  return best as Buffer;
}

interface Candidate {
  colorType: number;
  raw: Buffer;
  rowBytes: number;
  bpp: number;
  plte: Buffer | null;
  trns: Buffer | null;
}

function ihdrChunk(colorType: number): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(W, 0);
  data.writeUInt32BE(H, 4);
  data[8] = 8; // bit depth
  data[9] = colorType;
  data[10] = 0; // compression method
  data[11] = 0; // filter method
  data[12] = 0; // no interlace
  return makeChunk("IHDR", data);
}

function buildPng(cand: Candidate): Buffer {
  const filtered = filterAll(cand.raw, cand.rowBytes, cand.bpp);
  const idat = deflateSmallest(filtered);
  const parts: Buffer[] = [PNG_SIG, ihdrChunk(cand.colorType)];
  if (cand.plte !== null) parts.push(makeChunk("PLTE", cand.plte));
  if (cand.trns !== null) parts.push(makeChunk("tRNS", cand.trns));
  parts.push(makeChunk("IDAT", idat));
  parts.push(makeChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function encodeSmallest(rgba: Buffer): Buffer {
  const a = analyze(rgba);
  const candidates: Candidate[] = [];
  const fewColors = a.palette.length <= 256;

  if (a.isGrey && a.allOpaque) {
    candidates.push({ colorType: 0, raw: convGrey(rgba), rowBytes: W, bpp: 1, plte: null, trns: null });
  } else if (fewColors) {
    const plte = Buffer.alloc(a.palette.length * 3);
    const alphas: number[] = [];
    let needTrns = false;
    for (let i = 0; i < a.palette.length; i++) {
      const key = a.palette[i];
      plte[i * 3] = (key >>> 24) & 0xff;
      plte[i * 3 + 1] = (key >>> 16) & 0xff;
      plte[i * 3 + 2] = (key >>> 8) & 0xff;
      const alpha = key & 0xff;
      alphas.push(alpha);
      if (alpha !== 255) needTrns = true;
    }
    let trns: Buffer | null = null;
    if (needTrns) {
      let last = alphas.length - 1;
      while (last > 0 && alphas[last] === 255) last--;
      trns = Buffer.from(alphas.slice(0, last + 1));
    }
    candidates.push({
      colorType: 3,
      raw: convPalette(rgba, a.paletteIndex),
      rowBytes: W,
      bpp: 1,
      plte,
      trns,
    });
    // A palette can hide smooth colour transitions from the filters, so
    // also try the natural truecolour shape and keep whichever is smaller.
    if (a.isGrey) {
      candidates.push({ colorType: 4, raw: convGreyAlpha(rgba), rowBytes: W * 2, bpp: 2, plte: null, trns: null });
    } else if (a.allOpaque) {
      candidates.push({ colorType: 2, raw: convRgb(rgba), rowBytes: W * 3, bpp: 3, plte: null, trns: null });
    } else {
      candidates.push({ colorType: 6, raw: rgba, rowBytes: W * 4, bpp: 4, plte: null, trns: null });
    }
  } else if (a.isGrey) {
    candidates.push({ colorType: 4, raw: convGreyAlpha(rgba), rowBytes: W * 2, bpp: 2, plte: null, trns: null });
  } else if (a.allOpaque) {
    candidates.push({ colorType: 2, raw: convRgb(rgba), rowBytes: W * 3, bpp: 3, plte: null, trns: null });
  } else {
    candidates.push({ colorType: 6, raw: rgba, rowBytes: W * 4, bpp: 4, plte: null, trns: null });
  }

  let best: Buffer | null = null;
  for (const cand of candidates) {
    const png = buildPng(cand);
    if (best === null || png.length < best.length) best = png;
  }
  return best as Buffer;
}

// ---------------------------------------------------------------- driver ---
function main(): void {
  const inputDir = process.argv[2] || process.env.INPUT_DIR || "/input";
  const outputDir = process.argv[3] || process.env.OUTPUT_DIR || "/output";
  // Create the output directory if missing; never remove it or its mount.
  mkdirSync(outputDir, { recursive: true });
  const items = collectInputs(inputDir);
  if (items.length === 0) {
    process.stderr.write(`no usable 1280x720 inputs found in ${inputDir}\n`);
    process.exit(1);
  }
  for (const item of items) {
    const png = encodeSmallest(item.rgba);
    writeFileSync(join(outputDir, `${item.name}.png`), png);
    process.stderr.write(`${item.name}: ${item.rgba.length} -> ${png.length} bytes\n`);
  }
}

main();
