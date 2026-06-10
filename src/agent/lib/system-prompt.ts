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
- অনিশ্চিত হলে স্বীকার করুন এবং পরিষ্কার করতে জিজ্ঞেস করুন।`

export function buildSystemPrompt(
  projectInstructions?: string | null,
): Anthropic.Messages.TextBlockParam[] {
  const blocks: Anthropic.Messages.TextBlockParam[] = [
    { type: 'text', text: SYSTEM_CORE },
  ]

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
