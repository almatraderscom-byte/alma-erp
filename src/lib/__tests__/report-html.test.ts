/**
 * Client-report HTML template — behaviour lock + local Chromium print smoke.
 *
 * The smoke test runs the EXACT production pipeline (buildReportHtml →
 * headless Chrome → page.pdf) against a real-shaped Bangla report and writes
 * the PDF to the scratchpad — reviewed by eye before every deploy of this
 * feature (2026-07-16 lesson: three deploy-test loops that a local render
 * would have caught).
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { buildReportHtml } from '@/lib/pdf/report-html'

// Same shape the route builds from disk — data: URIs, never HTTP (preview
// deployments sit behind Vercel SSO; headless Chromium can't fetch /fonts).
async function loadFonts() {
  const dir = path.join(process.cwd(), 'public', 'fonts')
  const toDataUri = async (f: string) =>
    `data:font/ttf;base64,${(await readFile(path.join(dir, f))).toString('base64')}`
  return {
    regular: await toDataUri('NotoSansBengali-Regular.ttf'),
    semiBold: await toDataUri('NotoSansBengali-SemiBold.ttf'),
    bold: await toDataUri('NotoSansBengali-Bold.ttf'),
  }
}

const MD = [
  '# ক্লায়েন্ট সাইট অডিট রিপোর্ট',
  '',
  'প্রস্তুত: ALMA Digital · ১৬ জুলাই ২০২৬',
  '',
  '## এক্সিকিউটিভ সামারি',
  '',
  'দুটি ডোমেইন পরীক্ষা করে দেখা গেছে — **এগুলো আসলে একটাই ওয়েবসাইট, দুটো ঠিকানা।** gulshanspaone.com ব্রাউজারে খুললেই সরাসরি queenspabd.com-এ চলে যায়।',
  '',
  '| মেট্রিক | মান |',
  '| --- | --- |',
  '| সামগ্রিক স্কোর | ২৬/১০০ (গ্রেড F) |',
  '| মোট পৃষ্ঠা পর্যালোচনা | ২২টি |',
  '| মোট সমস্যা | ৫৪টি |',
  '',
  '## গুরুত্ব অনুযায়ী সমস্যা',
  '',
  '1. Schema.org (JSON-LD) মার্কআপ নেই — ২২টি পৃষ্ঠায়',
  '2. ছবির alt টেক্সট নেই — ২১টি জায়গায়',
  '3. ডুপ্লিকেট টাইটেল — ৪টি পৃষ্ঠায়',
  '',
  '- HTTPS সক্রিয় ও কার্যকরী',
  '- robots.txt উপস্থিত — queenspabd-gulshanspaone-combined-seo-audit-report.md এর মতো লম্বা token-ও ঠিক ভাঙবে',
  '',
  '## উপসংহার',
  '',
  'ফেজ ১-এর ৩টি কাজ করলেই স্কোর ৪৫+ এ পৌঁছানো সম্ভব। এসইও-র পাশাপাশি **প্রাইসিং ও CTA-র অভাব** সবচেয়ে বড় সমস্যা।',
].join('\n')

describe('buildReportHtml', () => {
  it('lifts H1 → title, প্রস্তুত-line → header meta, renders tables/lists, escapes HTML', async () => {
    const { html, title } = buildReportHtml({
      markdown: MD + '\n\n<script>alert(1)</script>',
      fallbackTitle: 'x.md',
      fonts: await loadFonts(),
    })
    expect(title).toBe('ক্লায়েন্ট সাইট অডিট রিপোর্ট')
    expect(html).toContain('প্রস্তুত: ALMA Digital · ১৬ জুলাই ২০২৬')
    expect(html).toContain('<table>')
    expect(html).toContain('<ol>')
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain("url('data:font/ttf;base64,")
  })
})

const LOCAL_CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
].find((p) => existsSync(p))

describe.skipIf(!LOCAL_CHROME)('local Chromium print smoke (production pipeline)', () => {
  it('prints the Bangla report to a real multi-KB PDF', async () => {
    const puppeteer = (await import('puppeteer-core')).default
    const { html } = buildReportHtml({ markdown: MD, fallbackTitle: 'x', fonts: await loadFonts() })
    const browser = await puppeteer.launch({ executablePath: LOCAL_CHROME!, headless: true })
    try {
      const page = await browser.newPage()
      await page.setContent(html, { waitUntil: 'load', timeout: 30_000 })
      await page.evaluateHandle('document.fonts.ready')
      const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true })
      expect(pdf.length).toBeGreaterThan(30_000)
      expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe('%PDF-')
      const out = path.join(process.env.CLAUDE_SCRATCHPAD ?? os.tmpdir(), 'client-report-smoke.pdf')
      await writeFile(out, pdf)
      console.log('smoke PDF written:', out)
    } finally {
      await browser.close()
    }
  }, 60_000)
})
