import { describe, expect, it } from 'vitest'
import { archivedConversationMode } from '../route'

describe('conversation list archive contract', () => {
  it('keeps active conversations as the default for existing callers', () => {
    expect(archivedConversationMode(new URLSearchParams())).toBe(false)
    expect(archivedConversationMode(new URLSearchParams('archived=false'))).toBe(false)
  })

  it('selects archived conversations only when explicitly requested', () => {
    expect(archivedConversationMode(new URLSearchParams('archived=true'))).toBe(true)
  })
})
