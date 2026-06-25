import type { AgentTool } from './registry'

const get_personal_briefing: AgentTool = {
  name: 'get_personal_briefing',
  description:
    "Owner's PERSONAL-life morning briefing in one shot: today's salah status, today's reminders, bills due " +
    'soon / overdue, upcoming birthdays-anniversaries-Islamic dates, this-month expense burn, and open personal ' +
    'todos. Use when the owner asks "ajker personal overview", "amar ajker din ki", "bill-date-namaz sob dekhao", ' +
    'or for a proactive personal rundown. (For BUSINESS overview use get_daily_digest.)',
  input_schema: {
    type: 'object' as const,
    properties: {
      billWindowDays: { type: 'number', description: 'Bills due within N days (default 5)' },
      dateWindowDays: { type: 'number', description: 'Important dates within N days (default 14)' },
    },
  },
  handler: async (input) => {
    try {
      const { buildPersonalBriefing } = await import('@/lib/personal-briefing-data')
      const briefing = await buildPersonalBriefing({
        billWindowDays: input.billWindowDays != null ? Number(input.billWindowDays) : undefined,
        dateWindowDays: input.dateWindowDays != null ? Number(input.dateWindowDays) : undefined,
      })
      return { success: true, data: briefing }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const PERSONAL_BRIEFING_TOOLS: AgentTool[] = [get_personal_briefing]
