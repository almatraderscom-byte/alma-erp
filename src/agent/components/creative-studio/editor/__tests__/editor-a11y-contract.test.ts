import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const editorSource = readFileSync(
  new URL('../CreativeProjectEditor.tsx', import.meta.url),
  'utf8',
)
const workbenchSource = readFileSync(
  new URL('../EditorWorkbench.tsx', import.meta.url),
  'utf8',
)
const stageSource = readFileSync(
  new URL('../EditorStage.tsx', import.meta.url),
  'utf8',
)
const stylesSource = readFileSync(
  new URL('../ProjectEditor.module.css', import.meta.url),
  'utf8',
)

describe('Project Editor keyboard and responsive accessibility contract', () => {
  it('keeps native controls native and scopes global shortcuts away from editing', () => {
    expect(editorSource).toContain("target.closest('input, textarea, select, [contenteditable=\"true\"]')")
    expect(editorSource).toContain("target.closest('button, a, input, textarea, select, summary, [contenteditable=\"true\"]')")
    expect(editorSource).toContain("window.addEventListener('keydown', handleKeyDown)")
    expect(editorSource).toContain("window.removeEventListener('keydown', handleKeyDown)")
    expect(stageSource).toContain('aria-keyshortcuts="Space"')
    expect(editorSource).toContain('aria-keyshortcuts="Meta+Z Control+Z"')
    expect(editorSource).toContain("event.key.toLowerCase() === 'k'")
    expect(editorSource).toContain("getElementById('studio-editor-media-search')")
    expect(editorSource).toContain('Skip to canvas')
    expect(editorSource).toContain('Skip to timeline')
  })

  it('implements roving keyboard tabs and labelled tab-panel relationships', () => {
    expect(workbenchSource).toContain("event.key === 'ArrowRight'")
    expect(workbenchSource).toContain("event.key === 'ArrowLeft'")
    expect(workbenchSource).toContain("event.key === 'Home'")
    expect(workbenchSource).toContain("event.key === 'End'")
    expect(workbenchSource).toContain('role="tablist"')
    expect(workbenchSource).toContain('role="tabpanel"')
    expect(workbenchSource).toContain('tabIndex={tab === item.id ? 0 : -1}')
  })

  it('defines mobile focus modes, touch-safe inputs and reduced motion', () => {
    expect(stylesSource).toContain('@media (max-width: 767px)')
    for (const mode of ['stage', 'timeline', 'media', 'workbench']) {
      expect(stylesSource).toContain(`[data-focus-mode="${mode}"]`)
    }
    expect(stylesSource).toContain('@media (prefers-reduced-motion: reduce)')
    expect(stylesSource).toMatch(/font-size:\s*16px/)
    expect(stylesSource).toContain(':focus-visible')
  })
})
