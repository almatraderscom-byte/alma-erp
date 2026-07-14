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
import { writeCheckpoint } from '@/agent/lib/checkpoint'
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
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
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
    'Call this the moment you complete the tracked work, OR when Boss says to drop / defer it ("বাদ দাও", "পরে করব") — so the "বাকি কাজ" chip clears immediately. ' +
    'You usually do NOT need an id: omit openTaskId and it resolves the task Boss is currently working on (the one just continued), or the only open task. ' +
    'If several are open and it cannot tell which, it returns the list so you can call again with the right openTaskId.',
  input_schema: {
    type: 'object' as const,
    properties: {
      openTaskId: { type: 'string', description: 'The id returned by track_open_task. Optional — omit to auto-pick the task being worked on / the only open one.' },
      status: { type: 'string', enum: ['done', 'cancelled'], description: 'done = finished · cancelled = dropped/deferred' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
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
        // Checkpoint chips (auto-saved at the serverless deadline or via
        // save_task_checkpoint) resolve through the same call — otherwise a
        // finished task left a stale ⏸️ chip the model had no way to clear.
        const followups = open.filter((t) => ['chat_followup', 'checkpoint_failed', 'checkpoint_waiting'].includes(t.kind))
        if (followups.length === 0) {
          // Idempotent no-op: nothing open is the DESIRED end state. Returning an
          // error here confused weak heads into retry loops / apology spirals
          // (2026-07-12 handler_error in the WhatsApp-fix run).
          return { success: true, data: { message: 'কোনো খোলা কাজ নেই — সব আগেই resolved। এগিয়ে যাও।' } }
        }
        // A task the owner clicked "Continue" on is uniquely marked 'running' — that
        // is the one being actively worked on, so prefer it when no id is supplied.
        const running = followups.filter((t) => t.status === 'running')
        if (running.length === 1) id = running[0].id
        else if (followups.length === 1) id = followups[0].id
        else {
          // Genuinely ambiguous — hand the list back so the head retries with an id
          // (never dead-end and tell Boss to dismiss manually).
          return {
            success: false,
            error: 'multiple open tasks — call again with openTaskId',
            data: { openTasks: followups.map((t) => ({ openTaskId: t.id, title: t.title, status: t.status })) },
          }
        }
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

const save_task_checkpoint: AgentTool = {
  name: 'save_task_checkpoint',
  description:
    'Freeze a live multi-step task (usually a web/browser task in the owner\'s Chrome) at the EXACT ' +
    'point it got stuck, so it can resume from there — not from scratch. USE THE MOMENT you hit ' +
    'something only the owner can do (login, CAPTCHA, 2FA/OTP, a payment/send click, a choice, an ' +
    'access grant) or the task failed partway: the owner gets a ⏸️/⛔ chip in chat + a phone push, and ' +
    'when he answers/fixes it, the resume brief hands the next turn everything needed to CONTINUE ' +
    'from currentStep (his Chrome keeps the tab state, so pick up right where you stopped — verify ' +
    'with live_browser_look first).\n' +
    'Write everything SELF-CONTAINED and in Bangla where marked: doneSteps (what is already done — ' +
    'never redo these), currentStep (exactly where you are: page/URL + what is on screen), ' +
    'nextActions (the precise remaining steps), resumeHint (one paragraph a fresh context can act ' +
    'on alone), and — when waiting on the owner — `question` (the ONE thing you need from him, e.g. ' +
    '"Ads Manager-এ login করে দিন, আমি campaign form পূরণ করে রেখেছি")। ' +
    'When the blocker is resolved and the task finishes, clear the chip with resolve_open_task.',
  input_schema: {
    type: 'object' as const,
    properties: {
      goal: { type: 'string', description: 'Short Bangla name of the overall task, e.g. "queenspabd.com-এ ads campaign সেটআপ".' },
      summaryBn: { type: 'string', description: '২-৩ বাক্যে বাংলায়: কতদূর হয়েছে + কোথায় আটকেছে (owner chip-এ দেখবেন).' },
      doneSteps: { type: 'array', items: { type: 'string' }, description: 'Steps ALREADY completed — resume must not redo these.' },
      currentStep: { type: 'string', description: 'Exactly where the task is frozen: URL/page + on-screen state.' },
      nextActions: { type: 'array', items: { type: 'string' }, description: 'The precise remaining steps, in order.' },
      resumeHint: { type: 'string', description: 'Self-contained resume brief — a fresh context continues from this alone.' },
      question: { type: 'string', description: 'If waiting on the owner: the ONE thing you need from him (Bangla). Omit for a plain failure checkpoint.' },
      error: { type: 'string', description: 'If the task FAILED: the honest cause.' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['goal', 'summaryBn', 'currentStep', 'resumeHint'],
  },
  handler: async (input) => {
    try {
      const goal = String(input.goal ?? '').trim()
      const conversationId = input.conversationId ? String(input.conversationId) : null
      if (!goal) return { success: false, error: 'goal is required' }
      const question = typeof input.question === 'string' && input.question.trim() ? input.question.trim() : undefined
      // Stable per-task ref: a retry that stalls again UPDATES the same chip.
      const slug = goal.toLowerCase().replace(/[^a-z0-9ঀ-৿]+/g, '-').slice(0, 60)
      const id = await writeCheckpoint({
        taskRef: `chat-${conversationId ?? 'na'}-${slug}`,
        taskType: 'browser',
        state: question ? 'waiting_for_owner' : 'failed',
        goal,
        summaryBn: String(input.summaryBn ?? '').trim(),
        doneSteps: Array.isArray(input.doneSteps) ? (input.doneSteps as unknown[]).map(String) : [],
        currentStep: String(input.currentStep ?? '').trim(),
        artifacts: [],
        nextActions: Array.isArray(input.nextActions) ? (input.nextActions as unknown[]).map(String) : [],
        resumeHint: String(input.resumeHint ?? '').trim(),
        question,
        error: typeof input.error === 'string' && input.error.trim() ? input.error.trim() : undefined,
        conversationId,
      })
      if (!id) return { success: false, error: 'checkpoint লেখা যায়নি' }
      return {
        success: true,
        data: {
          checkpointId: id,
          note: question
            ? '⏸️ Checkpoint saved — reply-তে বসকে ঠিক কী করতে হবে সেটা এক লাইনে বলো; সে করলে ঠিক এখান থেকেই resume হবে।'
            : '⛔ Checkpoint saved — reply-তে সৎভাবে বলো কোথায় কেন আটকেছে এবং কী করলে এগোনো যাবে।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const OPEN_TASK_TOOLS: AgentTool[] = [track_open_task, resolve_open_task, save_task_checkpoint]
