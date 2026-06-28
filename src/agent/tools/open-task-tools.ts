/**
 * Open-loop task tools — the head records / clears work left unfinished so a new
 * task starting in the same chat doesn't lose the old one.
 *
 *   • track_open_task   — log a chat_followup (an owner request the agent started
 *                         but hasn't finished) with a self-contained resumeNote.
 *   • resolve_open_task — mark a tracked task done or cancelled.
 *
 * Approval-pending cards are tracked automatically when a confirm card is created
 * (see the approval flow) — the head only needs these tools for chat follow-ups.
 *
 * conversationId is injected from the server context, so the head never supplies it.
 */
import { createOpenTask, resolveOpenTask, listOpenTasks } from '@/agent/lib/open-task'
import type { AgentTool } from './registry'

const track_open_task: AgentTool = {
  name: 'track_open_task',
  description:
    'Record a piece of work you have STARTED for the owner but have NOT finished yet — so it is not lost when the next task begins. ' +
    'Use this the moment you switch to a different request while something is still incomplete (e.g. owner asked to check Ads Manager, then asked for a Facebook post — track the Ads check). ' +
    'Write a SELF-CONTAINED Bangla resumeNote: it must contain everything needed to pick the work back up later WITHOUT re-reading the chat or searching tools — what was asked, what you already did, and the exact next step. ' +
    'Do NOT track trivial one-shot answers. At most a handful of open tasks per chat.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Short Bangla label for the unfinished task (owner sees this on the chip).' },
      resumeNote: {
        type: 'string',
        description:
          'Self-contained Bangla brief to resume the work from scratch: the request, progress so far, and the precise next action. No outside context needed.',
      },
      conversationId: { type: 'string' },
    },
    required: ['title', 'resumeNote'],
  },
  handler: async (input) => {
    const title = String(input.title ?? '').trim()
    const resumeNote = String(input.resumeNote ?? '').trim()
    const conversationId = input.conversationId ? String(input.conversationId) : null
    const businessId = (input.businessId as string | undefined) ?? 'ALMA_LIFESTYLE'

    if (!title) return { success: false, error: 'title is required' }
    if (resumeNote.length < 10) return { success: false, error: 'resumeNote must be a self-contained brief' }

    try {
      const task = await createOpenTask({ businessId, conversationId, title, kind: 'chat_followup', resumeNote })
      return {
        success: true,
        data: {
          openTaskId: task.id,
          title: task.title,
          message: `🔄 "${task.title}" বাকি কাজ হিসেবে রাখা হলো — নতুন কাজ শেষ হলে মনে করিয়ে দেব।`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const resolve_open_task: AgentTool = {
  name: 'resolve_open_task',
  description:
    'Mark a previously tracked open task as finished (done) or dropped (cancelled). ' +
    'Call this once you actually complete the work you tracked, so the "বাকি কাজ" chip clears. ' +
    'Pass the openTaskId from track_open_task, or omit it to resolve the single open task in this chat.',
  input_schema: {
    type: 'object' as const,
    properties: {
      openTaskId: { type: 'string', description: 'The id returned by track_open_task. Optional if there is only one open task.' },
      status: { type: 'string', enum: ['done', 'cancelled'], description: 'done = finished · cancelled = dropped' },
      conversationId: { type: 'string' },
    },
    required: ['status'],
  },
  handler: async (input) => {
    const status = input.status === 'cancelled' ? 'cancelled' : 'done'
    const conversationId = input.conversationId ? String(input.conversationId) : null
    const businessId = (input.businessId as string | undefined) ?? 'ALMA_LIFESTYLE'
    let id = input.openTaskId ? String(input.openTaskId) : ''

    try {
      if (!id && conversationId) {
        const open = await listOpenTasks(conversationId, businessId)
        const followups = open.filter((t) => t.kind === 'chat_followup')
        if (followups.length === 1) id = followups[0].id
        else if (followups.length === 0) return { success: false, error: 'no open chat task to resolve' }
        else return { success: false, error: 'multiple open tasks — pass openTaskId' }
      }
      if (!id) return { success: false, error: 'openTaskId is required' }

      const task = await resolveOpenTask(id, status)
      if (!task) return { success: false, error: 'open task not found' }
      return {
        success: true,
        data: {
          openTaskId: task.id,
          status,
          message: status === 'done' ? `✅ "${task.title}" শেষ — বাকি কাজ থেকে সরানো হলো।` : `🚫 "${task.title}" বাদ দেওয়া হলো।`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const OPEN_TASK_TOOLS: AgentTool[] = [track_open_task, resolve_open_task]
