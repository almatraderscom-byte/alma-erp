import type Anthropic from '@anthropic-ai/sdk'

const SYSTEM_CORE = `আপনি ALMA ERP-এর ব্যক্তিগত AI সহকারী।

## পরিচয়
আপনি Maruf-এর ব্যক্তিগত AI সহকারী। ALMA Lifestyle, ALMA Trading এবং CDIT-এর ব্যবসায়িক পরিচালনায় সাহায্য করুন।

## ভাষা ও ভদ্রতা
- সর্বদা বিশুদ্ধ বাংলায় উত্তর দিন।
- মালিককে "স্যার" বা "Boss" হিসেবে সম্বোধন করুন।
- বিনম্র, পেশাদার এবং সংক্ষিপ্ত থাকুন।

## ইসলামিক নির্দেশিকা
- হারাম পণ্য, কার্যক্রম বা কন্টেন্ট (মদ, জুয়া, শূকরের মাংস, সুদী লেনদেন, প্রাপ্তবয়স্ক বিষয়বস্তু) সমর্থন বা সুপারিশ করবেন না।
- ইসলামী মূল্যবোধ মেনে চলুন।

## টুল ব্যবহারের নিয়ম
- তথ্য দাবি করার আগে সংশ্লিষ্ট টুল ব্যবহার করে যাচাই করুন।
- টুল ব্যবহারের পর ফলাফল নিশ্চিত করুন, তারপর উত্তর দিন।
- কখনো অনুমান থেকে তথ্য উপস্থাপন করবেন না।
- অনিশ্চিত হলে স্বীকার করুন এবং পরিষ্কার করতে জিজ্ঞেস করুন।

## স্মৃতি ও তথ্য সংরক্ষণ
- মালিক কোনো গুরুত্বপূর্ণ তথ্য, পছন্দ, ব্যবসায়িক তথ্য বা ব্যক্তির কথা বললে save_memory টুল ব্যবহার করুন।
- "মনে রাখো…" বলা মানে save_memory অবশ্যই ব্যবহার করতে হবে।
- কোনো প্রশ্নের উত্তর বর্তমান কথোপকথনে না থাকলে search_memory দিয়ে খুঁজুন।
- কখনো API key, পাসওয়ার্ড বা গোপন তথ্য মেমরিতে সেভ করবেন না।
- pinned=true শুধুমাত্র খুব গুরুত্বপূর্ণ স্থায়ী তথ্যের জন্য ব্যবহার করুন।`

export interface PinnedMemory {
  id: string
  content: string
  scope: string
}

export interface RelevantMemory {
  id: string
  content: string
  scope: string
  score: number
}

export function buildSystemPrompt(
  projectInstructions?: string | null,
  pinnedMemories?: PinnedMemory[],
  relevantMemories?: RelevantMemory[],
): Anthropic.Messages.TextBlockParam[] {
  const blocks: Anthropic.Messages.TextBlockParam[] = [
    { type: 'text', text: SYSTEM_CORE },
  ]

  // Pinned memories: injected every turn (inside cached block region)
  if (pinnedMemories && pinnedMemories.length > 0) {
    const pinned = pinnedMemories
      .slice(0, 30)
      .map((m) => `[${m.scope}] ${m.content}`)
      .join('\n')
    blocks.push({
      type: 'text',
      text: `\n## স্থায়ী গুরুত্বপূর্ণ তথ্য (Pinned)\n${pinned}`,
    })
  }

  // Relevant memories from RAG (prepended as context before this turn)
  if (relevantMemories && relevantMemories.length > 0) {
    const relevant = relevantMemories
      .map((m) => `[${m.scope}, score=${m.score}] ${m.content}`)
      .join('\n')
    blocks.push({
      type: 'text',
      text: `\n## প্রাসঙ্গিক স্মৃতি (Relevant memories)\n${relevant}`,
    })
  }

  if (projectInstructions?.trim()) {
    blocks.push({
      type: 'text',
      text: `\n## প্রজেক্ট-নির্দিষ্ট নির্দেশনা\n${projectInstructions.trim()}`,
    })
  }

  // cache_control on the last block for prompt caching.
  blocks[blocks.length - 1] = {
    ...blocks[blocks.length - 1],
    cache_control: { type: 'ephemeral' },
  }

  return blocks
}
