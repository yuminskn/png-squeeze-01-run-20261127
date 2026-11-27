# png-squeeze-01-run-20261127

A dependency-free Node 22 program (`main.ts`) that losslessly rewrites eight 1280×720 RGBA screenshots as the smallest valid PNGs it can find: it detects grey, palette (≤256 colours), and truecolour shapes, picks the best PNG filter per row, and tries several DEFLATE settings, keeping the smallest output — every pixel, including the colour of fully transparent pixels, is reproduced exactly, deterministically, within the competition's chunk, bit-depth, size, and time limits.
