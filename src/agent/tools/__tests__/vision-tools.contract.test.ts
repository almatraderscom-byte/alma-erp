import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockDownload = vi.fn()
vi.mock('@/agent/lib/storage', () => ({
  agentStorageDownload: (...args: unknown[]) => mockDownload(...args),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentToolEvent: { create: vi.fn() },
    agentCostEvent: { findUnique: vi.fn(), create: vi.fn().mockResolvedValue({ id: 'c1' }) },
  },
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => {
  vi.clearAllMocks()
  process.env.GEMINI_API_KEY = 'test-key'
})

function makeGeminiResponse(json: Record<string, unknown>) {
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    }),
    text: async () => '',
  }
}

function makeGeminiBadResponse() {
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: 'not json at all!!!' }] } }],
    }),
    text: async () => '',
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// QC Inspect
// ═══════════════════════════════════════════════════════════════════════════
describe('qc_inspect_photo', () => {
  it('returns structured QC result on valid image', async () => {
    const { VISION_TOOLS } = await import('@/agent/tools/vision-tools')
    const tool = VISION_TOOLS.find(t => t.name === 'qc_inspect_photo')!

    mockDownload.mockResolvedValue(Buffer.from('fake-image'))
    mockFetch.mockResolvedValue(makeGeminiResponse({
      lighting: 'good',
      background_clean: true,
      wrinkles: 'none',
      brand_frame_ok: true,
      crop_ok: true,
      score: 85,
      issues: [],
      verdict: 'pass',
    }))

    const result = await tool.handler({ file_path: 'photos/test.jpg' })
    expect(result.success).toBe(true)
    expect((result.data as Record<string, unknown>).score).toBe(85)
    expect((result.data as Record<string, unknown>).verdict).toBe('pass')
  })

  it('returns error when file_path is missing', async () => {
    const { VISION_TOOLS } = await import('@/agent/tools/vision-tools')
    const tool = VISION_TOOLS.find(t => t.name === 'qc_inspect_photo')!

    const result = await tool.handler({})
    expect(result.success).toBe(false)
    expect(result.error).toContain('file_path')
  })

  it('returns success:false on unparseable Gemini response', async () => {
    const { VISION_TOOLS } = await import('@/agent/tools/vision-tools')
    const tool = VISION_TOOLS.find(t => t.name === 'qc_inspect_photo')!

    mockDownload.mockResolvedValue(Buffer.from('fake-image'))
    mockFetch.mockResolvedValue(makeGeminiBadResponse())

    const result = await tool.handler({ file_path: 'photos/test.jpg' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Vision analysis failed')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Extract Invoice
// ═══════════════════════════════════════════════════════════════════════════
describe('extract_invoice', () => {
  it('returns structured invoice with whole taka amounts', async () => {
    const { VISION_TOOLS } = await import('@/agent/tools/vision-tools')
    const tool = VISION_TOOLS.find(t => t.name === 'extract_invoice')!

    mockDownload.mockResolvedValue(Buffer.from('fake-invoice'))
    mockFetch.mockResolvedValue(makeGeminiResponse({
      vendor: 'Office Supplies BD',
      date: '2026-06-15',
      line_items: [{ description: 'A4 Paper', quantity: 5, unit_price_taka: 200, total_taka: 1000 }],
      total_taka: 1000,
      currency: 'BDT',
    }))

    const result = await tool.handler({ file_path: 'receipts/inv1.jpg' })
    expect(result.success).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data.total_taka).toBe(1000)
    expect(data.currency).toBe('BDT')
    expect(data.vendor).toBe('Office Supplies BD')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Competitor Poster
// ═══════════════════════════════════════════════════════════════════════════
describe('read_competitor_poster', () => {
  it('returns competitor analysis', async () => {
    const { VISION_TOOLS } = await import('@/agent/tools/vision-tools')
    const tool = VISION_TOOLS.find(t => t.name === 'read_competitor_poster')!

    mockDownload.mockResolvedValue(Buffer.from('fake-poster'))
    mockFetch.mockResolvedValue(makeGeminiResponse({
      brand_name: 'Aarong',
      price_taka: 1500,
      offer: 'Buy 2 get 1 free',
      product_type: 'panjabi',
      claims: ['Pure cotton', 'Handmade'],
      design_notes: 'Clean layout, warm tones',
      threat_level: 'medium',
    }))

    const result = await tool.handler({ file_path: 'competitors/poster1.jpg' })
    expect(result.success).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data.price_taka).toBe(1500)
    expect(data.threat_level).toBe('medium')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Screenshot
// ═══════════════════════════════════════════════════════════════════════════
describe('read_screenshot', () => {
  it('detects payment screenshot type', async () => {
    const { VISION_TOOLS } = await import('@/agent/tools/vision-tools')
    const tool = VISION_TOOLS.find(t => t.name === 'read_screenshot')!

    mockDownload.mockResolvedValue(Buffer.from('fake-screenshot'))
    mockFetch.mockResolvedValue(makeGeminiResponse({
      type: 'payment_confirmation',
      platform: 'bKash',
      extracted_data: {
        amount_taka: 5000,
        sender: 'Maruf',
        transaction_id: 'TXN123456',
        status: 'success',
      },
      summary: 'bKash payment of 5000 taka successful',
    }))

    const result = await tool.handler({ file_path: 'screenshots/pay1.png' })
    expect(result.success).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data.type).toBe('payment_confirmation')
    expect(data.platform).toBe('bKash')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Brand Check
// ═══════════════════════════════════════════════════════════════════════════
describe('compare_to_brand', () => {
  it('returns brand compliance check', async () => {
    const { VISION_TOOLS } = await import('@/agent/tools/vision-tools')
    const tool = VISION_TOOLS.find(t => t.name === 'compare_to_brand')!

    mockDownload.mockResolvedValue(Buffer.from('fake-design'))
    mockFetch.mockResolvedValue(makeGeminiResponse({
      on_brand: true,
      palette_match: 'exact',
      font_match: 'correct',
      style_match: 'premium',
      violations: [],
      score: 92,
      recommendation: null,
    }))

    const result = await tool.handler({ file_path: 'designs/poster.png' })
    expect(result.success).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data.on_brand).toBe(true)
    expect(data.score).toBe(92)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Storage download failure
// ═══════════════════════════════════════════════════════════════════════════
describe('error handling', () => {
  it('returns success:false when storage download fails', async () => {
    const { VISION_TOOLS } = await import('@/agent/tools/vision-tools')
    const tool = VISION_TOOLS.find(t => t.name === 'qc_inspect_photo')!

    mockDownload.mockRejectedValue(new Error('File not found'))

    const result = await tool.handler({ file_path: 'nonexistent.jpg' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('File not found')
  })

  it('returns success:false when GEMINI_API_KEY is missing', async () => {
    delete process.env.GEMINI_API_KEY
    const { VISION_TOOLS } = await import('@/agent/tools/vision-tools')
    const tool = VISION_TOOLS.find(t => t.name === 'extract_invoice')!

    mockDownload.mockResolvedValue(Buffer.from('fake'))

    const result = await tool.handler({ file_path: 'test.jpg' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('GEMINI_API_KEY')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Routing: vision group in golden table
// ═══════════════════════════════════════════════════════════════════════════
describe('vision group routing', () => {
  it('qc keyword routes to vision group', async () => {
    const { selectToolGroupsSync } = await import('@/agent/tools/select-tools')
    const result = selectToolGroupsSync('ei photo ta qc check koro', { personalMode: false, businessId: 'ALMA_LIFESTYLE' })
    expect(result.groups).toContain('vision')
  })

  it('invoice keyword routes to vision group', async () => {
    const { selectToolGroupsSync } = await import('@/agent/tools/select-tools')
    const result = selectToolGroupsSync('ei invoice ta read koro', { personalMode: false, businessId: 'ALMA_LIFESTYLE' })
    expect(result.groups).toContain('vision')
  })

  it('screenshot keyword routes to vision group', async () => {
    const { selectToolGroupsSync } = await import('@/agent/tools/select-tools')
    const result = selectToolGroupsSync('ei screenshot ta dekho ki ache', { personalMode: false, businessId: 'ALMA_LIFESTYLE' })
    expect(result.groups).toContain('vision')
  })

  it('brand check routes to vision group', async () => {
    const { selectToolGroupsSync } = await import('@/agent/tools/select-tools')
    const result = selectToolGroupsSync('ei design ta brand check koro', { personalMode: false, businessId: 'ALMA_LIFESTYLE' })
    expect(result.groups).toContain('vision')
  })
})
