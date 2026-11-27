// png-squeeze-01-run-20261127 — minimal lossless PNG encoder.
//
// Reads 1280x720 screenshots — either as image.png (a stored PNG, colour
// type 6, bit depth 8, as the grader hands them) or as raw RGBA bytes — and
// rewrites each one as the smallest valid PNG that reproduces every pixel
// exactly, including the colour of fully transparent pixels. Node 22,
// node:fs / node:path / node:zlib only, nothing installed, no network, no
// randomness, no timestamps: the same input always produces the same output
// bytes.
//
// Strategy per image (all choices deterministic):
//   - grey (colour type 0) when R == G == B and opaque; grey+alpha (type 4)
//     when grey with transparency and more than 256 colours;
//   - palette (type 3, + tRNS when any alpha < 255) when the image uses at
//     most 256 distinct RGBA colours;
//   - truecolour RGB (type 2) when opaque, RGBA (type 6) otherwise;
//   - per-row adaptive filtering: for every row the filter (None / Sub / Up
//     / Average / Paeth) with the smallest sum of absolute filtered-byte
//     values wins, which beats a fixed Paeth filter on varied content;
//   - several DEFLATE settings are tried and the smallest stream wins.
// Only IHDR / PLTE / tRNS / IDAT / IEND chunks are emitted, bit depth 8,
// never interlaced.
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
const PNG_SIG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

// ---------------------------------------------------------------- CRC32 ---
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

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "ascii");
  data.copy(out, 8);
  const crcBuf = Buffer.alloc(4 + data.length);
  crcBuf.write(type, 0, 4, "ascii");
  data.copy(crcBuf, 4);
  out.writeUInt32BE(crc32(crcBuf), 8 + data.length);
  return out;
}

function ihdr(colorType: number): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(W, 0);
  data.writeUInt32BE(H, 4);
  data[8] = 8; // bit depth
  data[9] = colorType;
  data[10] = 0; // compression
  data[11] = 0; // filter
  data[12] = 0; // interlace: none
  return chunk("IHDR", data);
}

// ------------------------------------------------------------- filtering ---
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function signedAbsSum(buf: Buffer, off: number, len: number): number {
  let s = 0;
  for (let i = 0; i < len; i++) {
    const v = buf[off + i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// Filters one row into `dst` (rowBytes bytes) and returns the sum of the
// absolute values of the filtered bytes, the classic minimum-sum heuristic.
function filterRow(
  dst: Buffer,
  cur: Buffer,
  curOff: number,
  prev: Buffer | null,
  prevOff: number,
  rowBytes: number,
  bpp: number,
  filter: number,
): number {
  let score = 0;
  if (filter === 0) {
    cur.copy(dst, 0, curOff, curOff + rowBytes);
    return signedAbsSum(dst, 0, rowBytes);
  }
  if (filter === 1) {
    for (let i = 0; i < rowBytes; i++) {
      const left = i >= bpp ? cur[curOff + i - bpp] : 0;
      const v = (cur[curOff + i] - left) & 0xff;
      dst[i] = v;
      score += v < 128 ? v : 256 - v;
    }
    return score;
  }
  if (filter === 2) {
    for (let i = 0; i < rowBytes; i++) {
      const up = prev ? prev[prevOff + i] : 0;
      const v = (cur[curOff + i] - up) & 0xff;
      dst[i] = v;
      score += v < 128 ? v : 256 - v;
    }
    return score;
  }
  if (filter === 3) {
    for (let i = 0; i < rowBytes; i++) {
      const left = i >= bpp ? cur[curOff + i - bpp] : 0;
      const up = prev ? prev[prevOff + i] : 0;
      const v = (cur[curOff + i] - ((left + up) >> 1)) & 0xff;
      dst[i] = v;
      score += v < 128 ? v : 256 - v;
    }
    return score;
  }
  // Paeth
  for (let i = 0; i < rowBytes; i++) {
    const left = i >= bpp ? cur[curOff + i - bpp] : 0;
    const up = prev ? prev[prevOff + i] : 0;
    const upLeft = i >= bpp && prev ? prev[prevOff + i - bpp] : 0;
    const v = (cur[curOff + i] - paeth(left, up, upLeft)) & 0xff;
    dst[i] = v;
    score += v < 128 ? v : 256 - v;
  }
  return score;
}

// Filters every row of `raw` (rowBytes bytes per row, H rows) with the
// per-row best filter. Returns the filtered stream (H * (1 + rowBytes)).
function filterImage(raw: Buffer, rowBytes: number, bpp: number): Buffer {
  const out = Buffer.alloc(H * (1 + rowBytes));
  const scratch = Buffer.alloc(rowBytes);
  const best = Buffer.alloc(rowBytes);
  for (let y = 0; y < H; y++) {
    const curOff = y * rowBytes;
    const prevOff = y > 0 ? (y - 1) * rowBytes : 0;
    const prev = y > 0 ? raw : null;
    let bestScore = Infinity;
    let bestFilter = 0;
    for (let f = 0; f <= 4; f++) {
      const s = filterRow(scratch, raw, curOff, prev, prevOff, rowBytes, bpp, f);
      if (s < bestScore) {
        bestScore = s;
        bestFilter = f;
        best.set(scratch);
      }
    }
    const outOff = y * (1 + rowBytes);
    out[outOff] = bestFilter;
    best.copy(out, outOff + 1);
  }
  return out;
}

// -------------------------------------------------------------- analysis ---
interface Analysis {
  allOpaque: boolean;
  isGrey: boolean;
  palette: number[]; // packed RGBA ints, first-seen order; length > 256 means "too many"
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

// ------------------------------------------------------------ conversion ---
// Builds the raw (unfiltered) scanlines for one representation.
function toGrey(rgba: Buffer): Buffer {
  const out = Buffer.alloc(PX);
  for (let i = 0; i < PX; i++) out[i] = rgba[i * 4];
  return out;
}

function toGreyAlpha(rgba: Buffer): Buffer {
  const out = Buffer.alloc(PX * 2);
  for (let i = 0; i < PX; i++) {
    out[i * 2] = rgba[i * 4];
    out[i * 2 + 1] = rgba[i * 4 + 3];
  }
  return out;
}

function toRgb(rgba: Buffer): Buffer {
  const out = Buffer.alloc(PX * 3);
  for (let i = 0; i < PX; i++) {
    out[i * 3] = rgba[i * 4];
    out[i * 3 + 1] = rgba[i * 4 + 1];
    out[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return out;
}

function toPalette(rgba: Buffer, index: Map<number, number>): Buffer {
  const out = Buffer.alloc(PX);
  for (let i = 0; i < PX; i++) {
    const o = i * 4;
    const key =
      ((rgba[o] << 24) | (rgba[o + 1] << 16) | (rgba[o + 2] << 8) | rgba[o + 3]) >>> 0;
    out[i] = index.get(key) as number;
  }
  return out;
}

// -------------------------------------------------------------- encoding ---
const DEFLATE_VARIANTS: Array<Record<string, number>> = [
  { level: 9 },
  { level: 9, memLevel: 9 },
  { level: 9, strategy: zlibConstants.Z_FILTERED },
];

function deflateBest(filtered: Buffer): Buffer {
  let best: Buffer | null = null;
  for (const opts of DEFLATE_VARIANTS) {
    const c = deflateSync(filtered, opts);
    if (best === null || c.length < best.length) best = c;
  }
  return best as Buffer;
}

interface Candidate {
  colorType: number;
  raw: Buffer; // unfiltered scanlines
  rowBytes: number;
  bpp: number;
  plte: Buffer | null;
  trns: Buffer | null;
}

function buildPng(c: Candidate): Buffer {
  const filtered = filterImage(c.raw, c.rowBytes, c.bpp);
  const idat = deflateBest(filtered);
  const parts: Buffer[] = [PNG_SIG, ihdr(c.colorType)];
  if (c.plte) parts.push(chunk("PLTE", c.plte));
  if (c.trns) parts.push(chunk("tRNS", c.trns));
  parts.push(chunk("IDAT", idat));
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function encodePng(rgba: Buffer): Buffer {
  const a = analyze(rgba);
  const candidates: Candidate[] = [];
  const fewColors = a.palette.length <= 256;

  if (a.isGrey && a.allOpaque) {
    // Grey, 1 byte/px, no palette overhead: the smallest possible shape.
    candidates.push({
      colorType: 0,
      raw: toGrey(rgba),
      rowBytes: W,
      bpp: 1,
      plte: null,
      trns: null,
    });
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
    // tRNS may drop trailing opaque entries.
    let trns: Buffer | null = null;
    if (needTrns) {
      let last = alphas.length - 1;
      while (last > 0 && alphas[last] === 255) last--;
      trns = Buffer.from(alphas.slice(0, last + 1));
    }
    candidates.push({
      colorType: 3,
      raw: toPalette(rgba, a.paletteIndex),
      rowBytes: W,
      bpp: 1,
      plte,
      trns,
    });
    // A posterised photo can occasionally compress better as truecolour,
    // because RGB filtering exploits smooth colour transitions that palette
    // indices hide; try the truecolour shape too and keep the smaller.
    if (a.isGrey) {
      candidates.push({
        colorType: 4,
        raw: toGreyAlpha(rgba),
        rowBytes: W * 2,
        bpp: 2,
        plte: null,
        trns: null,
      });
    } else if (a.allOpaque) {
      candidates.push({
        colorType: 2,
        raw: toRgb(rgba),
        rowBytes: W * 3,
        bpp: 3,
        plte: null,
        trns: null,
      });
    } else {
      candidates.push({
        colorType: 6,
        raw: rgba,
        rowBytes: W * 4,
        bpp: 4,
        plte: null,
        trns: null,
      });
    }
  } else if (a.isGrey) {
    candidates.push({
      colorType: 4,
      raw: toGreyAlpha(rgba),
      rowBytes: W * 2,
      bpp: 2,
      plte: null,
      trns: null,
    });
  } else if (a.allOpaque) {
    candidates.push({
      colorType: 2,
      raw: toRgb(rgba),
      rowBytes: W * 3,
      bpp: 3,
      plte: null,
      trns: null,
    });
  } else {
    candidates.push({
      colorType: 6,
      raw: rgba,
      rowBytes: W * 4,
      bpp: 4,
      plte: null,
      trns: null,
    });
  }

  let best: Buffer | null = null;
  for (const c of candidates) {
    const png = buildPng(c);
    if (best === null || png.length < best.length) best = png;
  }
  return best as Buffer;
}

// ---------------------------------------------------------------- driver ---
// ------------------------------------------------------------ PNG input ---
// The grader hands each instance as image.png: a stored PNG (colour type 6,
// bit depth 8, every row unfiltered, its zlib stream in stored blocks).
// Decode any bit-depth-8 non-interlaced PNG (colour types 0/2/3/4/6) back to
// raw RGBA, unfiltering rows. Returns null when the file is not such a PNG.
function decodePng(buf: Buffer): Buffer | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
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
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idatParts));
  } catch {
    return null;
  }
  if (raw.length !== H * (1 + rowBytes)) return null;
  const out = Buffer.alloc(PX * 4);
  const prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < H; y++) {
    const f = raw[y * (1 + rowBytes)];
    const row = raw.subarray(y * (1 + rowBytes) + 1, (y + 1) * (1 + rowBytes));
    const recon = Buffer.alloc(rowBytes);
    const bpp = colorType === 3 ? 1 : channels;
    for (let i = 0; i < rowBytes; i++) {
      const left = i >= bpp ? recon[i - bpp] : 0;
      const up = prev[i];
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (f === 1) v = (v + left) & 0xff;
      else if (f === 2) v = (v + up) & 0xff;
      else if (f === 3) v = (v + ((left + up) >> 1)) & 0xff;
      else if (f === 4) v = (v + paeth(left, up, upLeft)) & 0xff;
      else if (f !== 0) return null;
      recon[i] = v;
    }
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      if (colorType === 6) {
        out[o] = recon[x * 4];
        out[o + 1] = recon[x * 4 + 1];
        out[o + 2] = recon[x * 4 + 2];
        out[o + 3] = recon[x * 4 + 3];
      } else if (colorType === 2) {
        out[o] = recon[x * 3];
        out[o + 1] = recon[x * 3 + 1];
        out[o + 2] = recon[x * 3 + 2];
        out[o + 3] = 255;
      } else if (colorType === 0) {
        const g = recon[x];
        out[o] = g;
        out[o + 1] = g;
        out[o + 2] = g;
        out[o + 3] = 255;
      } else if (colorType === 4) {
        const g = recon[x * 2];
        out[o] = g;
        out[o + 1] = g;
        out[o + 2] = g;
        out[o + 3] = recon[x * 2 + 1];
      } else if (colorType === 3) {
        const idx = recon[x];
        if (!plte || idx * 3 + 2 >= plte.length) return null;
        out[o] = plte[idx * 3];
        out[o + 1] = plte[idx * 3 + 1];
        out[o + 2] = plte[idx * 3 + 2];
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
    prev.set(recon);
  }
  return out;
}

// Accepts one input file's bytes as raw RGBA (exactly 3,686,400 bytes) or
// as a PNG (decoded above). Returns null when neither matches.
function asRgba(data: Buffer): Buffer | null {
  if (data.length === RGBA_LEN) return data;
  return decodePng(data);
}

function sanitizeId(id: string): string {
  const clean = String(id).replace(/[^A-Za-z0-9._-]+/g, "_");
  return clean.length > 0 ? clean : "image";
}

interface InputFile {
  name: string; // output base name (without extension)
  data: Buffer; // raw RGBA bytes
}

function collectInputs(inputDir: string): InputFile[] {
  const names = readdirSync(inputDir)
    .filter((n) => {
      try {
        return statSync(join(inputDir, n)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
  const out: InputFile[] = [];

  // A JSON manifest, if present: {"cases": [{"id", "input"}]} or a bare
  // array of the same shape; "input" is a file name in the same directory
  // or base64 raw RGBA.
  const manifestName = names.find((n) => n.toLowerCase().endsWith(".json"));
  if (manifestName) {
    try {
      const parsed = JSON.parse(
        readFileSync(join(inputDir, manifestName), "utf8"),
      );
      const cases: Array<{ id?: string; input?: string }> = Array.isArray(
        parsed,
      )
        ? parsed
        : Array.isArray(parsed.cases)
          ? parsed.cases
          : [];
      for (const c of cases) {
        if (!c || typeof c.input !== "string") continue;
        const id = sanitizeId(c.id ?? basename(c.input));
        const byName = join(inputDir, c.input);
        if (existsSync(byName)) {
          const rgba = asRgba(readFileSync(byName));
          if (rgba) out.push({ name: id, data: rgba });
        } else {
          const data = Buffer.from(c.input, "base64");
          if (data.length === RGBA_LEN) out.push({ name: id, data });
        }
      }
      if (out.length > 0) return out;
    } catch {
      // Fall through to plain-file handling below.
    }
  }

  for (const n of names) {
    if (n.toLowerCase().endsWith(".json")) continue;
    const rgba = asRgba(readFileSync(join(inputDir, n)));
    if (!rgba) {
      process.stderr.write(`skip ${n}: not raw RGBA nor a decodable PNG\n`);
      continue;
    }
    const base = basename(n, extname(n));
    out.push({ name: base.length > 0 ? base : "image", data: rgba });
  }
  return out;
}

function main(): void {
  const inputDir = process.argv[2] || process.env.INPUT_DIR || "/input";
  const outputDir = process.argv[3] || process.env.OUTPUT_DIR || "/output";
  mkdirSync(outputDir, { recursive: true });
  const inputs = collectInputs(inputDir);
  if (inputs.length === 0) {
    process.stderr.write(`no 1280x720 RGBA inputs found in ${inputDir}\n`);
    process.exit(1);
  }
  for (const f of inputs) {
    const png = encodePng(f.data);
    writeFileSync(join(outputDir, `${f.name}.png`), png);
    process.stderr.write(`${f.name}: ${f.data.length} -> ${png.length} bytes\n`);
  }
}

main();
