/**
 * Owner briefing helpers — reads owner decisions so briefings don't re-suggest vetoed items.
 */
import { fetchOwnerDecisions } from '../memory/owner-decisions.mjs'

export { fetchOwnerDecisions }

/** Filter briefing suggestions the owner already declined or vetoed. */
export function deriveDecisions(suggestions, ownerDecisions) {
  const list = Array.isArray(suggestions) ? suggestions : []
  const decisions = Array.isArray(ownerDecisions) ? ownerDecisions : []
  if (!decisions.length) return list

  const vetoTexts = decisions.map((m) => (m.content || '').toLowerCase())

  return list.filter((suggestion) => {
    const text = String(suggestion).toLowerCase()
    for (const veto of vetoTexts) {
      if (!veto) continue
      // Ad boost veto
      if (veto.includes('ad boost') && /(না|no|করো না|avoid)/.test(veto) && text.includes('boost')) {
        const vetoProduct = veto.match(/(fm[-\w\d]+)/i)?.[1]
        const sugProduct = text.match(/(fm[-\w\d]+)/i)?.[1]
        if (!vetoProduct || !sugProduct || vetoProduct === sugProduct) return false
      }
      // Generic "don't suggest X" overlap
      if (/(না|no|করো না|avoid|বাদ)/.test(veto)) {
        const tokens = veto.split(/\s+/).filter((w) => w.length > 4)
        const overlap = tokens.filter((t) => text.includes(t)).length
        if (overlap >= 2) return false
      }
    }
    return true
  })
}

/** Build briefing context with owner decision memory. */
export async function buildOwnerBriefing({ suggestions = [] } = {}) {
  const ownerDecisions = await fetchOwnerDecisions()
  const filteredSuggestions = deriveDecisions(suggestions, ownerDecisions)
  return {
    ownerDecisions,
    suggestions: filteredSuggestions,
    decisionCount: ownerDecisions.length,
  }
}
