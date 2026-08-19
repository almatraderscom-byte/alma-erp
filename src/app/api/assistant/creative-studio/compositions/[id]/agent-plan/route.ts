import type { NextRequest } from 'next/server'
import { z } from 'zod'
import {
  authorizeCompositionRoute,
  compositionRouteError,
  compositionRouteJson,
} from '@/lib/creative-studio/composition-route'
import { getCreativeComposition } from '@/lib/creative-studio/composition-service'
import {
  compileCreativeAgentInstruction,
  compileFoundationEditorOperations,
  FoundationCompositionPortError,
  projectFoundationCompositionToEditor,
} from '@/lib/creative-studio/editor-agent'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const stableId = z.string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)

const agentPlanRequestSchema = z.object({
  brandProfileId: stableId,
  projectId: stableId,
  instruction: z.string().trim().min(2).max(4_000),
  selectedTrackId: stableId.nullable().optional(),
  selectedClipId: stableId.nullable().optional(),
  playheadSec: z.number().finite().min(0).max(86_400),
  firstBeatSec: z.number().finite().min(0).max(86_400).optional(),
}).strict()

function agentPlanError(error: unknown): Response | null {
  if (error instanceof z.ZodError) {
    return Response.json({
      error: 'invalid_agent_plan_request',
      details: {
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    }, { status: 422 })
  }
  if (error instanceof FoundationCompositionPortError) {
    return Response.json({
      error: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    }, { status: error.status >= 400 ? error.status : 422 })
  }
  return null
}

/**
 * Deterministic, zero-side-effect native Agent planning boundary.
 *
 * This route deliberately returns already-compiled Foundation operations but
 * never validates, applies, queues, renders, publishes or calls a provider.
 * The authenticated composition routes remain the only mutation authority.
 */
export async function POST(
  req: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const params = await props.params
  const actor = await authorizeCompositionRoute(req, 'plan')
  if (actor instanceof Response) return actor
  const raw = await compositionRouteJson(req)
  if (raw instanceof Response) return raw

  try {
    const input = agentPlanRequestSchema.parse(raw)
    const composition = await getCreativeComposition(
      actor,
      params.id,
      input.brandProfileId,
    )
    if (composition.projectId !== input.projectId) {
      return Response.json({ error: 'project_scope_mismatch' }, { status: 403 })
    }

    const scope = {
      brandProfileId: input.brandProfileId,
      projectId: input.projectId,
      compositionId: params.id,
    }
    const snapshot = projectFoundationCompositionToEditor(composition, scope, {
      canUndo: composition.history.canUndo,
      canRedo: composition.history.canRedo,
      latestAgentBatchId: composition.history.latestAgentBatchId,
      canRollbackLatestAgentBatch:
        composition.history.canRollbackLatestAgentBatch,
      hydration: {
        projectAssets: 'not_hydrated',
        review: 'not_hydrated',
        activity: 'not_hydrated',
        history: 'hydrated',
      },
    })
    const proposal = await compileCreativeAgentInstruction(input.instruction, {
      snapshot,
      actor: {
        userId: actor.userId,
        name: actor.name,
        role: composition.accessRole,
      },
      selectedTrackId: input.selectedTrackId ?? null,
      selectedClipId: input.selectedClipId ?? null,
      playheadSec: input.playheadSec,
      firstBeatSec: input.firstBeatSec ?? 1.2,
      generationProvider: null,
      voice: null,
    })
    const operations = proposal.operations.length
      ? compileFoundationEditorOperations(
          composition.document,
          proposal.operations,
        ).operations
      : []

    return Response.json({
      proposal,
      operations,
      executed: false,
      zeroCostOnly: true,
    })
  } catch (error) {
    return agentPlanError(error)
      ?? compositionRouteError(error, 'creative-composition-agent-plan')
  }
}
