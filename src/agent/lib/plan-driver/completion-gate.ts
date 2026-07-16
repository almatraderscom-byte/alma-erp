/**
 * Completion gate — the deterministic "is this plan ACTUALLY done?" judge.
 *
 * After every step in a plan is marked done, the driver still must not blindly
 * declare victory: the steps may have run yet the GOAL not truly be met (a post
 * drafted but not published, a report generated but empty, a reorder suggested
 * but not placed). This gate is a single, cheap LLM call that reads the goal, the
 * owner's plain-language done-criteria, and each step's result, then returns a
 * strict {done, reason} verdict.
 *
 * Owner decision (recorded): start the gate on DeepSeek under a tight token cap so
 * we can watch its judgement cheaply, then move it to Claude if its done/not-done
 * calls aren't reliable. The model id is owner-tunable (autodrive_gate_model).
 *
 * Fail-safe posture: ANY error / missing key / unparseable output → `done:false`
 * with a reason. The driver treats a not-done verdict as "keep working / escalate",
 * never as a false completion — so a flaky gate can only make the driver MORE
 * cautious, never prematurely declare success.
 */
import OpenAI from 'openai'
import { getModel } from '@/agent/lib/models/registry'
import { parseModelJson, isObjectWith } from '@/agent/lib/safe-json'
import { calcModelTurnCostUsd } from '@/agent/lib/models/cost'
import { logCost } from '@/agent/lib/cost-events'
import type { Plan } from '@/agent/lib/planner'

export interface CompletionVerdict {
  done: boolean
  reason: string
  /** Whole-USD model spend for this gate call (0 on the no-key fast-fail). */
  costUsd: number
}

const GATE_SYSTEM =
  'You are a strict completion auditor for a Bangla small-business assistant. ' +
  'You are given a GOAL, optional DONE-CRITERIA, and the RESULTS of each step that was executed. ' +
  'Decide whether the goal is TRULY and FULLY achieved — not merely that steps "ran", but that the ' +
  'real-world outcome the owner wanted actually happened. Be skeptical: if a step result is empty, ' +
  'vague, an error, or only says it "will" do something, the goal is NOT done. ' +
  'Reply with STRICT JSON only, no prose: {"done": true|false, "reason": "<one short Bangla sentence>"}.'

function openRouterClient(): OpenAI | null {
  const key = process.env.OPENROUTER_API_KEY?.trim()
  if (!key) return null
  const referer = process.env.APP_URL?.replace(/\/$/, '') ?? 'https://alma-erp-six.vercel.app'
  return new OpenAI({
    apiKey: key,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: { 'HTTP-Referer': referer, 'X-Title': 'ALMA ERP Agent (completion-gate)' },
  })
}

function stepResultLine(action: string, result: unknown, status: string): string {
  let summary: string
  if (result == null) summary = '(no result)'
  else if (typeof result === 'string') summary = result
  else {
    try {
      summary = JSON.stringify(result)
    } catch {
      summary = String(result)
    }
  }
  // Keep each line bounded so a fat tool payload can't blow the gate's token cap.
  if (summary.length > 600) summary = summary.slice(0, 600) + '…'
  return `- [${status}] ${action}: ${summary}`
}

/**
 * Run the completion gate for a plan. `gateModelId` comes from config
 * (autodrive_gate_model). Never throws — fails safe to {done:false}.
 */
export async function runCompletionGate(
  plan: Pick<Plan, 'id' | 'goal' | 'doneCriteria' | 'steps'>,
  gateModelId: string,
  opts: { conversationId?: string | null } = {},
): Promise<CompletionVerdict> {
  const client = openRouterClient()
  if (!client) {
    return { done: false, reason: 'গেট চালানো গেল না (OpenRouter কী নেই) — নিরাপত্তার জন্য DONE নয়।', costUsd: 0 }
  }

  let model: ReturnType<typeof getModel>
  try {
    model = getModel(gateModelId)
  } catch {
    return { done: false, reason: `গেট মডেল অজানা (${gateModelId}) — DONE নয়।`, costUsd: 0 }
  }

  const stepLines = plan.steps.map((s) => stepResultLine(s.action, s.result ?? s.error, s.status)).join('\n')
  const userPrompt =
    `GOAL: ${plan.goal}\n` +
    (plan.doneCriteria ? `DONE-CRITERIA: ${plan.doneCriteria}\n` : '') +
    `\nSTEP RESULTS:\n${stepLines || '(no steps)'}`

  try {
    const resp = await client.chat.completions.create(
      {
        model: model.apiModel,
        max_tokens: 120,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: GATE_SYSTEM },
          { role: 'user', content: userPrompt.slice(0, 6000) },
        ],
      },
      { signal: AbortSignal.timeout(15_000) },
    )

    const usage = resp.usage
    let costUsd = 0
    if (usage) {
      costUsd = calcModelTurnCostUsd(model, {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
      })
      void logCost({
        provider: 'openai',
        kind: 'chat',
        units: {
          input_tokens: usage.prompt_tokens ?? 0,
          output_tokens: usage.completion_tokens ?? 0,
          model: model.id,
          via: 'completion-gate',
        },
        costUsd,
        conversationId: opts.conversationId ?? null,
        dedupKey: `autodrive:gate:${plan.id}:${Date.now()}`,
      }).catch(() => {})
    }

    const raw = (resp.choices[0]?.message?.content ?? '').trim()
    const parsed = parseVerdict(raw)
    return { done: parsed.done, reason: parsed.reason, costUsd }
  } catch (err) {
    console.warn('[completion-gate] failed → not done:', err instanceof Error ? err.message : err)
    return { done: false, reason: 'গেট কল ব্যর্থ — নিরাপত্তার জন্য DONE নয়।', costUsd: 0 }
  }
}

/** Guarded JSON intake (safe-json, 2026-07-16): fenced/prose-wrapped/smart-quoted
 * verdicts all parse through the ONE guarded door; anything off-shape → not done. */
function parseVerdict(raw: string): { done: boolean; reason: string } {
  const parsed = parseModelJson(raw, isObjectWith('done'))
  if (!parsed.ok) return { done: false, reason: 'গেটের উত্তর পড়া গেল না — DONE নয়।' }
  const obj = parsed.value as { done?: unknown; reason?: unknown }
  const done = obj.done === true || obj.done === 'true'
  const reason = typeof obj.reason === 'string' && obj.reason.trim()
    ? obj.reason.trim()
    : (done ? 'লক্ষ্য পূর্ণ হয়েছে।' : 'লক্ষ্য এখনো পূর্ণ হয়নি।')
  return { done, reason }
}
