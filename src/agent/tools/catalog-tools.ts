/**
 * CS-0 — Catalog tools for customer-sales agent (design groups + age→size).
 */
import type { AgentTool } from './registry'
import { getDesignGroup } from '@/agent/lib/catalog/design-groups'
import { getSizeForAge } from '@/agent/lib/catalog/size-charts'

const get_design_group: AgentTool = {
  name: 'get_design_group',
  description:
    'Look up a family-matching design group by product code or group code (FMG-xxx). ' +
    'Returns all member products with role (baba/chele/ma/meye), name, price, stock, primary image. ' +
    'Use when customer asks about matching family outfits or a design shown in a photo.',
  input_schema: {
    type: 'object' as const,
    properties: {
      codeOrGroup: { type: 'string', description: 'Product SKU or group code FMG-xxx' },
    },
    required: ['codeOrGroup'],
  },
  handler: async (input) => {
    try {
      const codeOrGroup = String(input.codeOrGroup ?? '').trim()
      if (!codeOrGroup) return { success: false, error: 'codeOrGroup required' }
      const group = await getDesignGroup({ codeOrGroup })
      if (!group) return { success: false, error: 'Group not found for this code' }
      return { success: true, data: group }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const get_size_for_age: AgentTool = {
  name: 'get_size_for_age',
  description:
    'Convert child age (years) to recommended size for a product SKU using business size charts. ' +
    'Returns sizeLabel and whether that size is in stock. If chart_missing, ask the owner — never guess.',
  input_schema: {
    type: 'object' as const,
    properties: {
      productCode: { type: 'string', description: 'Product SKU' },
      ageYears: { type: 'number', description: 'Age in whole or half years' },
      memberRole: {
        type: 'string',
        enum: ['baba', 'chele', 'ma', 'meye', 'couple', 'other'],
        description: 'Optional family role for category disambiguation',
      },
    },
    required: ['productCode', 'ageYears'],
  },
  handler: async (input) => {
    try {
      const result = await getSizeForAge({
        productCode: String(input.productCode),
        ageYears: Number(input.ageYears),
        memberRole: input.memberRole as string | undefined,
      })
      if (!result.success) {
        const { success: _s, ...rest } = result
        return { success: false, ...rest }
      }
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const CATALOG_TOOLS: AgentTool[] = [get_design_group, get_size_for_age]

/** CS-1 persona: age-first sizing (include in customer-sales prompt). */
export const CS_SIZE_PERSONA_GUIDANCE = `
সাইজ নির্ধারণে বয়স প্রথমে জিজ্ঞেস করুন — দোকানদারের মতো একটা প্রশ্ন: "বাবুর বয়স কত ভাইয়া?"
একবারে একটা প্রশ্ন। প্রাপ্তবয়স্ক হলে সাধারণ সাইজ বা উচ্চতা জিজ্ঞেস করুন।
get_size_for_age টুল দিয়ে বয়স→সাইজ বের করুন; chart_missing হলে অনুমান করবেন না — মালিককে জিজ্ঞেস করুন।
নিশ্চিত করুন: "৬ বছরের জন্য সাইজ ২৮ পারফেক্ট হবে ইনশাআল্লাহ"।
`.trim()
