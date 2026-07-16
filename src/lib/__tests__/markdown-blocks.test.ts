/**
 * Client-report markdown parser — behaviour lock for the PDF export
 * (2026-07-16 owner ask). The grammar is exactly what the agent's reports use:
 * headings, paragraphs, bullets, pipe tables, bold; links/code flatten.
 */
import { describe, it, expect } from 'vitest'
import { parseMarkdownBlocks, parseInline, spansToText } from '@/lib/pdf/markdown-blocks'

describe('parseInline', () => {
  it('keeps **bold** as weighted spans, flattens links and code', () => {
    const spans = parseInline('আগে **Schema** যোগ করুন — [গাইড](https://x.y) `alt` টেক্সট সহ')
    expect(spansToText(spans)).toBe('আগে Schema যোগ করুন — গাইড alt টেক্সট সহ')
    expect(spans.find((s) => s.bold)?.text).toBe('Schema')
  })
})

describe('parseMarkdownBlocks', () => {
  it('parses the real report shapes: headings, meta, table, list', () => {
    const md = [
      '# ক্লায়েন্ট সাইট অডিট রিপোর্ট',
      '',
      'প্রস্তুত: ALMA Digital · ১৬ জুলাই ২০২৬',
      '',
      '## এক্সিকিউটিভ সামারি',
      '',
      'দুটি ডোমেইন পরীক্ষা করে দেখা গেছে — **একটাই ওয়েবসাইট**।',
      '',
      '| মেট্রিক | মান |',
      '| --- | --- |',
      '| সামগ্রিক স্কোর | ২৬/১০০ |',
      '| মোট সমস্যা | ৫৭টি |',
      '',
      '### ফেজ ১',
      '',
      '1. Schema যোগ করুন',
      '2. Alt টেক্সট দিন',
      '',
      '- HTTPS ঠিক আছে',
      '- sitemap আছে',
    ].join('\n')

    const blocks = parseMarkdownBlocks(md)
    expect(blocks[0]).toEqual({ kind: 'heading', level: 1, text: 'ক্লায়েন্ট সাইট অডিট রিপোর্ট' })
    expect(blocks[1].kind).toBe('paragraph')
    expect(blocks[2]).toEqual({ kind: 'heading', level: 2, text: 'এক্সিকিউটিভ সামারি' })

    const table = blocks.find((b) => b.kind === 'table')
    expect(table).toMatchObject({ header: ['মেট্রিক', 'মান'], rows: [['সামগ্রিক স্কোর', '২৬/১০০'], ['মোট সমস্যা', '৫৭টি']] })

    const ordered = blocks.find((b) => b.kind === 'list' && b.ordered)
    expect(ordered && 'items' in ordered ? ordered.items.length : 0).toBe(2)
    const bullets = blocks.find((b) => b.kind === 'list' && !b.ordered)
    expect(bullets && 'items' in bullets ? bullets.items.length : 0).toBe(2)
  })

  it('deep headings clamp to level 3; ragged table rows keep cell count via renderer', () => {
    const blocks = parseMarkdownBlocks('#### খুব গভীর\n\n| a | b | c |\n| - | - | - |\n| 1 | 2 |')
    expect(blocks[0]).toEqual({ kind: 'heading', level: 3, text: 'খুব গভীর' })
    const table = blocks[1]
    expect(table).toMatchObject({ kind: 'table', header: ['a', 'b', 'c'], rows: [['1', '2']] })
  })

  it('empty/whitespace input → no blocks, never throws', () => {
    expect(parseMarkdownBlocks('')).toEqual([])
    expect(parseMarkdownBlocks('   \n\n  ')).toEqual([])
  })
})
