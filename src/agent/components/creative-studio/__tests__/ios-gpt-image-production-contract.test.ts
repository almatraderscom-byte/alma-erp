import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const nativeStudio = readFileSync(
  join(process.cwd(), 'ios/App/App/CreativeStudioSwiftUI.swift'),
  'utf8',
)

describe('iOS Creative Studio production image contract', () => {
  it('scopes paid image references to the active project', () => {
    expect(nativeStudio).toContain('/api/assistant/creative-studio/reference-upload')
    expect(nativeStudio).toContain('payload.productReferenceId = product.referenceId ?? source.referenceId')
    expect(nativeStudio).toContain('payload.brandProfileId = brandProfileId')
    expect(nativeStudio).toContain('payload.projectId = project.id')
  })

  it('requires an estimate receipt and explicit owner confirmation before queueing', () => {
    expect(nativeStudio).toContain('payload.intent = "estimate"')
    expect(nativeStudio).toContain('payload.intent = "confirm"')
    expect(nativeStudio).toContain('payload.idempotencyKey = "studio:\\(receiptId)"')
    expect(nativeStudio).toContain('title: Text("খরচ নিশ্চিত করুন")')
    expect(nativeStudio).not.toContain('No LLM cost')
  })
})
