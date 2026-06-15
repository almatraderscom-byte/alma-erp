/**
 * Auto-Fix Dispatch — Cursor SDK cloud agent integration.
 *
 * Spawns a Cursor cloud agent to investigate and fix production issues.
 * The agent runs in Cursor's infrastructure, clones the repo, and creates a PR.
 *
 * Flow: error detected → owner approves → cloud agent dispatched → PR created → owner merges
 */
import { createClient } from '@supabase/supabase-js'

const CURSOR_API_KEY = process.env.CURSOR_API_KEY ?? ''
const GITHUB_REPO = process.env.AUTOFIX_GITHUB_REPO ?? 'almatraderscom-byte/alma-erp'
const GITHUB_BRANCH = process.env.AUTOFIX_GITHUB_BRANCH ?? 'main'
const APP_URL = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''
const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID ?? ''
const BOT_TOKEN = process.env.ASSISTANT_BOT_TOKEN ?? ''

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
}

/**
 * Dispatches a Cursor cloud agent to fix an issue.
 * Returns the agent run result or error info.
 */
export async function dispatchAutoFix({ actionId, issue }) {
  if (!CURSOR_API_KEY) {
    console.error('[auto-fix] CURSOR_API_KEY not configured')
    return { ok: false, error: 'CURSOR_API_KEY not configured' }
  }

  const supabase = sb()

  await supabase.from('agent_pending_actions').update({
    status: 'in_progress',
    payload: { ...issue, stage: 'agent_spawning' },
  }).eq('id', actionId)

  await notifyOwner(`🤖 Auto-Fix শুরু হচ্ছে...\n\n📋 ${issue.title}\n📁 ${issue.area}\n\nCursor Cloud Agent spawn হচ্ছে...`)

  let Agent
  try {
    const sdk = await import('@cursor/sdk')
    Agent = sdk.Agent
  } catch (err) {
    const msg = `@cursor/sdk load failed: ${err.message}`
    console.error('[auto-fix]', msg)
    await updateAction(supabase, actionId, 'failed', { error: msg })
    await notifyOwner(`❌ Auto-Fix ব্যর্থ: SDK load error\n${msg}`)
    return { ok: false, error: msg }
  }

  const prompt = buildFixPrompt(issue)

  try {
    const result = await Agent.prompt(prompt, {
      apiKey: CURSOR_API_KEY,
      model: { id: 'composer-2.5' },
      cloud: {
        repos: [{ owner: GITHUB_REPO.split('/')[0], name: GITHUB_REPO.split('/')[1] }],
        branch: GITHUB_BRANCH,
        autoCreatePR: true,
      },
    })

    if (result.status === 'finished') {
      await updateAction(supabase, actionId, 'completed', {
        agentId: result.id,
        status: result.status,
        result: result.result?.slice(0, 500),
      })
      await notifyOwner(
        `✅ Auto-Fix সম্পন্ন!\n\n📋 ${issue.title}\n🤖 Agent: ${result.id}\n\n` +
        `GitHub এ PR তৈরি হয়েছে — review করে merge করুন।\n` +
        `${result.result?.slice(0, 200) ?? ''}`
      )
      return { ok: true, agentId: result.id, status: result.status }
    } else {
      await updateAction(supabase, actionId, 'failed', {
        agentId: result.id,
        status: result.status,
        result: result.result?.slice(0, 500),
      })
      await notifyOwner(
        `⚠️ Auto-Fix সমস্যা হয়েছে\n\n📋 ${issue.title}\nStatus: ${result.status}\n` +
        `${result.result?.slice(0, 200) ?? 'No details'}`
      )
      return { ok: false, agentId: result.id, status: result.status }
    }
  } catch (err) {
    const msg = err.message?.slice(0, 300) ?? 'Unknown error'
    console.error('[auto-fix] Agent.prompt failed:', msg)
    await updateAction(supabase, actionId, 'failed', { error: msg })
    await notifyOwner(`❌ Auto-Fix ব্যর্থ\n\n📋 ${issue.title}\n\n${msg}`)
    return { ok: false, error: msg }
  }
}

function buildFixPrompt(issue) {
  return `You are an expert developer fixing a production issue in the ALMA ERP system (Next.js 14 + Supabase + Vercel).

## Issue Details
- **Title**: ${issue.title}
- **Area**: ${issue.area}
- **Severity**: ${issue.severity}
- **Detail**: ${issue.detail}
- **Signal**: ${issue.signal ?? 'N/A'}
${issue.errorLog ? `\n## Error Log\n\`\`\`\n${issue.errorLog.slice(0, 2000)}\n\`\`\`\n` : ''}
${issue.affectedFiles ? `\n## Likely Affected Files\n${issue.affectedFiles.join('\n')}\n` : ''}

## Instructions
1. First investigate the root cause. Read the relevant files carefully.
2. Make the MINIMUM changes needed to fix this specific issue.
3. Do NOT refactor unrelated code.
4. Do NOT change database schema.
5. Verify the fix compiles (\`npx tsc --noEmit\`).
6. Write a clear commit message explaining the fix.

## Project Context
- This is a live production ERP + AI agent system
- Currency: BDT, timezone: Asia/Dhaka
- Agent code: src/agent/, worker code: worker/src/
- Do NOT touch financial/payroll code unless the issue is directly there
- The owner is non-technical — commit messages should be clear

Fix this issue with a focused, safe change.`
}

async function updateAction(supabase, actionId, status, result) {
  await supabase.from('agent_pending_actions').update({
    status,
    resolved_at: new Date().toISOString(),
    result,
  }).eq('id', actionId)
}

async function notifyOwner(text) {
  if (!OWNER_CHAT_ID || !BOT_TOKEN) return
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: OWNER_CHAT_ID, text }),
    })
  } catch (err) {
    console.warn('[auto-fix] telegram notify failed:', err.message)
  }
}

/**
 * Creates a pending auto-fix action and sends approval request to owner.
 */
export async function requestAutoFix(issue) {
  const supabase = sb()
  const id = crypto.randomUUID()

  const costEstimate = estimateCost(issue)
  const preview = issue.detail?.length > 100 ? issue.detail.slice(0, 100) + '…' : (issue.detail ?? '')

  await supabase.from('agent_pending_actions').insert({
    id,
    type: 'auto_fix',
    payload: { ...issue, costEstimate },
    summary: `🔧 Auto-Fix: ${issue.title}\n${preview}\n💰 আনুমানিক খরচ: $${costEstimate.toFixed(2)}`,
    status: 'pending',
    business_id: issue.businessId ?? 'ALMA_LIFESTYLE',
    cost_estimate: costEstimate,
  })

  if (OWNER_CHAT_ID && BOT_TOKEN) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: OWNER_CHAT_ID,
        text: `🔧 Auto-Fix Request\n\n📋 ${issue.title}\n📁 ${issue.area} · ${issue.severity}\n📝 ${preview}\n\n💰 আনুমানিক খরচ: $${costEstimate.toFixed(2)}\n\n✅ Approve করলে Cursor Cloud Agent fix শুরু করবে\n❌ বাতিল করলে কিছু হবে না`,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Fix করো', callback_data: `autofix_approve:${id}` },
            { text: '❌ বাদ দাও', callback_data: `autofix_reject:${id}` },
          ]],
        },
      }),
    })
  }

  return { actionId: id, costEstimate }
}

function estimateCost(issue) {
  const base = 0.10
  const severityMultiplier = issue.severity === 'high' ? 3 : issue.severity === 'medium' ? 2 : 1
  const complexityMultiplier = (issue.affectedFiles?.length ?? 1) > 3 ? 2.5 : 1.5
  return Math.round(base * severityMultiplier * complexityMultiplier * 100) / 100
}
