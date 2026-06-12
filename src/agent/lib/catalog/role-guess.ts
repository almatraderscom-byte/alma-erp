export type MemberRole = 'baba' | 'chele' | 'ma' | 'meye' | 'couple' | 'other'

/** Guess family role from product name / SKU (Bangla + English). */
export function guessMemberRole(productName: string, sku = ''): MemberRole {
  const t = `${productName} ${sku}`.toLowerCase()
  if (/couple|কাপল|জুটি|duo/i.test(t)) return 'couple'
  if (/baba|father|abu|আবু|বাবা|men'?s?\s*panjabi|mens|man\b/i.test(t)) return 'baba'
  if (/chele|son|beta|বেটা|ছেলে|boy/i.test(t)) return 'chele'
  if (/ma\b|mother|ammu|আম্মু|মা\b/i.test(t)) return 'ma'
  if (/meye|girl|daughter|মেয়ে|বেটি/i.test(t)) return 'meye'
  if (/women|ladies|মহিলা/i.test(t)) return 'meye'
  if (/kids|kid|child|শিশু/i.test(t)) return 'chele'
  return 'other'
}
