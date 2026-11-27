// png-squeeze: lossless PNG re-encoder.
//
// Contract (from the competition rules):
//   input : /input/<id>/image.png   (one subdirectory per instance, id = i001..i008)
//   output: /output/<id>/image.png  (this program creates the <id> subdirectory)
// The encoder re-encodes each image losslessly (every pixel identical,
// including the RGB of fully transparent pixels) into the smallest PNG it
// can produce: bit depth 8, non-interlaced, color type 0/2/3/4/6, chunks
// limited to IHDR/PLTE/tRNS/IDAT/IEND, and exactly one IDAT chunk.
//
// Node built-ins only (node:fs, node:path, node:zlib). No packages, no
// network. The driver at the bottom is fault tolerant: one bad instance
// never fails the run, and the process always exits 0.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { deflateSync, inflateSync, constants as ZC } from 'node:zlib';

// ---------------------------------------------------------------------------
// CRC32 (PNG chunk checksums)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// ---------------------------------------------------------------------------
// PNG decoding -> raw RGBA
// Supports color types 0/2/3/4/6, bit depth 8, non-interlaced.
// Also accepts a raw RGBA dump of exactly 1280*720*4 = 3,686,400 bytes.
// Returns { width, height, rgba } or null when undecodable.
// ---------------------------------------------------------------------------

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const RAW_RGBA_BYTES = 1280 * 720 * 4;

function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let plte = null;
  let trns = null;
  const idatParts = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) return null;
    const data = buf.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      plte = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos = dataEnd + 4;
  }
  if (!width || !height || colorType < 0 || bitDepth !== 8 || interlace !== 0) {
    return null;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) return null;
  if (colorType === 3 && !plte) return null;

  let raw;
  try {
    raw = inflateSync(Buffer.concat(idatParts));
  } catch {
    return null;
  }
  const rowBytes = width * channels;
  if (raw.length < (rowBytes + 1) * height) return null;

  // Unfilter into packed pixel bytes.
  const px = Buffer.alloc(rowBytes * height);
  let prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (rowBytes + 1)];
    const rowOff = y * (rowBytes + 1) + 1;
    const outOff = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const v = raw[rowOff + x];
      const a = x >= channels ? px[outOff + x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let r;
      if (f === 0) r = v;
      else if (f === 1) r = (v + a) & 0xff;
      else if (f === 2) r = (v + b) & 0xff;
      else if (f === 3) r = (v + ((a + b) >> 1)) & 0xff;
      else if (f === 4) r = (v + paeth(a, b, c)) & 0xff;
      else return null;
      px[outOff + x] = r;
    }
    prev = px.subarray(outOff, outOff + rowBytes);
  }

  // Expand to RGBA. tRNS values for bit depth 8 are stored as 16-bit fields
  // whose numeric value equals the 8-bit sample.
  const rgba = Buffer.alloc(width * height * 4);
  if (colorType === 6) {
    px.copy(rgba);
  } else if (colorType === 2) {
    let tr = -1;
    let tg = -1;
    let tb = -1;
    if (trns && trns.length >= 6) {
      tr = trns.readUInt16BE(0);
      tg = trns.readUInt16BE(2);
      tb = trns.readUInt16BE(4);
    }
    for (let i = 0, j = 0; i < px.length; i += 3, j += 4) {
      rgba[j] = px[i];
      rgba[j + 1] = px[i + 1];
      rgba[j + 2] = px[i + 2];
      rgba[j + 3] =
        tr >= 0 && px[i] === tr && px[i + 1] === tg && px[i + 2] === tb ? 0 : 255;
    }
  } else if (colorType === 0) {
    let tg = -1;
    if (trns && trns.length >= 2) tg = trns.readUInt16BE(0);
    for (let i = 0, j = 0; i < px.length; i++, j += 4) {
      const g = px[i];
      rgba[j] = g;
      rgba[j + 1] = g;
      rgba[j + 2] = g;
      rgba[j + 3] = tg >= 0 && g === tg ? 0 : 255;
    }
  } else if (colorType === 4) {
    for (let i = 0, j = 0; i < px.length; i += 2, j += 4) {
      const g = px[i];
      rgba[j] = g;
      rgba[j + 1] = g;
      rgba[j + 2] = g;
      rgba[j + 3] = px[i + 1];
    }
  } else if (colorType === 3) {
    for (let i = 0, j = 0; i < px.length; i++, j += 4) {
      const idx = px[i];
      const p = idx * 3;
      rgba[j] = p + 2 < plte.length ? plte[p] : 0;
      rgba[j + 1] = p + 2 < plte.length ? plte[p + 1] : 0;
      rgba[j + 2] = p + 2 < plte.length ? plte[p + 2] : 0;
      rgba[j + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }
  return { width, height, rgba };
}

function decodeAny(buf) {
  const png = decodePng(buf);
  if (png) return png;
  if (buf.length === RAW_RGBA_BYTES) {
    return { width: 1280, height: 720, rgba: Buffer.from(buf) };
  }
  return null;
}

function loadImage(path) {
  try {
    return decodeAny(readFileSync(path));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PNG encoding: pick the smallest lossless representation.
// ---------------------------------------------------------------------------

function analyze(rgba) {
  let allGrey = true;
  let allOpaque = true;
  const colors = new Map(); // rgba uint32 -> palette index (first-appearance order)
  let overflow = false;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const a = rgba[i + 3];
    if (r !== g || g !== b) allGrey = false;
    if (a !== 255) allOpaque = false;
    if (!overflow) {
      const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      if (!colors.has(key)) {
        colors.set(key, colors.size);
        if (colors.size > 256) overflow = true;
      }
    }
  }
  return { allGrey, allOpaque, colors: overflow ? null : colors };
}

// Pack RGBA pixels into the byte layout of the given color type.
function packRows(rgba, colorType, colors) {
  const n = rgba.length / 4;
  if (colorType === 6) return Buffer.from(rgba);
  if (colorType === 2) {
    const out = Buffer.alloc(n * 3);
    for (let i = 0, j = 0; j < rgba.length; i += 3, j += 4) {
      out[i] = rgba[j];
      out[i + 1] = rgba[j + 1];
      out[i + 2] = rgba[j + 2];
    }
    return out;
  }
  if (colorType === 0) {
    const out = Buffer.alloc(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = rgba[j];
    return out;
  }
  if (colorType === 4) {
    const out = Buffer.alloc(n * 2);
    for (let i = 0, j = 0; j < rgba.length; i += 2, j += 4) {
      out[i] = rgba[j];
      out[i + 1] = rgba[j + 3];
    }
    return out;
  }
  // colorType === 3: palette indices
  const out = Buffer.alloc(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const key =
      ((rgba[j] << 24) | (rgba[j + 1] << 16) | (rgba[j + 2] << 8) | rgba[j + 3]) >>> 0;
    out[i] = colors.get(key);
  }
  return out;
}

// Filter every row with all 5 PNG filters; keep, per row, the filter whose
// output has the smallest sum of absolute signed byte values.
function filterStream(packed, width, height, bpp) {
  const rowBytes = width * bpp;
  const out = Buffer.alloc((rowBytes + 1) * height);
  const cand = Buffer.alloc(rowBytes);
  let prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const row = packed.subarray(y * rowBytes, (y + 1) * rowBytes);
    let bestType = 0;
    let bestCost = Infinity;
    let bestRow = null;
    for (let f = 0; f < 5; f++) {
      let cost = 0;
      for (let x = 0; x < rowBytes; x++) {
        const a = x >= bpp ? row[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        let pred = 0;
        if (f === 1) pred = a;
        else if (f === 2) pred = b;
        else if (f === 3) pred = (a + b) >> 1;
        else if (f === 4) pred = paeth(a, b, c);
        const d = (row[x] - pred) & 0xff;
        cand[x] = d;
        cost += d < 128 ? d : 256 - d;
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestType = f;
        bestRow = Buffer.from(cand);
      }
    }
    const outOff = y * (rowBytes + 1);
    out[outOff] = bestType;
    bestRow.copy(out, outOff + 1);
    prev = Buffer.from(row);
  }
  return out;
}

function deflateBest(stream, bpp) {
  const tries = [
    { level: 9, memLevel: 9, strategy: ZC.Z_FILTERED },
    { level: 9, memLevel: 9, strategy: ZC.Z_DEFAULT_STRATEGY },
  ];
  if (bpp <= 2) tries.push({ level: 9, memLevel: 9, strategy: ZC.Z_RLE });
  let best = null;
  for (const opts of tries) {
    const z = deflateSync(stream, opts);
    if (!best || z.length < best.length) best = z;
  }
  return best;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodeCandidate(width, height, rgba, colorType, colors) {
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const packed = packRows(rgba, colorType, colors);
  const stream = filterStream(packed, width, height, bpp);
  const idat = deflateBest(stream, bpp);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // non-interlaced

  const parts = [PNG_SIG, chunk('IHDR', ihdr)];
  if (colorType === 3) {
    const plte = Buffer.alloc(colors.size * 3);
    const alphas = new Uint8Array(colors.size).fill(255);
    for (const [key, idx] of colors) {
      plte[idx * 3] = (key >>> 24) & 0xff;
      plte[idx * 3 + 1] = (key >>> 16) & 0xff;
      plte[idx * 3 + 2] = (key >>> 8) & 0xff;
      alphas[idx] = key & 0xff;
    }
    parts.push(chunk('PLTE', plte));
    let lastAlpha = -1;
    for (let i = 0; i < alphas.length; i++) {
      if (alphas[i] !== 255) lastAlpha = i;
    }
    if (lastAlpha >= 0) {
      parts.push(chunk('tRNS', Buffer.from(alphas.subarray(0, lastAlpha + 1))));
    }
  }
  parts.push(chunk('IDAT', idat)); // exactly one IDAT chunk
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function encodePng(width, height, rgba) {
  const { allGrey, allOpaque, colors } = analyze(rgba);
  const candidates = [];
  if (allGrey && allOpaque) {
    candidates.push(0);
    if (colors) candidates.push(3);
  } else if (allGrey) {
    candidates.push(4);
    if (colors) candidates.push(3);
  } else if (colors) {
    candidates.push(3);
  } else if (allOpaque) {
    candidates.push(2);
  } else {
    candidates.push(6);
  }
  let best = null;
  for (const ct of candidates) {
    const out = encodeCandidate(width, height, rgba, ct, colors);
    if (!best || out.length < best.length) best = out;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Driver
//
// Input dir : MAKEFUN_INPUT_DIR -> argv[2] -> INPUT_DIR -> /input
// Output dir: MAKEFUN_OUTPUT_DIR -> argv[3] -> OUTPUT_DIR -> /output
//
// Main path: every subdirectory <id> of the input dir that contains an
// image.png (or any other decodable image/raw file) is one instance; its
// answer goes to <output>/<id>/image.png, creating the subdirectory.
// Fallback (only when the main path finds no instance at all): flat image
// files in the input dir and files referenced by a JSON manifest are
// written to <output>/<basename>.png (or <output>/<id>/image.png when a
// manifest entry carries an id).
//
// Every instance is isolated in try/catch; the process always exits 0.
// Nothing is ever deleted, the input dir and the program dir are never
// written to, and no path depends on the current working directory.
// ---------------------------------------------------------------------------

function resolveDirs() {
  const inputDir =
    process.env.MAKEFUN_INPUT_DIR || process.argv[2] || process.env.INPUT_DIR || '/input';
  const outputDir =
    process.env.MAKEFUN_OUTPUT_DIR ||
    process.argv[3] ||
    process.env.OUTPUT_DIR ||
    '/output';
  return { inputDir, outputDir };
}

function listEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function sortedNames(entries, wantDirs) {
  return entries
    .filter((e) => (wantDirs ? e.isDirectory() : e.isFile()))
    .map((e) => e.name)
    .sort();
}

// First decodable image in a directory: image.png first, then the other
// files in sorted order. Returns the decoded image or null.
function firstImageIn(dir) {
  const names = sortedNames(listEntries(dir), false);
  const ordered = [];
  if (names.includes('image.png')) ordered.push('image.png');
  for (const n of names) if (n !== 'image.png') ordered.push(n);
  for (const n of ordered) {
    const img = loadImage(join(dir, n));
    if (img) return img;
  }
  return null;
}

function writeAnswer(img, destPath) {
  const out = encodePng(img.width, img.height, img.rgba);
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, out);
  return out.length;
}

// Collect { id, path } references from a parsed JSON manifest, tolerating
// arrays of strings/objects and objects with cases/items/files lists.
function manifestRefs(node, refs, seen) {
  if (node == null || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) manifestRefs(item, refs, seen);
    return;
  }
  const pathVal =
    typeof node.path === 'string'
      ? node.path
      : typeof node.file === 'string'
        ? node.file
        : typeof node.input === 'string'
          ? node.input
          : typeof node.src === 'string'
            ? node.src
            : null;
  if (pathVal) {
    const id =
      typeof node.id === 'string'
        ? node.id
        : typeof node.name === 'string'
          ? node.name
          : null;
    refs.push({ id, path: pathVal });
  }
  for (const v of Object.values(node)) manifestRefs(v, refs, seen);
}

function runFallback(inputDir, outputDir) {
  let done = 0;
  const handledSrc = new Set();

  // Flat image files in the input dir (first level only).
  for (const name of sortedNames(listEntries(inputDir), false)) {
    if (name.toLowerCase().endsWith('.json')) continue;
    const src = join(inputDir, name);
    try {
      const img = loadImage(src);
      if (!img) continue;
      const base = basename(name, extname(name));
      writeAnswer(img, join(outputDir, base + '.png'));
      handledSrc.add(src);
      done++;
    } catch (e) {
      console.error(`png-squeeze: fallback file ${name} failed: ${e.message}`);
    }
  }

  // JSON manifests: cases.json first, then any other .json file.
  const jsonNames = sortedNames(listEntries(inputDir), false).filter((n) =>
    n.toLowerCase().endsWith('.json'),
  );
  jsonNames.sort((a, b) =>
    a === 'cases.json' ? -1 : b === 'cases.json' ? 1 : a < b ? -1 : a > b ? 1 : 0,
  );
  for (const name of jsonNames) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(inputDir, name), 'utf8'));
    } catch {
      continue;
    }
    const refs = [];
    manifestRefs(parsed, refs, new Set());
    for (const ref of refs) {
      const src = ref.path.startsWith('/') ? ref.path : join(inputDir, ref.path);
      if (handledSrc.has(src)) continue;
      try {
        const img = loadImage(src);
        if (!img) continue;
        const dest = ref.id
          ? join(outputDir, ref.id, 'image.png')
          : join(outputDir, basename(src, extname(src)) + '.png');
        writeAnswer(img, dest);
        handledSrc.add(src);
        done++;
      } catch (e) {
        console.error(`png-squeeze: manifest ref ${ref.path} failed: ${e.message}`);
      }
    }
  }
  return done;
}

function main() {
  const { inputDir, outputDir } = resolveDirs();
  let done = 0;

  // Main path: one subdirectory per instance.
  for (const id of sortedNames(listEntries(inputDir), true)) {
    try {
      const img = firstImageIn(join(inputDir, id));
      if (!img) continue;
      const size = writeAnswer(img, join(outputDir, id, 'image.png'));
      console.error(`png-squeeze: ${id} -> ${id}/image.png (${size} bytes)`);
      done++;
    } catch (e) {
      console.error(`png-squeeze: instance ${id} skipped: ${e.message}`);
    }
  }

  // Fallback only when no instance was found at all.
  if (done === 0) {
    try {
      done = runFallback(inputDir, outputDir);
    } catch (e) {
      console.error(`png-squeeze: fallback failed: ${e.message}`);
    }
  }

  if (done === 0) {
    console.error(`png-squeeze: no decodable input found under ${inputDir}`);
  }
}

try {
  main();
} catch (e) {
  console.error(`png-squeeze: fatal (ignored, exiting 0): ${e && e.message}`);
}
// Always exit 0: falling off the end with no pending work.
