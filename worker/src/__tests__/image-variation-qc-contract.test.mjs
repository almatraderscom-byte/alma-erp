import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workerSource = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')

test('every delivered image variation passes through the shared QC loop', () => {
  assert.match(workerSource, /async function generateAndQcVariation\(prompt, variationIndex\)/)
  assert.match(workerSource, /const firstVariation = await generateAndQcVariation\(basePrompt, 1\)/)
  assert.match(workerSource, /const variation = await generateAndQcVariation\(prompt, variationIndex\)/)
  assert.match(workerSource, /variationQc: deliveredImages\.map\(\(image\) => image\.qc\)/)
})

