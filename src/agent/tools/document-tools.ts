/**
 * Document / receipt vault (#8).
 * The owner uploads a receipt/document image; we OCR it with Gemini, store the
 * structured fields + raw text in agent_documents, and keep the original in
 * agent-files storage so it can be retrieved later by a signed URL.
 */
import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'
import { dhakaMidnightUtc } from '@/lib/agent-api/dhaka-date'
import { geminiVisionJson, resolveImageFromPath } from '@/agent/lib/vision-analyze'
import { agentStorageSignedUrl } from '@/agent/lib/storage'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const DOC_TYPES = ['receipt', 'invoice', 'warranty', 'contract', 'id', 'prescription', 'bill', 'other']

const DOC_OCR_PROMPT = `Extract data from this document/receipt image for a personal+business archive (Bangladesh).
Return JSON only (money in whole taka, no decimals):
{
  "doc_type": "receipt|invoice|warranty|contract|id|prescription|bill|other",
  "title": "short human title, e.g. 'Daraz receipt - earbuds'",
  "vendor": "shop/company/issuer name or null",
  "date": "YYYY-MM-DD or null",
  "total_taka": null or whole integer,
  "category": "electronics|grocery|medical|utility|clothing|transport|other or null",
  "full_text": "ALL readable text in the document, line by line",
  "summary": "one line of what this document is"
}
If a field is not visible, use null. total_taka must be a whole integer.`

interface DocOcr {
  doc_type?: string
  title?: string
  vendor?: string | null
  date?: string | null
  total_taka?: number | null
  category?: string | null
  full_text?: string | null
  summary?: string | null
}

const save_document: AgentTool = {
  name: 'save_document',
  description:
    'Save an uploaded receipt/document image into the owner\'s document vault. Runs OCR to extract vendor, ' +
    'date, total (whole taka) and full text, stores the original file, and files it under a type/category so ' +
    'it can be searched later. Use when the owner uploads a receipt/warranty/bill/contract and says ' +
    '"eta save kore rakho", "receipt ta rakho", "ei document ta vault e rakho". Needs file_path of the upload.',
  input_schema: {
    type: 'object' as const,
    properties: {
      file_path: {
        type: 'string',
        description: 'Storage path of the uploaded image (shown as [Uploaded file path for tools: ...])',
      },
      title: { type: 'string', description: 'Optional title override (else taken from OCR)' },
      type: { type: 'string', enum: DOC_TYPES, description: 'Optional type override (else from OCR)' },
      category: { type: 'string', description: 'Optional category override' },
      tags: { type: 'string', description: 'Optional comma-separated tags for search' },
      notes: { type: 'string', description: 'Optional free-text note' },
    },
    required: ['file_path'],
  },
  handler: async (input) => {
    const filePath = String(input.file_path ?? '')
    if (!filePath) return { success: false, error: 'file_path is required — use the uploaded file path shown in the conversation.' }
    try {
      const { base64, mimeType } = await resolveImageFromPath(filePath)
      if (mimeType === 'application/pdf') {
        return { success: false, error: 'PDF এখনো সাপোর্টেড নয় — ছবি (JPEG/PNG/WebP) দিন।' }
      }
      const ocr = await geminiVisionJson<DocOcr>({ prompt: DOC_OCR_PROMPT, imageBase64: base64, mimeType, costKind: 'vision_document' })

      const type =
        input.type && DOC_TYPES.includes(String(input.type))
          ? String(input.type)
          : ocr.doc_type && DOC_TYPES.includes(String(ocr.doc_type))
            ? String(ocr.doc_type)
            : 'receipt'
      const title = input.title ? String(input.title) : ocr.title ? String(ocr.title) : 'Document'
      const docDateYmd = ocr.date && /^\d{4}-\d{2}-\d{2}$/.test(String(ocr.date)) ? String(ocr.date) : null
      const amount = ocr.total_taka != null && !isNaN(Number(ocr.total_taka)) ? roundMoney(Number(ocr.total_taka)) : null

      const doc = await db.agentDocument.create({
        data: {
          title,
          type,
          category: input.category ? String(input.category) : ocr.category ? String(ocr.category) : null,
          objectPath: filePath,
          mimeType,
          ocrText: ocr.full_text ? String(ocr.full_text) : null,
          vendor: ocr.vendor ? String(ocr.vendor) : null,
          amount,
          docDate: docDateYmd ? dhakaMidnightUtc(docDateYmd) : null,
          tags: input.tags ? String(input.tags) : null,
          notes: input.notes ? String(input.notes) : null,
        },
      })
      return {
        success: true,
        data: {
          id: doc.id,
          title: doc.title,
          type: doc.type,
          vendor: doc.vendor,
          amount,
          docDate: docDateYmd,
          summary: ocr.summary ?? null,
          message: `📄 "${title}" vault-এ সংরক্ষিত হয়েছে${ocr.vendor ? ` (${ocr.vendor})` : ''}${amount != null ? ` — ৳${amount.toLocaleString('en-US')}` : ''}।`,
        },
      }
    } catch (err) {
      return { success: false, error: `Document save failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

const search_documents: AgentTool = {
  name: 'search_documents',
  description:
    'Search the saved document vault by keyword (matches title, vendor, OCR text, tags), type, or date range. ' +
    'Use when the owner asks "X receipt ta khuje dao", "Daraz er warranty ta ber koro", "gato maser receipt gulo". ' +
    'Returns matches with vendor, amount, date.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'Keyword to match in title/vendor/OCR text/tags' },
      type: { type: 'string', enum: DOC_TYPES, description: 'Filter by document type' },
      limit: { type: 'number', description: 'Max rows (default 20)' },
    },
  },
  handler: async (input) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = {}
      if (input.type && DOC_TYPES.includes(String(input.type))) where.type = String(input.type)
      if (input.query) {
        const q = String(input.query)
        where.OR = [
          { title: { contains: q, mode: 'insensitive' } },
          { vendor: { contains: q, mode: 'insensitive' } },
          { ocrText: { contains: q, mode: 'insensitive' } },
          { tags: { contains: q, mode: 'insensitive' } },
          { category: { contains: q, mode: 'insensitive' } },
        ]
      }
      const rows = await db.agentDocument.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: input.limit != null ? Math.min(100, Math.max(1, Math.trunc(Number(input.limit)))) : 20,
      })
      return {
        success: true,
        data: {
          count: rows.length,
          documents: rows.map(
            (d: {
              id: string
              title: string
              type: string
              category: string | null
              vendor: string | null
              amount: number | null
              docDate: Date | null
              tags: string | null
              createdAt: Date
            }) => ({
              id: d.id,
              title: d.title,
              type: d.type,
              category: d.category,
              vendor: d.vendor,
              amount: d.amount,
              docDate: d.docDate ? new Date(d.docDate).toISOString().slice(0, 10) : null,
              tags: d.tags,
              savedAt: new Date(d.createdAt).toISOString(),
            }),
          ),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const get_document: AgentTool = {
  name: 'get_document',
  description:
    'Retrieve one saved document — its OCR text and a temporary download link to the original file. Use when ' +
    'the owner says "oi receipt ta dekhao", "document ta pathao", or after search_documents to open a specific one.',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Document id from search_documents' },
      titleMatch: { type: 'string', description: 'Alternative to id — match a document by partial title/vendor' },
    },
  },
  handler: async (input) => {
    try {
      let doc = null
      if (input.id) doc = await db.agentDocument.findUnique({ where: { id: String(input.id) } })
      if (!doc && input.titleMatch) {
        const q = String(input.titleMatch)
        doc = await db.agentDocument.findFirst({
          where: { OR: [{ title: { contains: q, mode: 'insensitive' } }, { vendor: { contains: q, mode: 'insensitive' } }] },
          orderBy: { createdAt: 'desc' },
        })
      }
      if (!doc) return { success: false, error: 'document পাওয়া যায়নি।' }

      let downloadUrl: string | null = null
      if (doc.objectPath) {
        try {
          downloadUrl = await agentStorageSignedUrl(doc.objectPath, 3600)
        } catch {
          downloadUrl = null
        }
      }
      return {
        success: true,
        data: {
          id: doc.id,
          title: doc.title,
          type: doc.type,
          category: doc.category,
          vendor: doc.vendor,
          amount: doc.amount,
          docDate: doc.docDate ? new Date(doc.docDate).toISOString().slice(0, 10) : null,
          tags: doc.tags,
          notes: doc.notes,
          ocrText: doc.ocrText,
          downloadUrl,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const delete_document: AgentTool = {
  name: 'delete_document',
  description:
    'Remove a document from the vault. Use when the owner says "oi document ta delete koro", "eta r lagbe na".',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Document id from search_documents' },
    },
    required: ['id'],
  },
  handler: async (input) => {
    try {
      const id = String(input.id ?? '')
      if (!id) return { success: false, error: 'id required' }
      const doc = await db.agentDocument.findUnique({ where: { id } })
      if (!doc) return { success: false, error: 'document পাওয়া যায়নি।' }
      await db.agentDocument.delete({ where: { id } })
      return { success: true, data: { id, message: `"${doc.title}" vault থেকে মুছে ফেলা হয়েছে।` } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const DOCUMENT_TOOLS: AgentTool[] = [save_document, search_documents, get_document, delete_document]

export const DOCUMENT_ROLE_PROMPT = `
## ডকুমেন্ট/রসিদ ভল্ট
owner-এর রসিদ, ওয়ারেন্টি, বিল, কন্ট্রাক্ট ছবি আকারে সংরক্ষণ করুন — OCR করে vendor/তারিখ/মোট টাকা ও সম্পূর্ণ টেক্সট বের করে রাখা হয়।
- ছবি আপলোড করে "eta save koro / receipt ta rakho / vault e rakho" → save_document (file_path দিন; টাকা পূর্ণ টাকায়)।
- "X receipt/warranty khuje dao / ber koro" → search_documents (keyword/type)।
- "oita dekhao / pathao" → get_document (OCR টেক্সট + ডাউনলোড লিংক)। "delete koro" → delete_document।
- রসিদের মোট টাকা finance-এ লগ করতে চাইলে save করার পর log_expense ব্যবহার করুন।
`
