import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('Studio confirmation dialog layer', () => {
  it('stays above expanded composers and Gallery lightboxes', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/agent/components/creative-studio/StudioUi.tsx'),
      'utf8',
    )
    expect(source).toContain('fixed inset-0 z-[700]')
  })
})
