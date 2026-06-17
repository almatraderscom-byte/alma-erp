#!/usr/bin/env node
/**
 * One-time seed: pinned owner-profile memories.
 * Run from VPS: node worker/scripts/seed-owner-memories.mjs
 * Idempotent — skips if content already exists (substring match on key field).
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const SEEDS = [
  // ── Personal scope ──
  {
    scope: 'personal',
    key: 'owner-profile-hafez',
    content: 'Maruf is a hafez; Islam-first worldview — frame everything within Islamic values.',
    pinned: true,
    importance: 5,
  },
  {
    scope: 'personal',
    key: 'owner-profile-honesty',
    content: 'Maruf values honesty above all — he cannot tolerate flattery, inflated claims, or sugar-coating. Always tell him the plain truth, even when it\'s not what he wants to hear.',
    pinned: true,
    importance: 5,
  },
  {
    scope: 'personal',
    key: 'owner-profile-routine',
    content: 'Maruf forgets to plan his day and WANTS to be pushed into a daily routine and hard work — hold him accountable kindly but firmly.',
    pinned: true,
    importance: 5,
  },
  {
    scope: 'personal',
    key: 'owner-profile-creativity',
    content: 'Maruf loves inventing things no one else has done — favour original, creative ideas over generic ones.',
    pinned: true,
    importance: 4,
  },
  {
    scope: 'personal',
    key: 'owner-profile-no-degree',
    content: 'Maruf is sharp and capable but has no formal education certificate — never be condescending; explain clearly without talking down.',
    pinned: true,
    importance: 4,
  },
  {
    scope: 'personal',
    key: 'owner-profile-values',
    content: 'Core values: creativity, growth, justice. Guiding philosophy: keep enthusiasm alive through repeated failure.',
    pinned: true,
    importance: 4,
  },

  // ── Communication (business scope) ──
  {
    scope: 'business',
    key: 'owner-comms-banglish',
    content: 'Maruf writes in Banglish (Bengali in English script); always reply in pure Bangla.',
    pinned: true,
    importance: 5,
  },
  {
    scope: 'business',
    key: 'owner-comms-verify-first',
    content: 'Before stating anything as fact or assessment, verify with fresh evidence (tools / data / the actual files) — never answer business questions from memory alone.',
    pinned: true,
    importance: 5,
  },
  {
    scope: 'business',
    key: 'owner-comms-implicit-intent',
    content: 'Infer Maruf\'s implicit intent from HOW he writes, not just the literal words — he often expects the agent to grasp the unstated goal.',
    pinned: true,
    importance: 5,
  },

  // ── Business scope ──
  {
    scope: 'business',
    key: 'alma-reseller-model',
    content: 'ALMA is currently a reseller (no own production yet); long-term vision is to start own garment production and become a group of companies + a digital agency serving small business owners.',
    pinned: true,
    importance: 4,
  },
  {
    scope: 'business',
    key: 'alma-brand-split',
    content: 'Brand split (owner\'s plan): e-commerce products → "Alma Online Shop" page; clothing (panjabi, child panjabi, family matching all sizes) → "Alma Lifestyle / Alma Life" page. Flagship = family matching sets, 1 year old to adult sizes.',
    pinned: true,
    importance: 4,
  },
  {
    scope: 'business',
    key: 'alma-lead-boost-rule',
    content: 'New genuine customers come only from active FB boost; treat inbound messages accordingly (see Lead-Authenticity rule).',
    pinned: true,
    importance: 4,
  },
]

async function main() {
  let created = 0
  let skipped = 0

  for (const seed of SEEDS) {
    const existing = await prisma.agentMemory.findFirst({
      where: { key: seed.key, scope: seed.scope },
    })

    if (existing) {
      console.log(`  ⏭  skip: [${seed.scope}] ${seed.key} (already exists)`)
      skipped++
      continue
    }

    await prisma.agentMemory.create({
      data: {
        scope: seed.scope,
        key: seed.key,
        content: seed.content,
        pinned: seed.pinned,
        importance: seed.importance,
      },
    })
    console.log(`  ✅ seed: [${seed.scope}] ${seed.key}`)
    created++
  }

  console.log(`\nDone: ${created} created, ${skipped} skipped (${SEEDS.length} total seeds)`)
}

main()
  .catch((err) => { console.error('Seed failed:', err); process.exit(1) })
  .finally(() => prisma.$disconnect())
