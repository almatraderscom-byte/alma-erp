import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(process.cwd(), 'src/agent/components/creative-studio-v3')
const source = (name: string) => readFileSync(join(root, name), 'utf8')

describe('Creative Studio V4 primary action contract', () => {
  it('keeps image generation visible while preserving estimate-before-confirm safety', () => {
    const imageLab = source('StudioV3ImageLab.tsx')

    expect(imageLab).toContain('Review & generate')
    expect(imageLab).toContain('requestAutoReview')
    expect(imageLab).toContain("setSourceTray('product')")
    expect(imageLab).toContain("setSourceTray('model')")
    expect(imageLab).toContain("setArchitecture('advanced')")
    expect(imageLab).toContain('port.estimateRun')
    expect(imageLab).toContain('port.confirmRun')
    expect(imageLab).toContain('setLocalStatus(message)')
    expect(imageLab.indexOf('port.estimateRun')).toBeLessThan(imageLab.indexOf('port.confirmRun'))
  })

  it('shows actionable readiness text instead of clipping it visually', () => {
    const styles = source('creative-studio-v3.module.css')
    const statusRule = styles.match(/\.v4ComposerStatus\s*\{[\s\S]*?\n\}/)?.[0] ?? ''

    expect(styles).toContain('.shell .v4ComposerSubmit {')
    expect(statusRule).toContain('display: flex')
    expect(statusRule).not.toContain('clip:')
    expect(statusRule).not.toContain('width: 1px')
  })
})

describe('Creative Studio V4 Gallery interaction contract', () => {
  it('opens a real fullscreen dialog and does not force the first card selected', () => {
    const gallery = source('StudioV3Gallery.tsx')

    expect(gallery).toContain('aria-modal="true"')
    expect(gallery).toContain('role="dialog"')
    expect(gallery).toContain('createPortal')
    expect(gallery).toContain('ALMA Creative Studio V4')
    expect(gallery).toContain('Close fullscreen preview')
    expect(gallery).toContain("event.key === 'Escape'")
    expect(gallery).toContain("event.key === 'ArrowLeft'")
    expect(gallery).toContain("event.key === 'ArrowRight'")
    expect(gallery).not.toContain('visible[0] ?? null')
  })

  it('renders and downloads the signed original URL rather than the grid thumbnail', () => {
    const gallery = source('StudioV3Gallery.tsx')

    expect(gallery).toContain('item.galleryItem?.previewUrl ?? item.previewUrl')
    expect(gallery).toContain('downloadStudioAsset')
    expect(gallery).toContain('Download original')
    expect(gallery).toContain('artifactFileExtension')
  })

  it('constrains the original media to the lightbox viewport without cropping portrait assets', () => {
    const styles = source('creative-studio-v3.module.css')
    const mediaRule = styles.match(/\.galleryLightboxMedia > img,[\s\S]*?\n\}/)?.[0] ?? ''

    expect(mediaRule).toContain('position: absolute')
    expect(mediaRule).toContain('inset: 0')
    expect(mediaRule).toContain('width: 100%')
    expect(mediaRule).toContain('height: 100%')
    expect(mediaRule).toContain('object-fit: contain')
  })
})
