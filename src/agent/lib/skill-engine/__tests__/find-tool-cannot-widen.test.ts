/**
 * FOUND 2026-07-27 — the claim I had repeated to Boss all session ("a prompt
 * rule is a request, an absent tool is a guarantee") was not true of one path.
 *
 * `find_tool` resolves ANY registry tool by name and pushes it into the live
 * tool list mid-turn. The skill allowlist is applied when the list is BUILT, so
 * a read-only audit skill could search its way to a write tool and the guarantee
 * evaporated exactly where it was quoted most.
 *
 * The rule now applied at the dynamic-load site is what these tests pin down.
 * find_tool itself is never denied — a skill must never be trapped.
 */
import { describe, expect, it } from 'vitest'
import { skillAllowlist, ALWAYS_ALLOWED } from '@/agent/lib/skill-engine/enforcement'

/** Mirrors the filter in run-owner-turn's find_tool dynamic-load block. */
function permittedByTurn(
  matches: string[],
  opts: { already?: Set<string>; allow: Set<string> | null; deny: Set<string> },
): string[] {
  const already = opts.already ?? new Set<string>()
  return matches.filter((n) => {
    if (already.has(n)) return false
    if (opts.deny.has(n)) return false
    if (opts.allow && !opts.allow.has(n)) return false
    return true
  })
}

const READ_ONLY_AUDIT = {
  requiredCapabilities: ['get_website_catalog', 'audit_product_seo', 'fetch_website_page'],
}

describe('find_tool cannot widen what the turn is allowed to do', () => {
  it('a read-only audit skill cannot search its way to a write tool', () => {
    const allow = skillAllowlist(READ_ONLY_AUDIT)
    const got = permittedByTurn(['draft_seo_fixes', 'audit_product_seo'], { allow, deny: new Set() })
    expect(got).toEqual(['audit_product_seo'])
  })

  it('the escape hatches survive — a skill is never trapped', () => {
    const allow = skillAllowlist(READ_ONLY_AUDIT)!
    for (const name of ALWAYS_ALLOWED) expect(allow.has(name)).toBe(true)
  })

  it('a tool this turn withheld on purpose stays withheld', () => {
    // The answering turn of an ask card withholds ask_user; find_tool must not
    // hand it straight back.
    const got = permittedByTurn(['ask_user', 'get_orders'], {
      allow: null,
      deny: new Set(['ask_user']),
    })
    expect(got).toEqual(['get_orders'])
  })

  it('with no skill pinned, nothing narrows — find_tool works as before', () => {
    const got = permittedByTurn(['draft_seo_fixes', 'get_orders'], { allow: null, deny: new Set() })
    expect(got).toEqual(['draft_seo_fixes', 'get_orders'])
  })

  it('an already-loaded tool is not loaded twice', () => {
    const got = permittedByTurn(['get_orders'], {
      already: new Set(['get_orders']),
      allow: null,
      deny: new Set(),
    })
    expect(got).toEqual([])
  })

  it('an empty capability list means "does not narrow", never "no tools"', () => {
    expect(skillAllowlist({ requiredCapabilities: [] })).toBeNull()
    const got = permittedByTurn(['draft_seo_fixes'], { allow: null, deny: new Set() })
    expect(got).toEqual(['draft_seo_fixes'])
  })
})
