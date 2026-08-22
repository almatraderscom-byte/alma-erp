export interface PairedDeviceForOwnerRequest {
  id: string
  name: string
  online: boolean
}

export type ParsedOwnerDeviceTarget =
  | { state: 'none' }
  | { state: 'ambiguous'; names: string[] }
  | {
      state: 'selected'
      device: PairedDeviceForOwnerRequest
      acceptedHints: string[]
    }

export interface ParsedDirectMediaOwnerRequest {
  mediaTitle: string
  deviceTarget: ParsedOwnerDeviceTarget
}

const DEVICE_NAME_GLUE = new Set([
  'mac', 'macbook', 'chrome', 'browser', 'device', 'companion', 'windows', 'pc',
  'ম্যাক', 'ম্যাকবুক', 'ক্রোম', 'ব্রাউজার', 'ডিভাইস', 'উইন্ডোজ',
])
const DEVICE_TARGET_PREFIX = new Set([
  'on', 'use', 'using', 'via', 'with',
  'এই', 'ওই', 'আমার', 'দিয়ে', 'দিয়ে',
])
const DEVICE_TARGET_SUFFIX = new Set([
  ...DEVICE_NAME_GLUE,
  'এ', 'তে', 'টায়', 'টায়', 'টাতে', 'টিতে',
  'e', 'te', 'diye', 'দিয়ে', 'দিয়ে',
])
const DEVICE_LOCATIVE_SUFFIX = new Set([
  'এ', 'তে', 'টায়', 'টায়', 'টাতে', 'টিতে',
  'e', 'te', 'diye', 'দিয়ে', 'দিয়ে',
])
const COMMAND_WORDS = new Set([
  'play', 'watch', 'open', 'find', 'search', 'start', 'begin', 'get', 'listen', 'put',
  'চালাও', 'চালান', 'বাজাও', 'বাজান', 'প্লে', 'দেখাও', 'দেখান',
])
const COMMAND_PREFIX_GLUE = new Set([
  'i', 'we', 'd', 'want', 'need', 'can', 'could', 'would', 'will', 'like',
  'you', 'to', 'please', 'pls', 'kindly', 'hey', 'boss', 'now',
  'ami', 'amra', 'tumi', 'apni', 'chai', 'ektu', 'doya', 'please', 'pls',
  'তুমি', 'আপনি', 'আমি', 'আমরা', 'চাই', 'দয়া', 'দয়া', 'করে', 'একটু',
  'বস', 'এখন', 'প্লিজ',
])
const PLATFORM_WORDS = new Set(['youtube', 'ইউটিউব', 'ইউটিউবে', 'youtubee'])
const PLATFORM_LOCATIVE = new Set(['এ', 'তে', 'e', 'te'])
const AMBIGUOUS_DEVICE_ALIAS = new Set(['my', 'me', 'you', 'your', 'our', 'us'])
const TRAILING_COURTESY = new Set([
  'please', 'pls', 'now', 'boss', 'kindly',
  'দয়া', 'দয়া', 'এখন', 'প্লিজ', 'বস',
  'doya', 'ektu', 'please',
])
const TRAILING_COMMANDS = [
  ['শুনতে', 'চাই'],
  ['দেখতে', 'চাই'],
  ['shunte', 'chai'],
  ['dekhte', 'chai'],
  ['play', 'koro'],
  ['play', 'korun'],
  ['playing'],
  ['running'],
  ['প্লে', 'করো'],
  ['প্লে', 'করুন'],
  ['চালিয়ে', 'দাও'],
  ['চালিয়ে', 'দাও'],
  ['chaliye', 'dao'],
  ['চালাও'],
  ['চালান'],
  ['বাজাও'],
  ['বাজান'],
  ['দেখাও'],
  ['দেখান'],
  ['chalao'],
  ['chalaw'],
  ['bajao'],
  ['bajan'],
  ['dekhao'],
  ['play'],
] as const

export function normalizeOwnerRequestWords(value: string): string[] {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
}

function phraseAt(words: string[], phrase: string[], index: number): boolean {
  return phrase.length > 0 && phrase.every((word, offset) => words[index + offset] === word)
}

type TargetMatch = {
  device: PairedDeviceForOwnerRequest
  acceptedHints: string[]
  start: number
  end: number
}

function explicitTargetMatchAt(
  words: string[],
  phrase: string[],
  index: number,
): { start: number; end: number } | null {
  if (!phraseAt(words, phrase, index)) return null
  const before = words[index - 1] ?? ''
  const after = words[index + phrase.length] ?? ''
  const platformClause = phrase.length === 1
    && PLATFORM_WORDS.has(phrase[0])
    && (
      PLATFORM_LOCATIVE.has(after)
      || (
        ['on', 'in', 'via', 'at', 'use', 'using'].includes(before)
        && !DEVICE_NAME_GLUE.has(after)
      )
    )
  if (platformClause || (
    phrase.length === 1
    && PLATFORM_WORDS.has(phrase[0])
    && PLATFORM_LOCATIVE.has(after)
  )) return null
  if (
    phrase.length === 1
    && AMBIGUOUS_DEVICE_ALIAS.has(phrase[0])
    && !DEVICE_NAME_GLUE.has(after)
  ) return null
  if (!DEVICE_TARGET_PREFIX.has(before) && !DEVICE_TARGET_SUFFIX.has(after)) return null
  let end = index + phrase.length
  // A short owner alias may be followed by non-authoritative device glue and a
  // locative marker ("Office Mac-e"). Consume the whole explicit clause so
  // those words never leak into the media title used by final proof.
  while (DEVICE_TARGET_SUFFIX.has(words[end] ?? '')) end++
  return {
    start: DEVICE_TARGET_PREFIX.has(before) ? index - 1 : index,
    end,
  }
}

function targetMatches(
  words: string[],
  devices: PairedDeviceForOwnerRequest[],
): TargetMatch[] {
  const matches: TargetMatch[] = []
  for (const device of devices) {
    const nameWords = normalizeOwnerRequestWords(device.name)
    if (!nameWords.length) continue
    const aliasWords = nameWords.filter((word) => !DEVICE_NAME_GLUE.has(word))
    const phrases = [nameWords, aliasWords]
      .filter((phrase) => phrase.length > 0)
      .filter((phrase, index, all) => (
        all.findIndex((candidate) => candidate.join('\u0000') === phrase.join('\u0000')) === index
      ))
    let match: { start: number; end: number } | null = null
    for (const phrase of phrases) {
      for (let index = 0; index <= words.length - phrase.length; index++) {
        match = explicitTargetMatchAt(words, phrase, index)
        if (match) break
      }
      if (match) break
    }
    if (!match) continue
    matches.push({
      device,
      acceptedHints: [...new Set([
        nameWords.join(' '),
        aliasWords.join(' '),
      ].filter(Boolean))],
      ...match,
    })
  }
  // A short device name may be contained inside a longer exact device name
  // (device "Mac" versus "Office Mac Chrome"). Overlapping longer explicit
  // clauses win; equal spans stay ambiguous for duplicate-name safety.
  return matches.filter((match) => !matches.some((other) => (
    other !== match
    && other.start < match.end
    && other.end > match.start
    && other.end - other.start > match.end - match.start
  )))
}

function spanOverlaps(
  candidate: { start: number; end: number },
  spans: Array<{ start: number; end: number }>,
): boolean {
  return spans.some((span) => candidate.start < span.end && candidate.end > span.start)
}

/**
 * Strip syntactically explicit device clauses from media semantics even when a
 * later proof consumer no longer has the paired-device inventory. These spans
 * never grant device authority; `targetMatches` above is the only authority.
 */
function syntacticDeviceClauseSpans(
  words: string[],
  boundSpans: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  const add = (start: number, end: number) => {
    const candidate = { start, end }
    if (start >= 0 && end > start && !spanOverlaps(candidate, [...boundSpans, ...spans])) {
      spans.push(candidate)
    }
  }

  // "Use Office Mac Chrome to play …". Without a server-matched name, require
  // an explicit device noun; arbitrary "use X to play" may itself be a title.
  for (let index = 0; index < words.length; index++) {
    if (words[index] !== 'use') continue
    const to = words.findIndex((word, offset) => offset > index && offset <= index + 8 && word === 'to')
    const clause = to > index ? words.slice(index + 1, to) : []
    if (
      to > index
      && COMMAND_WORDS.has(words[to + 1] ?? '')
      && clause.some((word) => DEVICE_NAME_GLUE.has(word))
    ) add(index, to + 1)
  }

  // Suffix forms are explicit enough to strip from proof but are not enough to
  // choose a real device without a server-owned exact-name match.
  for (let index = 1; index < words.length; index++) {
    if (!['using', 'via', 'with'].includes(words[index])) continue
    let end = words.length
    for (let cursor = index + 1; cursor < words.length; cursor++) {
      if (
        ['on', 'in', 'at'].includes(words[cursor])
        && PLATFORM_WORDS.has(words[cursor + 1] ?? '')
      ) {
        end = cursor
        break
      }
    }
    const clause = words.slice(index + 1, end)
    if (
      end > index + 1
      && clause.some((word) => DEVICE_NAME_GLUE.has(word))
    ) add(index, end)
  }

  // Unknown-name fallback for "on Office Mac Chrome". Requiring an explicit
  // device noun/location hint prevents "Work from Home" from becoming a target.
  const deviceClauseHints = new Set(DEVICE_NAME_GLUE)
  for (let index = 1; index < words.length - 1; index++) {
    if (words[index] !== 'on' || PLATFORM_WORDS.has(words[index + 1] ?? '')) continue
    const tail = words.slice(index + 1)
    if (tail.some((word) => deviceClauseHints.has(word))) add(index, words.length)
  }

  // Locative/device-postposition forms: "Office Mac Chrome-e …" and
  // "Office Mac Chrome diye …". Limit the look-back so title words stay out.
  for (let marker = 1; marker < words.length; marker++) {
    if (!DEVICE_LOCATIVE_SUFFIX.has(words[marker])) continue
    let actualStart = marker
    while (actualStart > 0 && deviceClauseHints.has(words[actualStart - 1])) actualStart--
    if (actualStart === marker) continue
    add(actualStart, marker + 1)
  }
  return spans
}

function platformSpans(words: string[], targetSpans: Array<{ start: number; end: number }>) {
  const overlapsTarget = (start: number, end: number) => targetSpans.some(
    (span) => start < span.end && end > span.start,
  )
  const spans: Array<{ start: number; end: number }> = []
  for (let index = 0; index < words.length; index++) {
    if (!PLATFORM_WORDS.has(words[index])) continue
    let start = index
    let end = index + 1
    if (['on', 'in', 'via', 'at', 'use', 'using'].includes(words[index - 1] ?? '')) start--
    if (PLATFORM_LOCATIVE.has(words[index + 1] ?? '')) end++
    if (!overlapsTarget(start, end)) spans.push({ start, end })
  }
  return spans
}

function commandPrefixEnd(words: string[], targetSpans: Array<{ start: number; end: number }>): number {
  const hidden = new Set<number>()
  for (const span of targetSpans) for (let index = span.start; index < span.end; index++) hidden.add(index)
  for (let index = 0; index < Math.min(words.length, 16); index++) {
    if (hidden.has(index) || COMMAND_PREFIX_GLUE.has(words[index])) continue
    if (COMMAND_WORDS.has(words[index])) {
      const consumesNext = (
        (words[index] === 'listen' && words[index + 1] === 'to')
        || (words[index] === 'search' && words[index + 1] === 'for')
        || (words[index] === 'put' && words[index + 1] === 'on')
        || (['start', 'begin'].includes(words[index]) && ['playing', 'watching', 'listening'].includes(words[index + 1] ?? ''))
      )
      return consumesNext ? index + 2 : index + 1
    }
    // A substantive word before the command means the command is part of the
    // title, not the owner wrapper. The exception is an explicit leading
    // "use <device> to play" clause, whose device tokens are hidden above.
    if (index > 0 || words[index] !== 'use') break
  }
  return 0
}

function stripTrailingRequestWords(words: string[]): { words: string[]; strippedCommand: boolean } {
  let remaining = [...words]
  while (remaining.length > 1 && TRAILING_COURTESY.has(remaining.at(-1) ?? '')) {
    remaining = remaining.slice(0, -1)
  }
  let strippedCommand = false
  for (const command of TRAILING_COMMANDS) {
    if (
      remaining.length > command.length
      && command.every((word, offset) => remaining[remaining.length - command.length + offset] === word)
    ) {
      remaining = remaining.slice(0, -command.length)
      strippedCommand = true
      break
    }
  }
  while (remaining.length > 1 && TRAILING_COURTESY.has(remaining.at(-1) ?? '')) {
    remaining = remaining.slice(0, -1)
  }
  if (strippedCommand) {
    // Bengali/Banglish requests naturally put the verb last. Once that verb is
    // proven, leading address/politeness words are wrappers, not title words.
    while (remaining.length > 1 && COMMAND_PREFIX_GLUE.has(remaining[0])) {
      remaining = remaining.slice(1)
    }
  }
  return { words: remaining, strippedCommand }
}

function extractMediaTitle(
  words: string[],
  targetSpans: Array<{ start: number; end: number }>,
): string {
  const removed = new Set<number>()
  const removalSpans = [...targetSpans, ...platformSpans(words, targetSpans)]
  for (const span of removalSpans) {
    for (let index = span.start; index < span.end; index++) removed.add(index)
  }
  const prefixEnd = commandPrefixEnd(words, removalSpans)
  for (let index = 0; index < prefixEnd; index++) removed.add(index)
  let remaining = words.filter((_, index) => !removed.has(index))
  // Supported playback requests sometimes start with a harmless navigation
  // clause: "Open YouTube and play X" / "Search YouTube and play X". The
  // first command and platform were removed above; consume the connector plus
  // the second playback wrapper without ever stripping a title that merely
  // starts with the word "Play".
  let removedConnector = false
  while (['and', 'then', 'also', 'তারপর', 'এবং'].includes(remaining[0] ?? '')) {
    remaining = remaining.slice(1)
    removedConnector = true
  }
  if (removedConnector && COMMAND_WORDS.has(remaining[0] ?? '')) {
    const command = remaining[0]
    const consumesNext = (
      (command === 'listen' && remaining[1] === 'to')
      || (command === 'search' && remaining[1] === 'for')
      || (command === 'put' && remaining[1] === 'on')
      || (['start', 'begin'].includes(command) && ['playing', 'watching', 'listening'].includes(remaining[1] ?? ''))
    )
    remaining = remaining.slice(consumesNext ? 2 : 1)
  }
  remaining = stripTrailingRequestWords(remaining).words
  if (
    remaining.length > 2
    && remaining.at(-2) === 'for'
    && ['me', 'us'].includes(remaining.at(-1) ?? '')
  ) {
    remaining = remaining.slice(0, -2)
  }
  return remaining.join(' ').trim()
}

/** One deterministic parse feeds both device authority and media proof. */
export function parseDirectMediaOwnerRequest(
  ownerRequest: string,
  devices: PairedDeviceForOwnerRequest[] = [],
): ParsedDirectMediaOwnerRequest {
  const words = normalizeOwnerRequestWords(ownerRequest)
  const matches = targetMatches(words, devices)
  const boundSpans = matches.map(({ start, end }) => ({ start, end }))
  const extractionSpans = [
    ...boundSpans,
    ...syntacticDeviceClauseSpans(words, boundSpans),
  ]
  const deviceTarget: ParsedOwnerDeviceTarget = matches.length === 0
    ? { state: 'none' }
    : matches.length === 1
      ? {
          state: 'selected',
          device: matches[0].device,
          acceptedHints: matches[0].acceptedHints,
        }
      : { state: 'ambiguous', names: matches.map((match) => match.device.name) }
  return {
    mediaTitle: extractMediaTitle(words, extractionSpans),
    deviceTarget,
  }
}
