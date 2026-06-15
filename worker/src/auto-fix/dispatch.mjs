/**
 * Auto-Fix Dispatch — Cursor SDK cloud agent integration.
 *
 * SAFETY MITIGATIONS (all 6 enforced):
 * 1. PR REVIEW MUST — Agent creates a PR, NEVER auto-merges. Owner reviews.
 * 2. VERCEL PREVIEW — PR gets a Vercel preview deployment for testing before merge.
 * 3. AUTOMATED TESTS — Agent must write/run tests for the fix.
 * 4. ROLLBACK READY — Agent creates a revert commit ready if the fix breaks production.
 * 5. CONSERVATIVE SCOPE — Agent only touches files directly related to the issue.
 * 6. SECOND AGENT REVIEW — After PR, Bugbot reviews the changes automatically.
 */
import { createClient } from '@supabase/supabase-js'

const CURSOR_API_KEY = () => process.env.CURSOR_API_KEY ?? ''
const GITHUB_REPO = process.env.AUTOFIX_GITHUB_REPO ?? 'almatraderscom-byte/alma-erp'
const GITHUB_BRANCH = process.env.AUTOFIX_GITHUB_BRANCH ?? 'main'
const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID ?? ''
const BOT_TOKEN = process.env.ASSISTANT_BOT_TOKEN ?? ''

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
}

/**
 * Dispatches a Cursor cloud agent to fix an issue.
 * The agent creates a PR — NEVER auto-merges.
 */
export async function dispatchAutoFix({ actionId, issue }) {
  const apiKey = CURSOR_API_KEY()
  if (!apiKey) {
    console.error('[auto-fix] CURSOR_API_KEY not configured')
    const supabase = sb()
    await updateAction(supabase, actionId, 'failed', { error: 'CURSOR_API_KEY not configured' })
    await notifyOwner('❌ Auto-Fix ব্যর্থ: CURSOR_API_KEY সেট করা হয়নি')
    return { ok: false, error: 'CURSOR_API_KEY not configured' }
  }

  const supabase = sb()

  await supabase.from('agent_pending_actions').update({
    status: 'in_progress',
    payload: { ...issue, stage: 'agent_spawning' },
  }).eq('id', actionId)

  await notifyOwner(
    `🤖 Auto-Fix শুরু হচ্ছে...\n\n` +
    `📋 ${issue.title}\n📁 ${issue.area}\n\n` +
    `⚡ Cursor Cloud Agent spawn হচ্ছে...\n` +
    `🔒 Safety: PR only (no auto-merge) + tests + Bugbot review`
  )

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

  const prompt = buildSafeFixPrompt(issue)
  const [repoOwner, repoName] = GITHUB_REPO.split('/')

  try {
    const result = await Agent.prompt(prompt, {
      apiKey,
      model: { id: 'composer-2.5' },
      cloud: {
        repos: [{ owner: repoOwner, name: repoName }],
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
        `✅ Auto-Fix PR তৈরি হয়েছে!\n\n` +
        `📋 ${issue.title}\n` +
        `🤖 Agent: ${result.id}\n\n` +
        `🔍 এখন করণীয়:\n` +
        `1. GitHub এ PR review করুন\n` +
        `2. Vercel Preview URL এ test করুন\n` +
        `3. Bugbot review চেক করুন\n` +
        `4. সব ঠিক থাকলে merge করুন\n\n` +
        `⚠️ সরাসরি merge হবে না — আপনার approval লাগবে`
      )
      return { ok: true, agentId: result.id, status: result.status }
    } else {
      await updateAction(supabase, actionId, 'failed', {
        agentId: result.id,
        status: result.status,
        result: result.result?.slice(0, 500),
      })
      await notifyOwner(
        `⚠️ Auto-Fix সমস্যা\n\n📋 ${issue.title}\nStatus: ${result.status}\n` +
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

/**
 * Builds the fix prompt with all 6 safety mitigations enforced.
 */
function buildSafeFixPrompt(issue) {
  return `You are an expert developer fixing a production issue in the ALMA ERP system.
This is a SAFETY-CRITICAL auto-fix — follow ALL rules strictly.

## Issue Details
- **Title**: ${issue.title}
- **Area**: ${issue.area}
- **Severity**: ${issue.severity}
- **Detail**: ${issue.detail}
- **Signal**: ${issue.signal ?? 'N/A'}
${issue.errorLog ? `\n## Error Log\n\`\`\`\n${issue.errorLog.slice(0, 2000)}\n\`\`\`\n` : ''}
${issue.affectedFiles ? `\n## Likely Affected Files\n${issue.affectedFiles.join('\n')}\n` : ''}

## STRICT SAFETY RULES (violating any = FAILURE)

### Rule 1: PR ONLY — NO AUTO-MERGE
- Create a focused pull request with a clear title and description
- Title format: "fix(auto): <brief description>"
- PR body must include: what was broken, root cause, what this fixes, risk assessment
- NEVER merge the PR yourself — the owner will review and merge

### Rule 2: VERCEL PREVIEW TESTING
- The PR will get an automatic Vercel preview deployment
- In the PR description, note: "⚠️ Test on Vercel preview URL before merging"
- If the fix involves API routes, list the endpoints to test

### Rule 3: WRITE TESTS
- For every code change, write or update at least one test
- If no test framework exists for that area, add inline assertions or a simple test file
- Test the specific bug scenario that was reported
- The PR must not break existing TypeScript compilation (\`npx tsc --noEmit\`)

### Rule 4: ROLLBACK READY
- Keep changes minimal so reverting is easy
- In the PR description, add a "Rollback Plan" section:
  - "To revert: \`git revert <commit-hash>\`"
  - Or describe manual steps if revert isn't clean
- Do NOT make changes that are hard to undo (schema migrations, data deletions)

### Rule 5: CONSERVATIVE SCOPE
- ONLY modify files directly related to this issue
- Do NOT refactor adjacent code
- Do NOT update dependencies
- Do NOT change configuration files unless the bug is there
- Do NOT touch: prisma/schema.prisma, financial/payroll code, .env files
- Maximum 3 files changed (if more needed, explain why in PR)

### Rule 6: READY FOR SECOND REVIEW
- Write clear commit messages explaining the "why"
- Add code comments for non-obvious fixes
- Structure PR description for easy Bugbot review
- Flag any risky changes explicitly in the PR body

## Project Context
- Next.js 14 (App Router) + Supabase Postgres + Vercel
- Agent code: src/agent/, worker code: worker/src/
- Currency: BDT, timezone: Asia/Dhaka
- NEVER touch financial/payroll code unless the issue is directly there
- Worker uses ESM (.mjs files)

Fix this issue following ALL safety rules above.`
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
    summary: `🔧 Auto-Fix: ${issue.title}\n${preview}\n💰 ~$${costEstimate.toFixed(2)}`,
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
        text: `🔧 Auto-Fix Request\n\n` +
          `📋 ${issue.title}\n📁 ${issue.area} · ${issue.severity}\n📝 ${preview}\n\n` +
          `💰 আনুমানিক খরচ: $${costEstimate.toFixed(2)}\n\n` +
          `🔒 Safety:\n` +
          `• PR only — auto-merge হবে না\n` +
          `• Vercel preview test হবে\n` +
          `• Tests লেখা হবে\n` +
          `• Bugbot review হবে\n\n` +
          `✅ Approve করলে Cursor Cloud Agent fix শুরু করবে`,
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
