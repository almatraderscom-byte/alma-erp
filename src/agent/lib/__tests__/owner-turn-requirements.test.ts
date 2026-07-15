import { describe, expect, it } from 'vitest'
import { deriveOwnerTurnRequirements } from '@/agent/lib/owner-turn-requirements'

describe('owner turn requirement contract', () => {
  it('preserves two SEO targets in owner order and requires live browser proof', () => {
    const r = deriveOwnerTurnRequirements(
      'Live browser use kore 1 by 1 full SEO audit + evidence report file: 1= gulshanspaone.com 2= queenspabd.com',
    )
    expect(r.liveBrowser).toBe(true)
    expect(r.clientSeo).toBe(true)
    expect(r.reportArtifact).toBe(true)
    expect(r.targets).toEqual(['https://gulshanspaone.com', 'https://queenspabd.com'])
  })

  it('does not turn an ordinary office question into work requirements', () => {
    expect(deriveOwnerTurnRequirements('Ajker office kemon jacche?')).toEqual({
      liveBrowser: false, clientSeo: false, reportArtifact: false, remember: false, targets: [],
    })
  })
})
