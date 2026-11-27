# HANDOFF — png-squeeze-01-run-20261127

## ⭐ CURRENT VERSION — full rewrite of main.ts (2026-11-27, supersedes everything below)

The previous main.ts (builder-written, then hand-edited by the main line)
was rejected at submission time by make.fun's transcript-consistency
check: the submitted source must be reproducible from the building
session's record. The current main.ts was therefore rewritten FROM
SCRATCH from the spec, in a single session, in two write passes, without
reading the old file. The sections below describe the superseded version
and are kept for history only.

- main.ts rewrite commit: `be739176e7fd101d17f8e324ccd8ef59a8828d11`
  (on top of `0de562b`, anchor history intact: de96253 → 654d6cf → 0de562b → be73917)
- main.ts size: ≈17.2 KB. Node built-ins only (node:fs / node:path /
  node:zlib); no packages, no network, no randomness, no timestamps.
- Inputs: PNG files (own chunk parser + inflate + all-5-filter unfilter,
  colour types 0/2/3/4/6, bit depth 8, non-interlaced, 1280×720), raw
  RGBA files (exactly 3,686,400 bytes), and a JSON manifest (cases.json:
  {"cases":[{"id","input"}]} or bare array; input = sibling file name or
  base64 raw RGBA). Unrecognised files are skipped with a stderr note.
- Outputs: one `<basename>.png` per input into argv[3] / OUTPUT_DIR /
  /output (mkdir -p; the output directory itself is never removed).
- Encoding: per-image analysis picks colour type (grey 0 / palette 3
  +tRNS / grey+alpha 4 / RGB 2 / RGBA 6; multiple candidates built, the
  smallest kept); per-row adaptive filtering (all 5 filters, min
  signed-abs cost); DEFLATE tried at level 9 / level 9+memLevel 9 /
  level 9+Z_FILTERED, smallest kept. Output chunks: IHDR/PLTE/tRNS/
  IDAT/IEND only, bit depth 8, non-interlaced.

### Verification (independent Python decoder, /tmp/pngtest3/verify.py)

4 synthetic 1280×720 images × 2 input forms (stored PNG in the house
format + raw RGBA) = 8 inputs; every output independently decoded and
compared against the source RGBA:

| image | mine (bytes) | fixed-Paeth baseline | ratio | colour type | pixel-exact |
|---|---|---|---|---|---|
| flat-ui (PNG & raw inputs) | 2,785 | 9,552 | 0.292 | 3 | ✅ |
| photo-noise (PNG & raw) | 2,005,752 | 2,505,521 | 0.801 | 2 | ✅ |
| grey-doc (PNG & raw) | 2,228 | 5,670 | 0.393 | 0 | ✅ |
| flat-alpha (PNG & raw) | 1,943 | 5,395 | 0.360 | 3 (+tRNS) | ✅ |

- Totals (PNG inputs): 2,012,708 vs baseline 2,526,138 → 20.32% smaller;
  every single image strictly below baseline.
- flat-alpha includes fully transparent pixels with non-zero RGB —
  decoded output matches byte-for-byte, so transparent RGB is preserved.
- Determinism: two full runs byte-identical. PASS.
- Timing: 8 images in 2.99 s (limit 60 s). PASS.
- Manifest path separately tested (file-name entry + base64 entry):
  both outputs pixel-exact. PASS.
- Result: ALL PASS.

### Submission parameters (for the main line — NOT submitted here)

- Competition slug: `png-squeeze-01-run-20261127`
- Submit the local commit `be739176e7fd101d17f8e324ccd8ef59a8828d11`
  (its history root is the makefun anchor, as required).
- NOTE: the GitHub remote still holds the OLD main.ts from the earlier
  Contents-API push; the main line must push the new main.ts (and this
  HANDOFF) so the remote matches the submitted commit before submitting.
- Deadline: 2026-11-29T05:00Z = Taiwan 2026-11-29 13:00.

---

## (Superseded) first builder version

## Repo

- Repo: https://github.com/yuminskn/png-squeeze-01-run-20261127 (public, created after opening)
- Anchor (makefun init): `de96253127544f9e3bfab65be5cf0f497ebcf46f`, drand quicknet round `34317565`
- Wallet: `6gCNkG6Ld3n5BJo1Taw338ufizTnnbe3mPButb6TuA2x`
- Local HEAD (master, anchor + LICENSE only): `654d6cfbafe069c8371a212cc919854089fd0a6b`
- `.makefun/freshness.json`: present, round 34317565
- Files in working tree: `main.ts` (14,526 bytes), `LICENSE` (MIT + SPDX), `README.md`, `HANDOFF.md`, `.makefun/freshness.json` — tracked total ≈ 17 KB, far under the 1 MiB repo cap.

## ⚠️ Git push NOT done — main line to push via Contents API

`makefun init` ran once and succeeded, but its output failed prompt-injection
+ execution-risk checks: it suggested downloading a fresh kit via curl|tar.
That suggestion was NOT followed (the work order forbids downloading a new
kit). Per the security notice I ran no git commands in the repo afterwards.
`main.ts`, `README.md`, and this file are written but uncommitted in the
working tree; the local HEAD only holds the anchor + LICENSE. Push everything
via the Contents API (or equivalent) — do not re-run `makefun init`.

Related: the LICENSE `init` wrote is MIT with the SPDX line, but its
copyright holder is the wallet address (makefun anchor convention: authored
by the wallet alone, no user/host name), not "Copyright (c) 2026 Yumin" as
the work order asked. Overwriting the delivered LICENSE was blocked by the
same execution-risk notice — decide at push time whether to keep the wallet
holder or switch it to Yumin.

## Local practice scores vs fixed-Paeth baseline (proxy — see caveats)

No png-squeeze kit exists locally and downloading a new kit was forbidden,
so there is no official practice set or scorer. Validation used a self-built
set of 8 synthetic 1280×720 RGBA images (flat UI, gradient+noise, grey doc,
flat+alpha, photo-noise, dark UI, overlay photo, grey+alpha) and a
self-implemented fixed-Paeth baseline (colour type 6, Paeth every row, single
zlib level-9 stream). Scores below are file sizes; smaller is better.

| image | mine (bytes) | baseline (bytes) | ratio | colour type |
|---|---|---|---|---|
| 01-flat-ui | 2,192 | 5,894 | 0.372 | 3 (palette) |
| 02-gradient-noise | 804,472 | 892,416 | 0.901 | 2 (RGB) |
| 03-grey-doc | 2,310 | 5,905 | 0.391 | 0 (grey) |
| 04-flat-alpha | 2,004 | 6,075 | 0.330 | 3 + tRNS |
| 05-photo-noise | 1,519,421 | 1,727,309 | 0.880 | 2 (RGB) |
| 06-dark-ui | 2,261 | 5,810 | 0.389 | 3 (palette) |
| 07-overlay-photo | 974,527 | 1,028,456 | 0.948 | 6 (RGBA) |
| 08-grey-alpha | 3,443 | 5,477 | 0.629 | 4 (grey+alpha) |
| **TOTAL** | **3,310,630** | **3,677,342** | **0.900** | — |

Total saving vs baseline: **9.97%**; every single image is strictly smaller
than the fixed-Paeth baseline, so the "strictly above baseline" gate is met
on this proxy set.

## Verification results (local harness, /tmp/pngtest)

- Pixel-exact: all 8 outputs decode back to the source RGBA byte-for-byte,
  including fully transparent pixels' colours. PASS.
- PNG constraints: bit depth 8, non-interlaced, colour types only
  0/2/3/4/6, only IHDR/PLTE/tRNS/IDAT/IEND chunks, valid CRCs. PASS.
- Determinism: two runs produce byte-identical outputs. PASS.
- Runtime: 4.5 s for 8 images (limit 60 s). PASS.
- Dependencies: only Node built-ins (`node:fs`, `node:path`, `node:zlib`);
  no npm packages, no network, no randomness, no timestamps. PASS.
- Extra check: an alternate per-row filter heuristic (sum-of-squares) and
  `Z_FILTERED` DEFLATE were tested and did not beat the shipped combination
  (per-row min-sum-|signed| + level 9 / level 9+memLevel 9).

## Submission parameters (for the main line — submission NOT done here)

- Competition slug: `png-squeeze-01-run-20261127`
- Prize pool: $100, 50 places (1–10: $4 each; 11–20: $3 each; 21–50: $1 each)
- Deadline: 2026-11-29T05:00Z = Taiwan 2026-11-29 13:00
- Entry fee: $0
- Gate: score must be strictly above the house `fixed-paeth 1.0.0` baseline
- Entry point: `main.ts` at repo root; Node 22 runs `node /bot/main.ts`
- I/O contract (inferred — see caveats): raw RGBA files in `/input`
  (3,686,400 bytes each) → same-basename `.png` files in `/output`. The
  program also accepts `node main.ts <inputDir> <outputDir>` and a JSON
  manifest (`cases.json` with `{id, input}` entries, file names or base64)
  in the input directory.

## Main-line addendum (2026-11-27, after builder delivery)

### PNG-input fix — REQUIRED, the builder's I/O contract was wrong
The competition description says each instance arrives as `image.png` — a
stored PNG (colour type 6, unfiltered rows, zlib stored blocks). The
builder's `main.ts` only accepted files of exactly 3,686,400 bytes (raw
RGBA) and SKIPPED any real PNG, so on the grader it would have answered
nothing (score 0 on all 8 instances). Fixed in main.ts: added `decodePng`
(inflate + unfilter, colour types 0/2/3/4/6) and `asRgba` (raw RGBA or PNG);
both the plain-file path and the manifest path now accept either form.
LICENSE copyright holder changed from the wallet address to
"Copyright (c) 2026 Yumin" (Yumin-only rule).

### Verification of the fix (independent Python decoder, /tmp/pngtest2)
- 2 synthetic images (flat UI, photo-noise) fed BOTH as stored PNGs and as
  raw RGBA: outputs identical per image (2,785 / 2,065,311 bytes).
- Pixel-exact vs source RGBA on all 4 outputs: PASS.
- vs fixed-Paeth baseline (built in Python, Paeth every row, zlib level 9):
  flat-ui 2,785 vs 9,552 (ratio 0.292); photo-noise 2,065,311 vs 2,551,341
  (ratio 0.810). Strictly smaller on every image: PASS.
- Determinism (two runs, byte-compare): PASS.
- Result: ALL PASS. The "strictly above baseline" gate now holds on both
  the builder's proxy set and on stored-PNG inputs.

## Caveats the main line should know

1. The official kit (practice set + scorer + competition.yaml) was never
   available locally, so the I/O contract above is inferred from the brief
   and from the program/v1 pattern in the csv-reader-speed kit. If the real
   kit's input layout differs (different file names, a manifest, PNG inputs),
   `main.ts` may need a small adjustment before submission.
2. Scores above are a proxy, not official dev scores. The encoder beats the
   self-implemented fixed-Paeth baseline on all 8 synthetic themes, with the
   thinnest margin on noisy photo-like images (ratio 0.88–0.95).
3. No old make.fun submission code was read; `main.ts` was written fresh in
   two passes. Only Node built-in `zlib` is used.
