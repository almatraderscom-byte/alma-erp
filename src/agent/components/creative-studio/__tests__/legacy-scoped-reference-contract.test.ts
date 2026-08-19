import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const workspace = readFileSync(
  join(process.cwd(), 'src/agent/components/creative-studio/StudioWorkspaceView.tsx'),
  'utf8',
)

describe('legacy Studio scoped reference contract', () => {
  it('binds uploaded product and model references to the active project before a paid run', () => {
    expect(workspace).toContain('getActiveStudioContentContext()')
    expect(workspace).toContain('await uploadStudioReference(file')
    expect(workspace).toContain('productReferenceId: productReferenceId ?? undefined')
    expect(workspace).toContain('modelReferenceId: modelReferenceId ?? undefined')
  })
})
