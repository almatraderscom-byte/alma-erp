import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const source = (path: string) => readFileSync(join(root, path), 'utf8')

describe('Creative Studio paid-run production boundary', () => {
  it('requires estimate then exact confirmation before any job constructor', () => {
    const route = source('src/app/api/assistant/creative-studio/run/route.ts')
    const confirmationIndex = route.indexOf(
      'const claims = assertStudioRunConfirmation({',
    )
    const executionIndex = route.indexOf(
      'await executeStudioRunConfirmation({',
    )
    const constructorIndex = route.indexOf(
      'createJobs: () => withStudioRunExecutionContext({',
    )

    expect(route).toContain("body.intent !== 'estimate' && body.intent !== 'confirm'")
    expect(route).toContain('assertStudioRunConfirmation({')
    expect(route).toContain('confirmation: body.confirmed')
    expect(route).toContain('maxCostBdt: body.maxCostBdt')
    expect(route).toContain('assertStudioSpendAllowed(')
    expect(confirmationIndex).toBeGreaterThan(0)
    expect(executionIndex).toBeGreaterThan(confirmationIndex)
    expect(constructorIndex).toBeGreaterThan(executionIndex)
  })

  it('marks every /run job V3 and gates approved insertion before the write', () => {
    const context = source('src/lib/creative-studio/studio-run-context.ts')
    const createRun = source('src/lib/creative-studio/create-run.ts')
    const gateIndex = createRun.indexOf('await assertStudioRunExecutionGate({')
    const approvedInsertIndex = createRun.indexOf('creativeStudioImageQueueStatus(authorized.payload)', gateIndex)

    expect(context).toContain("studioSurface: 'v3'")
    expect(context).toContain('signStudioRunJobPayload')
    expect(createRun).toContain('studioRunAuthorizedJobFields')
    expect(createRun).toContain("from '@/lib/creative-studio/preview-worker-scope'")
    expect(gateIndex).toBeGreaterThan(0)
    expect(approvedInsertIndex).toBeGreaterThan(gateIndex)
  })

  it('makes the app authoritative for signed, unsigned, direct V3 and retry jobs', () => {
    const workerGate = source('worker/src/studio-run-authorize.mjs')
    const serverGate = source(
      'src/app/api/assistant/internal/studio-run-authorize/route.ts',
    )
    const authorization = source(
      'src/lib/creative-studio/studio-run-authorization.ts',
    )
    const imageWorker = source('worker/src/index.mjs')
    const videoWorker = source('worker/src/video-gen.mjs')

    expect(workerGate).toContain("payload?.studioSurface === 'v3'")
    expect(workerGate).toContain("kind: 'unsigned_candidate'")
    expect(workerGate).toContain(
      '/api/assistant/internal/studio-run-authorize',
    )
    expect(workerGate).not.toContain("classification.kind === 'legacy'")
    expect(serverGate).toContain('createdAt: true')
    expect(serverGate).toContain('assertUnsignedStudioJobCompatibility({')
    expect(serverGate).toContain('studio_run_authorization_required')
    expect(authorization).toContain(
      'STUDIO_UNSIGNED_PAID_JOB_CUTOFF_ISO',
    )
    expect(authorization).toContain(
      'unsigned_generation_authorization_required',
    )
    expect(imageWorker).toContain(
      "const authorization = await authorizeStudioRunExecution(pendingActionId, payload)",
    )
    expect(videoWorker).toContain(
      "const authorization = await authorizeStudioRunExecution(pendingActionId, payload)",
    )
    expect(imageWorker).not.toMatch(
      /if \(payload\.studioRunAuthorization\) \{\s*const \{ authorizeStudioRunExecution/,
    )
    expect(videoWorker).not.toMatch(
      /if \(payload\.studioRunAuthorization\) \{\s*const \{ authorizeStudioRunExecution/,
    )
    expect(videoWorker).toContain('payload: { ...payload, _veoOperation:')
  })

  it('uses one V3 BullMQ attempt and revalidates immediately before every paid retry', () => {
    const workerGate = source('worker/src/studio-run-authorize.mjs')
    const imageWorker = source('worker/src/index.mjs')
    const videoWorker = source('worker/src/video-gen.mjs')
    const xai = source('worker/src/xai/adapter.mjs')
    const fashn = source('worker/src/fashn/process.mjs')
    const falFashn = source('worker/src/fal/adapters/fashn-v16.mjs')
    const catVton = source('worker/src/fal/adapters/cat-vton.mjs')
    const flux = source('worker/src/fal/adapters/flux-fill.mjs')

    expect(workerGate).toContain('? { attempts: 1 }')
    expect(imageWorker).toContain(
      '{ jobId: job.id, ...studioRunQueueJobOptions(job.payload) }',
    )
    expect(imageWorker).toContain(
      'await assertStudioRunPaidAttempt(pendingActionId, payload, 1)',
    )
    expect(imageWorker).toContain(
      'await assertStudioRunPaidAttempt(pendingActionId, payload, attemptNum)',
    )
    expect(videoWorker.indexOf(
      'await assertStudioRunPaidAttempt(pendingActionId, payload, attempt)',
    )).toBeLessThan(videoWorker.indexOf(
      'operation = await genai.models.generateVideos',
    ))
    for (const adapter of [xai, fashn, falFashn, catVton, flux]) {
      expect(adapter).toContain('await assertStudioRunPaidAttempt(')
    }
    expect(xai).toContain('studioRunProviderMaxAttempts(payload, 3)')
  })

  it('recovers partial confirmation creation through stable receipt/job dedupe', () => {
    const route = source('src/app/api/assistant/creative-studio/run/route.ts')
    const confirmation = source(
      'src/lib/creative-studio/studio-run-confirmation.ts',
    )
    const createRun = source('src/lib/creative-studio/create-run.ts')
    const batch = source('src/lib/tryon/tryon-batch.ts')

    expect(confirmation).toContain(
      "if (confirmation?.status === 'queued')",
    )
    expect(confirmation).toContain('studioConfirmationJobsById(')
    expect(confirmation).toContain('confirmation.jobIds')
    expect(confirmation).toContain(
      'replay.length !== confirmation.jobIds.length',
    )
    expect(route).toContain('receipt/job index')
    expect(confirmation).toContain(
      'const result = await input.createJobs()',
    )
    expect(confirmation).toContain(
      'await completeStudioRunConfirmation(',
    )
    expect(createRun).toContain(
      'studio_run_initial_dedupe_mismatch',
    )
    expect(createRun).toContain(
      'studioRunAuthorization: _priorAuthorization',
    )
    expect(createRun).toContain(
      'dedupePrefix: `studio-run:${execution.claims.receiptId}:gemini`',
    )
    expect(batch).toContain('studio_run_initial_dedupe_required')
    expect(batch).toContain('agentPendingAction.upsert')
  })

  it('persists queued and terminal artifacts into the signed project without relying on the browser', () => {
    const route = source('src/app/api/assistant/creative-studio/run/route.ts')
    const jobResult = source('src/app/api/assistant/internal/job-result/route.ts')
    const projectService = source('src/lib/creative-studio/project-service.ts')

    expect(route).toContain('await bindQueuedJobsToProject({')
    expect(route).toContain('ownerId: scoped.scope.ownerId')
    expect(jobResult).toContain('await reconcileStudioResultProjectAsset(pendingActionId)')
    expect(jobResult).toContain("error: 'studio_project_asset_reconcile_failed'")
    expect(projectService).toContain('export async function reconcileStudioResultProjectAsset(')
    expect(projectService).toContain("throw new ContentOsServiceError('studio_result_project_scope_missing', 409)")
  })

  it('hydrates the latest Agent rollback identity from Foundation history', () => {
    const service = source('src/lib/creative-studio/composition-service.ts')
    const port = source(
      'src/lib/creative-studio/editor-agent/foundation-port.ts',
    )
    const editor = source(
      'src/agent/components/creative-studio/editor/CreativeProjectEditor.tsx',
    )

    expect(service).toContain("startsWith('editor-agent-apply-')")
    expect(service).toContain('latestAgentBatchId')
    expect(service).toContain('canRollbackLatestAgentBatch')
    expect(port).toContain('view.history.latestAgentBatchId')
    expect(editor).not.toContain('setLastAgentBatchId')
    expect(editor).toContain('snapshot.latestAgentBatchId')
  })

  it('uses whole-taka money and never a decimal BDT normalization', () => {
    const authorization = source('src/lib/creative-studio/studio-run-authorization.ts')
    const plan = source('src/lib/creative-studio/studio-run-plan.ts')
    const policy = source('src/lib/creative-studio/studio-policy.ts')

    expect(authorization).toContain('roundMoney(input.estimateBdt)')
    expect(authorization).toContain('Number.isSafeInteger(claims.estimateBdt)')
    expect(plan).toContain('roundMoney(Math.max(0, usd) * STUDIO_RUN_USD_TO_BDT)')
    expect(policy).toContain('roundMoney(parsed)')
    expect(`${authorization}\n${plan}`).not.toMatch(/\*\s*100\)\s*\/\s*100/)
  })

  it('pins explicit providers and limits server-side resolution to Auto', () => {
    const plan = source('src/lib/creative-studio/studio-run-plan.ts')
    const createRun = source('src/lib/creative-studio/create-run.ts')

    expect(plan).toContain('explicit_engine_unavailable')
    expect(plan).toContain('explicit_engine_mode_unsupported')
    expect(plan).toContain('explicit_provider_model_mismatch')
    expect(plan).toContain("architecture: 'auto'")
    expect(createRun).toContain('pinnedGenericImageModel')
    expect(createRun).toContain('pinnedChainVtonEngine')
  })
})
