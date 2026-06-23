/**
 * Vision tools — structured image analysis for owner agent.
 * Each tool downloads the image from agent-files storage,
 * sends it to Gemini Flash for cheap structured analysis,
 * and returns typed JSON.
 */
import type { AgentTool } from './registry'
import { geminiVisionJson, resolveImageFromPath } from '@/agent/lib/vision-analyze'

// ── Prompts ────────────────────────────────────────────────────────────────

const QC_INSPECT_PROMPT = `You are a fashion e-commerce QC inspector for ALMA Lifestyle (Bangladesh).
Inspect this product/listing photo and return JSON only:
{
  "lighting": "good|acceptable|poor",
  "background_clean": true|false,
  "wrinkles": "none|minor|major",
  "brand_frame_ok": true|false,
  "crop_ok": true|false,
  "color_accuracy": "good|acceptable|poor",
  "model_pose": "natural|stiff|none",
  "score": 0-100,
  "issues": ["list of specific problems found"],
  "verdict": "pass|minor_fix|reshoot"
}
Score guide: 90-100=excellent, 70-89=good, 50-69=needs fix, <50=reshoot.
Be strict on: white/clean background, no wrinkles, proper lighting, full product visible, no blur.`

const EXTRACT_INVOICE_PROMPT = `Extract invoice/receipt data from this image.
Return JSON only (amounts in whole taka, no decimals/floats):
{
  "vendor": "vendor/shop name",
  "date": "YYYY-MM-DD",
  "invoice_number": "if visible",
  "line_items": [{"description": "item", "quantity": 1, "unit_price_taka": 500, "total_taka": 500}],
  "subtotal_taka": 500,
  "tax_taka": 0,
  "discount_taka": 0,
  "total_taka": 500,
  "currency": "BDT",
  "payment_method": "cash|bkash|bank|card|unknown",
  "notes": "any additional info"
}
IMPORTANT: All money values must be whole integers (no .50, no decimals). Round to nearest taka.
If a field is not visible, use null.`

const COMPETITOR_POSTER_PROMPT = `Analyze this competitor advertisement/poster image for a Bangladesh fashion business.
Return JSON only (prices in whole taka):
{
  "brand_name": "competitor brand if visible",
  "price_taka": null or whole integer,
  "offer": "description of any offer/discount",
  "product_type": "panjabi|frock|saree|t-shirt|etc",
  "claims": ["list of marketing claims made"],
  "design_notes": "layout, colors, typography quality assessment",
  "target_audience": "men|women|family|youth|etc",
  "threat_level": "high|medium|low"
}`

const SCREENSHOT_PROMPT = `Analyze this screenshot. First detect the type, then extract structured data.
Return JSON only:
{
  "type": "payment_confirmation|p2p_trade|chat_conversation|bank_statement|social_media|order_status|error_screen|other",
  "platform": "bKash|Nagad|bank|Binance|Facebook|WhatsApp|other",
  "extracted_data": {
    "amount_taka": null or whole integer,
    "sender": "name if visible",
    "receiver": "name if visible",
    "transaction_id": "if visible",
    "date": "YYYY-MM-DD if visible",
    "status": "success|pending|failed|unknown",
    "key_text": "most important text content (summary)"
  },
  "summary": "one line description of what this screenshot shows"
}
All money values must be whole integers. If not visible, use null.`

const ALMA_BRAND_COLORS = {
  cream: '#F5EBDD',
  charcoal: '#2A2622',
  mustard: '#C89B3C',
  maroon: '#6B2737',
  emerald: '#2D5F4F',
  terracotta: '#C97D5D',
}

const BRAND_CHECK_PROMPT = `You are checking if this design/creative follows ALMA Lifestyle brand guidelines.
Brand palette: Cream #F5EBDD, Charcoal #2A2622, Mustard #C89B3C, Maroon #6B2737, Emerald #2D5F4F, Terracotta #C97D5D.
Fonts: Noto Serif Bengali (headings), Hind Siliguri (body), Playfair Display (English accents).
Style: warm, premium, modern, clean. No busy/cheap design.

Return JSON only:
{
  "on_brand": true|false,
  "palette_match": "exact|close|off",
  "font_match": "correct|acceptable|wrong",
  "style_match": "premium|acceptable|cheap",
  "violations": ["list of specific brand guideline violations"],
  "score": 0-100,
  "recommendation": "brief fix suggestion if needed"
}
Score 80+ = on brand, 60-79 = minor fixes, <60 = redesign needed.`

// ── Tool implementations ───────────────────────────────────────────────────

async function visionToolHandler<T>(
  input: Record<string, unknown>,
  prompt: string,
  costKind: string,
): Promise<{ success: boolean; data?: T; error?: string }> {
  const filePath = String(input.file_path ?? '')
  if (!filePath) return { success: false, error: 'file_path is required — use the uploaded file path shown in the conversation.' }

  try {
    const { base64, mimeType } = await resolveImageFromPath(filePath)
    if (mimeType === 'application/pdf') {
      return { success: false, error: 'PDF not supported for this tool. Use image files (JPEG/PNG/WebP).' }
    }
    const result = await geminiVisionJson<T>({ prompt, imageBase64: base64, mimeType, costKind })
    return { success: true, data: result }
  } catch (err) {
    return { success: false, error: `Vision analysis failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

const FILE_PATH_PROP = {
  type: 'string' as const,
  description: 'Storage path of the uploaded image (shown as [Uploaded file path for tools: ...] in conversation)',
}

const qc_inspect_photo: AgentTool = {
  name: 'qc_inspect_photo',
  description:
    'Inspect a product/listing photo for QC (quality control). Returns lighting, background, wrinkles, crop, ' +
    'score 0-100, issues list, and verdict (pass/minor_fix/reshoot). Use before publishing listing photos.',
  input_schema: {
    type: 'object' as const,
    properties: { file_path: FILE_PATH_PROP },
    required: ['file_path'],
  },
  handler: (input) => visionToolHandler(input, QC_INSPECT_PROMPT, 'vision_qc'),
}

const extract_invoice: AgentTool = {
  name: 'extract_invoice',
  description:
    'Extract structured data from an invoice/receipt image. Returns vendor, date, line items, totals (whole taka). ' +
    'Feed results into finance tools for expense logging.',
  input_schema: {
    type: 'object' as const,
    properties: { file_path: FILE_PATH_PROP },
    required: ['file_path'],
  },
  handler: (input) => visionToolHandler(input, EXTRACT_INVOICE_PROMPT, 'vision_invoice'),
}

const read_competitor_poster: AgentTool = {
  name: 'read_competitor_poster',
  description:
    'Analyze a competitor ad/poster image. Returns price, offer, product type, marketing claims, design quality, ' +
    'and threat level. Feed into competitor-tools for watchlist.',
  input_schema: {
    type: 'object' as const,
    properties: { file_path: FILE_PATH_PROP },
    required: ['file_path'],
  },
  handler: (input) => visionToolHandler(input, COMPETITOR_POSTER_PROMPT, 'vision_competitor'),
}

const read_screenshot: AgentTool = {
  name: 'read_screenshot',
  description:
    'Read any screenshot (payment, P2P trade, chat, bank, social media, order status). Auto-detects type, ' +
    'extracts structured data including amounts (whole taka), sender/receiver, transaction ID, status.',
  input_schema: {
    type: 'object' as const,
    properties: { file_path: FILE_PATH_PROP },
    required: ['file_path'],
  },
  handler: (input) => visionToolHandler(input, SCREENSHOT_PROMPT, 'vision_screenshot'),
}

const compare_to_brand: AgentTool = {
  name: 'compare_to_brand',
  description:
    'Check if a design/creative follows ALMA brand guidelines (colors: Cream #F5EBDD, Charcoal #2A2622, ' +
    'Mustard #C89B3C, Maroon #6B2737, Emerald #2D5F4F, Terracotta #C97D5D; fonts: Noto Serif Bengali, ' +
    'Hind Siliguri, Playfair). Returns on_brand, violations, score.',
  input_schema: {
    type: 'object' as const,
    properties: { file_path: FILE_PATH_PROP },
    required: ['file_path'],
  },
  handler: (input) => visionToolHandler(input, BRAND_CHECK_PROMPT, 'vision_brand'),
}

export const VISION_TOOLS: AgentTool[] = [
  qc_inspect_photo,
  extract_invoice,
  read_competitor_poster,
  read_screenshot,
  compare_to_brand,
]

export { ALMA_BRAND_COLORS }

export const VISION_ROLE_PROMPT = `
## VISION TOOLS (File 17)
When the owner uploads an image, you can run structured analysis:
- qc_inspect_photo: Product photo QC before listing (score, issues, verdict)
- extract_invoice: Receipt/invoice → structured data (whole taka amounts for finance)
- read_competitor_poster: Competitor ad analysis (price, offer, threat level)
- read_screenshot: Any screenshot → structured extraction (payment, trade, chat, etc.)
- compare_to_brand: Check design against ALMA brand palette/fonts

Each requires file_path from the uploaded file. Always use the path shown in [Uploaded file path for tools: ...].
**The pasted image is ALREADY visible to you** in this turn's context — for a plain "এটা কী / এখানে কী লেখা / পড়ে দেখো" just read it directly from what you can see; you do NOT need read_screenshot for that. Reach for these tools only when you need STRUCTURED extraction (exact amounts/IDs into finance, QC score, brand check). If you ever get "[সংযুক্ত ছবি/ফাইলটি লোড করা যায়নি ...]" instead of the image, the upload didn't load — tell the owner honestly and ask him to resend; never pretend you saw it.
For invoices → feed extracted totals into log_expense (whole taka only, no float).
For QC fails → suggest reshoot or fixes before publishing.
`
