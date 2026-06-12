#!/usr/bin/env node
/**
 * Generates Android launcher icons from public/icon.svg into mobile/res/.
 * Run before cap sync if icons change.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const ROOT = path.resolve(import.meta.dirname, '..')
const SVG = path.join(ROOT, 'public/icon.svg')
const OUT = path.join(ROOT, 'mobile/res')
const ANDROID_RES = path.join(ROOT, 'android/app/src/main/res')

const SIZES = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192,
}

async function main() {
  const svg = await readFile(SVG)
  for (const [folder, size] of Object.entries(SIZES)) {
    const dir = path.join(OUT, folder)
    await mkdir(dir, { recursive: true })
    const png = await sharp(svg)
      .resize(size, size, { fit: 'contain', background: { r: 8, g: 8, b: 10, alpha: 1 } })
      .png()
      .toBuffer()
    await writeFile(path.join(dir, 'ic_launcher.png'), png)
    await writeFile(path.join(dir, 'ic_launcher_round.png'), png)
    await writeFile(path.join(dir, 'ic_launcher_foreground.png'), png)
  }
  const splashDir = path.join(OUT, 'drawable')
  await mkdir(splashDir, { recursive: true })
  const splash = await sharp(svg)
    .resize(240, 240, { fit: 'contain', background: { r: 8, g: 8, b: 10, alpha: 1 } })
    .png()
    .toBuffer()
  await writeFile(path.join(splashDir, 'splash.png'), splash)

  // Copy into Android project if platform exists
  try {
    const { cp } = await import('node:fs/promises')
    for (const folder of Object.keys(SIZES)) {
      const src = path.join(OUT, folder)
      const dest = path.join(ANDROID_RES, folder)
      await mkdir(dest, { recursive: true })
      for (const name of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
        await cp(path.join(src, name), path.join(dest, name))
      }
    }
    const androidDrawable = path.join(ANDROID_RES, 'drawable')
    await mkdir(androidDrawable, { recursive: true })
    await cp(path.join(splashDir, 'splash.png'), path.join(androidDrawable, 'splash.png'))
  } catch {
    // android/ not added yet
  }

  console.log('[mobile:icons] generated → mobile/res/ (+ android res when present)')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
