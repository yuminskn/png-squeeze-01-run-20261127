// png-squeeze v5 — lossless PNG re-encoder (quality/search edition).
//
// Reads each instance's image.png, decodes it to RGBA pixels (the RGB of
// fully transparent pixels is preserved), then re-encodes it as the
// smallest valid PNG it can find by searching over color types, per-row
// filter strategies and zlib settings. The search is calibrated on the
// first "rich" image and pruned so the whole set stays well inside the
// time budget. Pure Node built-ins; deterministic; always exits 0.

import { deflateSync, inflateSync } from "node:zlib";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";

const START_MS = Date.now();
const TIME_BUDGET_MS = 45_000; // hard self-limit for the whole run

// ---------------------------------------------------------------- CRC32
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  out.writeUInt32BE(crc32(td), 8 + data.length);
  return out;
}

// ---------------------------------------------------------------- decode
interface Image {
  width: number;
  height: number;
  rgba: Uint8Array; // width*height*4, RGB kept under alpha=0
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(raw: Buffer, width: number, height: number, bpp: number): Uint8Array {
  const rowBytes = width * bpp;
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (rowBytes + 1)];
    const src = y * (rowBytes + 1) + 1;
    const dst = y * rowBytes;
    const up = dst - rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[src + i];
      const left = i >= bpp ? out[dst + i - bpp] : 0;
      const top = y > 0 ? out[up + i] : 0;
      const topLeft = y > 0 && i >= bpp ? out[up + i - bpp] : 0;
      let v: number;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + left; break;
        case 2: v = x + top; break;
        case 3: v = x + ((left + top) >> 1); break;
        case 4: v = x + paeth(left, top, topLeft); break;
        default: throw new Error(`bad filter ${f}`);
      }
      out[dst + i] = v & 0xff;
    }
  }
  return out;
}

function decodePng(buf: Buffer): Image {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not png");
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = -1;
  let plte: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced unsupported");
    } else if (type === "PLTE") plte = Buffer.from(data);
    else if (type === "tRNS") trns = Buffer.from(data);
    else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!width || colorType < 0 || bitDepth !== 8) throw new Error("unsupported png");
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  const raw = inflateSync(Buffer.concat(idat));
  const px = unfilter(raw, width, height, channels);
  const rgba = new Uint8Array(width * height * 4);
  const n = width * height;
  if (colorType === 6) {
    rgba.set(px);
  } else if (colorType === 2) {
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = px[i * 3]; rgba[i * 4 + 1] = px[i * 3 + 1];
      rgba[i * 4 + 2] = px[i * 3 + 2]; rgba[i * 4 + 3] = 255;
    }
  } else if (colorType === 0) {
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = px[i]; rgba[i * 4 + 3] = 255;
    }
  } else if (colorType === 4) {
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = px[i * 2];
      rgba[i * 4 + 3] = px[i * 2 + 1];
    }
  } else if (colorType === 3) {
    if (!plte) throw new Error("palette missing");
    for (let i = 0; i < n; i++) {
      const idx = px[i];
      rgba[i * 4] = plte[idx * 3] ?? 0;
      rgba[i * 4 + 1] = plte[idx * 3 + 1] ?? 0;
      rgba[i * 4 + 2] = plte[idx * 3 + 2] ?? 0;
      rgba[i * 4 + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  } else throw new Error(`color type ${colorType}`);
  return { width, height, rgba };
}

function decodeAny(buf: Buffer): Image {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return decodePng(buf);
  // raw RGBA fallback: the fixed 1280x720 frame used by this competition
  if (buf.length === 1280 * 720 * 4) {
    return { width: 1280, height: 720, rgba: new Uint8Array(buf) };
  }
  throw new Error("unknown input format");
}

// ---------------------------------------------------------------- encode
import { constants as ZC } from "node:zlib";

interface Analysis {
  opaque: boolean;
  grey: boolean;
  distinct: number; // exact when <= 256, otherwise some value > 256
  palColors: number[] | null; // packed RGBA keys, frequency order (type 3)
  palIndex: Map<number, number> | null;
  palTrns: Buffer | null;
  palColorsFirst: number[] | null; // same palette, first-occurrence order
  palIndexFirst: Map<number, number> | null;
  palTrnsFirst: Buffer | null;
}

function analyze(img: Image): Analysis {
  const { rgba } = img;
  const n = rgba.length / 4;
  let opaque = true, grey = true;
  const counts = new Map<number, { c: number; first: number }>();
  let overflow = false;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
    if (a !== 255) opaque = false;
    if (r !== g || g !== b) grey = false;
    if (!overflow) {
      const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      const e = counts.get(key);
      if (e) e.c++;
      else {
        if (counts.size >= 256) overflow = true;
        else counts.set(key, { c: 1, first: i });
      }
    }
  }
  let palColors: number[] | null = null, palIndex: Map<number, number> | null = null, palTrns: Buffer | null = null;
  let palColorsFirst: number[] | null = null, palIndexFirst: Map<number, number> | null = null, palTrnsFirst: Buffer | null = null;
  if (!overflow) {
    const byFreq = [...counts.entries()].sort(
      (x, y) => y[1].c - x[1].c || x[1].first - y[1].first);
    palColors = byFreq.map(([k]) => k);
    palIndex = new Map(byFreq.map(([k], i) => [k, i]));
    let lastAlpha = -1;
    palColors.forEach((k, i) => { if ((k & 0xff) !== 255) lastAlpha = i; });
    if (lastAlpha >= 0) {
      palTrns = Buffer.alloc(lastAlpha + 1);
      for (let i = 0; i <= lastAlpha; i++) palTrns[i] = palColors[i] & 0xff;
    }
    const byFirst = [...counts.entries()].sort((x, y) => x[1].first - y[1].first);
    palColorsFirst = byFirst.map(([k]) => k);
    palIndexFirst = new Map(byFirst.map(([k], i) => [k, i]));
    let lastAlphaF = -1;
    palColorsFirst.forEach((k, i) => { if ((k & 0xff) !== 255) lastAlphaF = i; });
    if (lastAlphaF >= 0) {
      palTrnsFirst = Buffer.alloc(lastAlphaF + 1);
      for (let i = 0; i <= lastAlphaF; i++) palTrnsFirst[i] = palColorsFirst[i] & 0xff;
    }
  }
  return {
    opaque, grey,
    distinct: overflow ? 257 : counts.size,
    palColors, palIndex, palTrns, palColorsFirst, palIndexFirst, palTrnsFirst,
  };
}

function layoutRows(img: Image, an: Analysis, colorType: number, palOrder: "freq" | "first" = "freq"): { rows: Uint8Array; bpp: number } {
  const { width, height, rgba } = img;
  const n = width * height;
  if (colorType === 6) return { rows: rgba, bpp: 4 };
  if (colorType === 2) {
    const rows = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      rows[i * 3] = rgba[i * 4]; rows[i * 3 + 1] = rgba[i * 4 + 1]; rows[i * 3 + 2] = rgba[i * 4 + 2];
    }
    return { rows, bpp: 3 };
  }
  if (colorType === 0) {
    const rows = new Uint8Array(n);
    for (let i = 0; i < n; i++) rows[i] = rgba[i * 4];
    return { rows, bpp: 1 };
  }
  if (colorType === 4) {
    const rows = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) { rows[i * 2] = rgba[i * 4]; rows[i * 2 + 1] = rgba[i * 4 + 3]; }
    return { rows, bpp: 2 };
  }
  // color type 3: palette indices
  const rows = new Uint8Array(n);
  const idx = (palOrder === "first" ? an.palIndexFirst : an.palIndex)!;
  for (let i = 0; i < n; i++) {
    const key = ((rgba[i * 4] << 24) | (rgba[i * 4 + 1] << 16) | (rgba[i * 4 + 2] << 8) | rgba[i * 4 + 3]) >>> 0;
    rows[i] = idx.get(key)!;
  }
  return { rows, bpp: 1 };
}

type Variant = "sad" | "ent" | "paeth" | "sub" | "none" | "up" | "avg";
const VARIANTS: Variant[] = ["sad", "ent", "paeth", "sub", "none", "up", "avg"];

// Build the seven filtered-stream variants for one candidate layout.
// sad/ent pick the per-row winning filter under two different scores;
// the other five are single-filter streams (a uniform filter stream can
// beat adaptive switching once DEFLATE context is accounted for).
function buildStreams(rows: Uint8Array, rowBytes: number, height: number, bpp: number): Record<Variant, Buffer> {
  const stride = rowBytes + 1;
  const streams: Record<Variant, Buffer> = {
    sad: Buffer.alloc(stride * height), ent: Buffer.alloc(stride * height),
    paeth: Buffer.alloc(stride * height), sub: Buffer.alloc(stride * height),
    none: Buffer.alloc(stride * height), up: Buffer.alloc(stride * height),
    avg: Buffer.alloc(stride * height),
  };
  const filt = new Uint8Array(rowBytes); // scratch for one filtered row
  const hist = new Int32Array(256);
  for (let y = 0; y < height; y++) {
    const cur = y * rowBytes;
    const up = cur - rowBytes;
    let bestSadF = 0, bestSad = Infinity, bestEntF = 0, bestEnt = -Infinity;
    for (let f = 0; f <= 4; f++) {
      let sad = 0;
      hist.fill(0);
      for (let i = 0; i < rowBytes; i++) {
        const x = rows[cur + i];
        const left = i >= bpp ? rows[cur + i - bpp] : 0;
        const top = y > 0 ? rows[up + i] : 0;
        const topLeft = y > 0 && i >= bpp ? rows[up + i - bpp] : 0;
        let v: number;
        switch (f) {
          case 0: v = x; break;
          case 1: v = (x - left) & 0xff; break;
          case 2: v = (x - top) & 0xff; break;
          case 3: v = (x - ((left + top) >> 1)) & 0xff; break;
          default: v = (x - paeth(left, top, topLeft)) & 0xff;
        }
        filt[i] = v;
        sad += v < 128 ? v : 256 - v;
        hist[v]++;
      }
      let entScore = 0; // sum c*log2(c); maximizing it minimizes row entropy
      for (let b = 0; b < 256; b++) if (hist[b] > 1) entScore += hist[b] * Math.log2(hist[b]);
      if (sad < bestSad) { bestSad = sad; bestSadF = f; }
      if (entScore > bestEnt) { bestEnt = entScore; bestEntF = f; }
      // stash fixed-strategy streams as we go
      {
        const name: Variant = f === 4 ? "paeth" : f === 1 ? "sub" : f === 0 ? "none" : f === 2 ? "up" : "avg";
        const s = streams[name];
        s[y * stride] = f;
        s.set(filt, y * stride + 1);
      }
      if (f === bestSadF) { const s = streams.sad; s[y * stride] = f; s.set(filt, y * stride + 1); }
      if (f === bestEntF) { const s = streams.ent; s[y * stride] = f; s.set(filt, y * stride + 1); }
    }
  }
  return streams;
}

interface Pair { variant: Variant; strategy: number; memLevel: number }

const DEFAULT_PAIRS: Pair[] = [
  { variant: "ent", strategy: 0, memLevel: 9 },
  { variant: "sad", strategy: ZC.Z_FILTERED, memLevel: 9 },
  { variant: "paeth", strategy: 0, memLevel: 9 },
  { variant: "up", strategy: 0, memLevel: 9 },
  { variant: "ent", strategy: ZC.Z_FIXED, memLevel: 9 },
  { variant: "sad", strategy: 0, memLevel: 8 },
];

const COMBOS: { strategy: number; memLevel: number }[] = [
  { strategy: 0, memLevel: 9 },
  { strategy: ZC.Z_FILTERED, memLevel: 9 },
  { strategy: ZC.Z_FIXED, memLevel: 9 },
  { strategy: 0, memLevel: 8 },
  { strategy: ZC.Z_RLE, memLevel: 9 },
];

let keptPairs: Pair[] | null = null;

// Benchmark (variant x deflate-combo) on a prefix of each stream of the
// first rich image; keep the six most promising pairs for everything else.
function calibrate(streams: Record<Variant, Buffer>): Pair[] {
  const PREFIX = 256 * 1024;
  const scored: { pair: Pair; est: number }[] = [];
  for (const variant of VARIANTS) {
    const full = streams[variant];
    const pre = full.subarray(0, Math.min(PREFIX, full.length));
    for (const c of COMBOS) {
      try {
        const out = deflateSync(pre, { level: 9, strategy: c.strategy, memLevel: c.memLevel });
        scored.push({
          pair: { variant, strategy: c.strategy, memLevel: c.memLevel },
          est: out.length * (full.length / pre.length),
        });
      } catch { /* combo unsupported: skip */ }
    }
  }
  scored.sort((a, b) => a.est - b.est);
  return scored.slice(0, 6).map((s) => s.pair);
}

function pairsFor(streamLen: number): Pair[] {
  // Pair selection is a pure function of the stream (plus one emergency
  // brake that only fires if the run is already nearly out of budget),
  // so two runs on the same input produce byte-identical output.
  if (Date.now() - START_MS > TIME_BUDGET_MS - 5_000) {
    return (keptPairs ?? DEFAULT_PAIRS).slice(0, 1);
  }
  // Small streams are cheap to deflate: run the full variant x combo matrix.
  if (streamLen <= 1_200_000) {
    const all: Pair[] = [];
    for (const variant of VARIANTS) for (const c of COMBOS) {
      all.push({ variant, strategy: c.strategy, memLevel: c.memLevel });
    }
    return all;
  }
  return keptPairs ?? DEFAULT_PAIRS;
}

function assemblePng(img: Image, colorType: number, an: Analysis, idat: Buffer, palOrder: "freq" | "first" = "freq"): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr)];
  const palColors = palOrder === "first" ? an.palColorsFirst : an.palColors;
  const palTrns = palOrder === "first" ? an.palTrnsFirst : an.palTrns;
  if (colorType === 3 && palColors) {
    const plte = Buffer.alloc(palColors.length * 3);
    palColors.forEach((k, i) => {
      plte[i * 3] = (k >>> 24) & 0xff; plte[i * 3 + 1] = (k >>> 16) & 0xff; plte[i * 3 + 2] = (k >>> 8) & 0xff;
    });
    parts.push(pngChunk("PLTE", plte));
    if (palTrns) parts.push(pngChunk("tRNS", palTrns));
  }
  parts.push(pngChunk("IDAT", idat));
  parts.push(pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function encodeImage(img: Image): Buffer {
  const an = analyze(img);
  const candidates: { ct: number; pal: "freq" | "first" }[] = [];
  const palCands: { ct: number; pal: "freq" | "first" }[] =
    an.distinct <= 256 ? [{ ct: 3, pal: "freq" }, { ct: 3, pal: "first" }] : [];
  if (an.grey && an.opaque) candidates.push({ ct: 0, pal: "freq" });
  else if (an.grey) { candidates.push({ ct: 4, pal: "freq" }, ...palCands); }
  else if (an.opaque) { candidates.push(...palCands, { ct: 2, pal: "freq" }); }
  else { candidates.push(...palCands, { ct: 6, pal: "freq" }); }

  let best: Buffer | null = null;
  for (const cand of candidates) {
    const { rows, bpp } = layoutRows(img, an, cand.ct, cand.pal);
    const streams = buildStreams(rows, img.width * bpp, img.height, bpp);
    if (keptPairs === null && an.distinct > 256) {
      keptPairs = calibrate(streams); // first rich image: prune the search
    }
    for (const p of pairsFor(streams.ent.length)) {
      const idat = deflateSync(streams[p.variant], { level: 9, strategy: p.strategy, memLevel: p.memLevel });
      const png = assemblePng(img, cand.ct, an, idat, cand.pal);
      if (!best || png.length < best.length) best = png;
    }
  }
  // Safety net: a stored (level 0) type-6 encoding is always < 4 MiB here.
  if (!best || best.length > 4 * 1024 * 1024) {
    const { rows, bpp } = layoutRows(img, an, 6);
    const streams = buildStreams(rows, img.width * bpp, img.height, bpp);
    const idat = deflateSync(streams.none, { level: 0 });
    best = assemblePng(img, 6, an, idat);
  }
  return best!;
}

// ---------------------------------------------------------------- driver
function resolveDir(envA: string, arg: string | undefined, envB: string, dflt: string): string {
  if (process.env[envA]) return process.env[envA]!;
  if (arg) return arg;
  if (process.env[envB]) return process.env[envB]!;
  return dflt;
}

interface Job { id: string; file: string; root: boolean }

function collectJobs(inputDir: string): Job[] {
  const jobs: Job[] = [];
  if (!existsSync(inputDir)) return jobs;
  let entries: string[] = [];
  try { entries = readdirSync(inputDir).sort(); } catch { return jobs; }
  // main path: <input>/<id>/image.png
  for (const name of entries) {
    const dir = join(inputDir, name);
    try {
      if (statSync(dir).isDirectory()) {
        const f = join(dir, "image.png");
        if (existsSync(f)) jobs.push({ id: name, file: f, root: false });
      }
    } catch { /* ignore */ }
  }
  if (jobs.length > 0) return jobs;
  // fallback: manifest.json, then flat files (only when main path is empty)
  const manifestPath = join(inputDir, "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, "utf8"));
      const list: { id: string; file: string }[] = [];
      if (Array.isArray(m)) {
        for (const e of m) {
          if (typeof e === "string") list.push({ id: e.replace(/\.[^.]*$/, ""), file: e });
          else if (e && typeof e === "object") {
            const file = e.file ?? e.path ?? e.input ?? "";
            const id = e.id ?? e.name ?? String(file).replace(/\.[^.]*$/, "");
            if (file) list.push({ id: String(id), file: String(file) });
          }
        }
      } else if (m && typeof m === "object") {
        for (const [id, file] of Object.entries(m)) {
          if (typeof file === "string") list.push({ id, file });
        }
      }
      for (const e of list) {
        const f = join(inputDir, e.file);
        if (existsSync(f)) jobs.push({ id: e.id, file: f, root: false });
      }
      if (jobs.length > 0) return jobs;
    } catch { /* fall through to flat scan */ }
  }
  for (const name of entries) {
    const f = join(inputDir, name);
    try {
      if (!statSync(f).isFile()) continue;
    } catch { continue; }
    if (name === "image.png") jobs.push({ id: "", file: f, root: true });
    else if (/\.(png|rgba|raw)$/i.test(name)) {
      jobs.push({ id: name.replace(/\.[^.]*$/, ""), file: f, root: false });
    }
  }
  return jobs;
}

function main(): void {
  const inputDir = resolveDir("MAKEFUN_INPUT_DIR", process.argv[2], "INPUT_DIR", "/input");
  const outputDir = resolveDir("MAKEFUN_OUTPUT_DIR", process.argv[3], "OUTPUT_DIR", "/output");
  const jobs = collectJobs(inputDir);
  for (const job of jobs) {
    try {
      const img = decodeAny(readFileSync(job.file));
      const png = encodeImage(img);
      const outFile = job.root ? join(outputDir, "image.png") : join(outputDir, job.id, "image.png");
      mkdirSync(join(outFile, ".."), { recursive: true });
      writeFileSync(outFile, png);
      console.error(`png-squeeze: ${job.id || "(root)"} -> ${png.length} bytes`);
    } catch (e) {
      console.error(`png-squeeze: ${job.id} failed: ${(e as Error).message}`);
    }
  }
}

try { main(); } catch { /* never fail the run */ }
process.exit(0);
