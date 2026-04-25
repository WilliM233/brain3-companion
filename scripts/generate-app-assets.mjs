#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const sourcesDir = resolve(repoRoot, 'assets', 'sources');
const assetsDir = resolve(repoRoot, 'assets');
const publicIconsDir = resolve(repoRoot, 'public', 'icons');
const publicDir = resolve(repoRoot, 'public');

async function rasterize(svgPath, outPath, size) {
  const svg = await readFile(svgPath);
  await mkdir(dirname(outPath), { recursive: true });
  await sharp(svg, { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer()
    .then((buf) => writeFile(outPath, buf));
  console.log(`  -> ${outPath} (${size}x${size})`);
}

async function main() {
  console.log('Rasterizing source SVGs to PNG...');
  await rasterize(resolve(sourcesDir, 'icon-full.svg'), resolve(assetsDir, 'icon-only.png'), 1024);
  await rasterize(resolve(sourcesDir, 'icon-mark.svg'), resolve(assetsDir, 'icon-foreground.png'), 1024);
  await rasterize(resolve(sourcesDir, 'icon-background.svg'), resolve(assetsDir, 'icon-background.png'), 1024);
  await rasterize(resolve(sourcesDir, 'splash.svg'), resolve(assetsDir, 'splash.png'), 2732);

  console.log('Generating PWA + favicon PNGs...');
  await rasterize(resolve(sourcesDir, 'icon-full.svg'), resolve(publicIconsDir, 'icon-192.png'), 192);
  await rasterize(resolve(sourcesDir, 'icon-full.svg'), resolve(publicIconsDir, 'icon-512.png'), 512);
  await rasterize(resolve(sourcesDir, 'icon-full.svg'), resolve(publicDir, 'favicon.png'), 64);

  console.log('Running @capacitor/assets generate --android...');
  const result = spawnSync('npx', ['@capacitor/assets', 'generate', '--android'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  console.log('Generating legacy ic_launcher.png per density...');
  const androidRes = resolve(repoRoot, 'android', 'app', 'src', 'main', 'res');
  const launcherDensities = [
    ['mipmap-ldpi', 36],
    ['mipmap-mdpi', 48],
    ['mipmap-hdpi', 72],
    ['mipmap-xhdpi', 96],
    ['mipmap-xxhdpi', 144],
    ['mipmap-xxxhdpi', 192],
  ];
  const fullSvgPath = resolve(sourcesDir, 'icon-full.svg');
  for (const [bucket, size] of launcherDensities) {
    await rasterize(fullSvgPath, resolve(androidRes, bucket, 'ic_launcher.png'), size);
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
