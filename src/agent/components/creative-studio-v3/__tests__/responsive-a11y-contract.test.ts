import { readFileSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const v3Root = join(root, 'src/agent/components/creative-studio-v3')
const legacyRoot = join(root, 'src/agent/components/creative-studio')
const v3Styles = readFileSync(
  join(v3Root, 'creative-studio-v3.module.css'),
  'utf8',
)
const editorStyles = readFileSync(
  join(legacyRoot, 'editor/ProjectEditor.module.css'),
  'utf8',
)

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sourceFiles(path)
    }
    return ['.css', '.tsx'].includes(extname(path)) ? [path] : []
  })
}

describe('Creative Studio production responsive and a11y contract', () => {
  it('keeps every explicit production text size at a readable 11px minimum', () => {
    const violations: string[] = []
    for (const file of sourceFiles(legacyRoot)) {
      const content = readFileSync(file, 'utf8')
      for (const match of content.matchAll(
        /font-size:\s*([0-9.]+)(px|rem)|fontSize\s*:\s*['"]?([0-9.]+)(px)?/g,
      )) {
        const raw = Number(match[1] ?? match[3])
        const unit = match[2] ?? match[4] ?? 'px'
        const px = unit === 'rem' ? raw * 16 : raw
        if (px < 11) violations.push(`${file}:${match[0]}`)
      }
    }
    expect(violations).toEqual([])
  })

  it('defines distinct desktop, tablet, mobile, and 390px-safe layouts', () => {
    expect(v3Styles).toContain('@media (max-width: 1180px)')
    expect(v3Styles).toContain('@media (max-width: 980px)')
    expect(v3Styles).toContain('@media (max-width: 760px)')
    expect(v3Styles).toContain('@media (max-width: 480px)')
    expect(v3Styles).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))')
    expect(editorStyles).toContain('@media (max-width: 1279px)')
    expect(editorStyles).toContain('@media (max-width: 900px)')
    expect(editorStyles).toContain('@media (max-width: 767px)')
    expect(editorStyles).toContain('width: 100%')
  })

  it('contains keyboard focus, reduced-motion, touch input, and overflow guards', () => {
    const shell = readFileSync(join(v3Root, 'StudioV3Shell.tsx'), 'utf8')
    expect(v3Styles).toContain('.shell button:focus-visible')
    expect(editorStyles).toContain('.editorShell button:focus-visible')
    expect(v3Styles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(editorStyles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(editorStyles).toMatch(
      /\.mediaSearch input,[\s\S]*?font-size:\s*16px/,
    )
    expect(v3Styles).toMatch(
      /\.shell\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;[\s\S]*?overflow:\s*hidden;/,
    )
    expect(editorStyles).toMatch(
      /\.editorShell\s*\{[\s\S]*?width:\s*100%;[\s\S]*?overflow:\s*hidden;/,
    )
    expect(shell).toContain('className={styles.skipLink}')
    expect(shell).toContain('aria-label="Creative Studio navigation"')
    expect(shell).toContain(
      'aria-label="Creative Studio capability navigation"',
    )
  })
})
