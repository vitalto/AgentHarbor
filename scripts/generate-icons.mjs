#!/usr/bin/env node
// Regenerates every AgentHarbor icon from the single mark defined below.
//
// SVGs are always written. PNGs need a rasterizer that is deliberately not a
// project dependency; run with one available, for example:
//   mkdir -p /tmp/ah-resvg && npm --prefix /tmp/ah-resvg install @resvg/resvg-js
//   NODE_PATH=/tmp/ah-resvg/node_modules node scripts/generate-icons.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const HARBOR_NAVY = '#0f2b46';
const BEACON_AMBER = '#ffb938';

// A shell prompt chevron followed by an anchor whose arms form the prompt's baseline.
const MARK_GLYPH = `<g fill="none" stroke="${BEACON_AMBER}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 20.5 L22.5 29 L12 37.5"/>
    <circle cx="42" cy="13.5" r="5"/>
    <path d="M42 18.5 V50.5"/>
    <path d="M34.5 26 H49.5"/>
    <path d="M28 40.5 Q29.5 50.5 42 50.5 Q54.5 50.5 56 40.5"/>
  </g>`;

function roundedMarkSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="${HARBOR_NAVY}"/>
  ${MARK_GLYPH}
</svg>
`;
}

// Maskable PWA icons: full-bleed background, glyph kept inside the 80% safe zone.
function maskableMarkSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="${HARBOR_NAVY}"/>
  <g transform="translate(32 32) scale(0.72) translate(-32 -32)">
  ${MARK_GLYPH}
  </g>
</svg>
`;
}

const PWA_ICON_SIZES = [72, 96, 128, 144, 152, 192, 384, 512];
const LOGO_PNG_SIZES = [32, 64, 128, 256, 512];
const FAVICON_PNG_SIZE = 32;

function loadRasterizer() {
  try {
    const require = createRequire(path.join(process.cwd(), 'noop.js'));
    const { Resvg } = require('@resvg/resvg-js');
    return (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  } catch {
    return null;
  }
}

const rasterize = loadRasterizer();
const write = (relativePath, content) => {
  fs.writeFileSync(path.join(publicDirectory, relativePath), content);
  console.log('wrote', relativePath);
};

const roundedSvg = roundedMarkSvg();
write('logo.svg', roundedSvg);
write('favicon.svg', roundedSvg);
for (const size of PWA_ICON_SIZES) {
  write(`icons/icon-${size}x${size}.svg`, maskableMarkSvg(size));
}
write('icons/icon-template.svg', maskableMarkSvg(512));

if (!rasterize) {
  console.log('No @resvg/resvg-js found: PNGs were not regenerated (see the header of this script).');
  process.exit(0);
}

for (const size of LOGO_PNG_SIZES) {
  write(`logo-${size}.png`, rasterize(roundedSvg, size));
}
write('favicon.png', rasterize(roundedSvg, FAVICON_PNG_SIZE));
for (const size of PWA_ICON_SIZES) {
  write(`icons/icon-${size}x${size}.png`, rasterize(maskableMarkSvg(size), size));
}
