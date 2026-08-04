import { describe, expect, it } from 'vitest'
import {
  createCreativeStudioV3CompositionClient,
  CreativeStudioV3CompositionError,
  resolveStudioProjectComposition,
} from '@/agent/components/creative-studio-v3/composition-client'
import { projectToReadonlyComposition } from '@/lib/creative-studio/composition-projection'
import type {
  CreativeCompositionSummary,
  CreativeCompositionView,
} from '@/lib/creative-studio/composition-service'
import type { StudioAccessRole } from '@/lib/creative-studio/studio-access'

const scope = {
  brandProfileId: 'brand-a',
  projectId: 'project-a',
}

function composition(
  role: StudioAccessRole = 'owner',
  id = 'composition-a',
): CreativeCompositionView {
  const projected = projectToReadonlyComposition({
    compositionId: id,
    projectId: scope.projectId,
    ownerId: 'owner-a',
    brandProfileId: scope.brandProfileId,
    name: 'Access-scoped project',
    defaultFolder: 'Campaign',
    product: null,
    recipe: null,
    assets: [],
    readonly: false,
  })
  return {
    id,
    ownerId: 'owner-a',
    brandProfileId: scope.brandProfileId,
    projectId: scope.projectId,
    title: 'Access-scoped composition',
    sourceKind: 'project_projection',
    schemaVersion: 1,
    currentVersion: 1,
    concurrencyToken: projected.concurrencyToken,
    readonly: false,
    createdById: 'actor-a',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    document: projected.document,
    documentHash: projected.documentHash,
    accessRole: role,
    history: {
      canUndo: false,
      canRedo: false,
      undoDepth: 0,
      redoDepth: 0,
      currentUndoBatchId: null,
      currentRedoBatchId: null,
      latestAgentBatchId: null,
      canRollbackLatestAgentBatch: false,
      rollbackPoints: [],
      activity: [],
    },
  }
}

function summary(view: CreativeCompositionView): CreativeCompositionSummary {
  const {
    document: _document,
    documentHash: _hash,
    accessRole: _role,
    history: _history,
    ...row
  } = view
  return row
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

describe('Creative Studio V3 access-scoped composition client', () => {
  it.each<StudioAccessRole>(['owner', 'creator', 'reviewer'])(
    'discovers and opens an existing %s composition without caller authority',
    async (role) => {
      const view = composition(role)
      const requests: Array<{
        method: string
        pathname: string
        search: string
        body: Record<string, unknown> | null
      }> = []
      const client = createCreativeStudioV3CompositionClient(async (input, init = {}) => {
        const url = new URL(String(input), 'http://local')
        const method = init.method ?? 'GET'
        const body = typeof init.body === 'string'
          ? JSON.parse(init.body) as Record<string, unknown>
          : null
        requests.push({
          method,
          pathname: url.pathname,
          search: url.search,
          body,
        })
        if (url.pathname.endsWith(`/${view.id}`)) {
          return json({ composition: view })
        }
        return json({ compositions: [summary(view)] })
      })

      const resolved = await resolveStudioProjectComposition({
        actorUserId: `actor-${role}`,
        allowCreate: role !== 'reviewer',
        client,
        projectName: 'Access-scoped project',
        ...scope,
      })

      expect(resolved).toMatchObject({
        source: 'existing',
        composition: {
          id: view.id,
          accessRole: role,
          ...scope,
        },
      })
      expect(requests.map((request) => request.method)).toEqual(['GET', 'GET'])
      expect(requests[0].search).toContain('brandProfileId=brand-a')
      expect(requests[0].search).toContain('projectId=project-a')
      expect(requests.every((request) =>
        request.body === null
        || (!('actor' in request.body) && !('role' in request.body)))).toBe(true)
    },
  )

  it('creates with one deterministic idempotency key and recovers a lost response by re-listing', async () => {
    const view = composition('creator')
    let stored = false
    let postCount = 0
    const keys: string[] = []
    const client = createCreativeStudioV3CompositionClient(async (input, init = {}) => {
      const url = new URL(String(input), 'http://local')
      const method = init.method ?? 'GET'
      if (method === 'POST') {
        postCount += 1
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        keys.push(String(body.idempotencyKey))
        stored = true
        throw new Error('response lost')
      }
      if (url.pathname.endsWith(`/${view.id}`)) {
        return json({ composition: view })
      }
      return json({ compositions: stored ? [summary(view)] : [] })
    })

    const resolved = await resolveStudioProjectComposition({
      actorUserId: 'creator-a',
      allowCreate: true,
      client,
      projectName: 'Access-scoped project',
      ...scope,
    })

    expect(resolved.source).toBe('recovered')
    expect(resolved.composition.id).toBe(view.id)
    expect(postCount).toBe(1)
    expect(keys[0]).toMatch(/^cs-v3-open:[a-f0-9]{64}$/)
    expect(resolved.idempotencyKey).toBe(keys[0])
  })

  it('uses the same creation key across safe retries', async () => {
    const keys: string[] = []
    const run = async () => {
      const view = composition('owner')
      const client = createCreativeStudioV3CompositionClient(async (_input, init = {}) => {
        if (init.method === 'POST') {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>
          keys.push(String(body.idempotencyKey))
          return json({ composition: view, idempotent: keys.length > 1 }, 201)
        }
        return json({ compositions: [] })
      })
      return resolveStudioProjectComposition({
        actorUserId: 'owner-a',
        allowCreate: true,
        client,
        projectName: 'Access-scoped project',
        ...scope,
      })
    }

    await run()
    await run()
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
  })

  it('sends the selected project canvas and binds it into the deterministic creation key', async () => {
    const view = composition('owner')
    const posts: Array<Record<string, unknown>> = []
    const client = createCreativeStudioV3CompositionClient(async (_input, init = {}) => {
      if (init.method === 'POST') {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return json({ composition: view, idempotent: false }, 201)
      }
      return json({ compositions: [] })
    })

    const base = {
      actorUserId: 'owner-a',
      allowCreate: true,
      client,
      projectName: 'Access-scoped project',
      ...scope,
    }
    await resolveStudioProjectComposition({
      ...base,
      canvas: {
        width: 1080,
        height: 1920,
        aspectWidth: 9,
        aspectHeight: 16,
      },
    })
    await resolveStudioProjectComposition({
      ...base,
      canvas: {
        width: 1080,
        height: 1350,
        aspectWidth: 4,
        aspectHeight: 5,
      },
    })

    expect(posts).toHaveLength(2)
    expect(posts[0]?.canvas).toEqual({
      width: 1080,
      height: 1920,
      aspectWidth: 9,
      aspectHeight: 16,
    })
    expect(posts[0]?.idempotencyKey).not.toBe(posts[1]?.idempotencyKey)
  })

  it('never attempts creation for a reviewer with no canonical composition', async () => {
    let posts = 0
    const client = createCreativeStudioV3CompositionClient(async (_input, init = {}) => {
      if (init.method === 'POST') posts += 1
      return json({ compositions: [] })
    })

    await expect(resolveStudioProjectComposition({
      actorUserId: 'reviewer-a',
      allowCreate: false,
      client,
      projectName: 'Access-scoped project',
      ...scope,
    })).rejects.toMatchObject({
      code: 'composition_creation_unavailable',
      status: 409,
    })
    expect(posts).toBe(0)
  })

  it('recovers a stale list row by re-listing before opening', async () => {
    const stale = composition('owner', 'composition-stale')
    const current = composition('owner', 'composition-current')
    let lists = 0
    const client = createCreativeStudioV3CompositionClient(async (input) => {
      const url = new URL(String(input), 'http://local')
      if (url.pathname.endsWith(`/${stale.id}`)) {
        return json({ error: 'composition_not_found' }, 404)
      }
      if (url.pathname.endsWith(`/${current.id}`)) {
        return json({ composition: current })
      }
      lists += 1
      return json({
        compositions: [summary(lists === 1 ? stale : current)],
      })
    })

    const resolved = await resolveStudioProjectComposition({
      actorUserId: 'owner-a',
      allowCreate: true,
      client,
      projectName: 'Access-scoped project',
      ...scope,
    })
    expect(resolved.source).toBe('recovered')
    expect(resolved.composition.id).toBe(current.id)
    expect(lists).toBe(2)
  })

  it('surfaces offline and cross-scope responses without falling back to fixtures', async () => {
    const offline = createCreativeStudioV3CompositionClient(async () => {
      throw new Error('offline')
    })
    await expect(offline.listCompositions(scope)).rejects.toEqual(
      expect.objectContaining({
        code: 'network_unavailable',
        status: 0,
      }),
    )

    const crossed = composition('owner')
    crossed.brandProfileId = 'brand-secret'
    crossed.document.project.brandProfileId = 'brand-secret'
    const invalid = createCreativeStudioV3CompositionClient(async () =>
      json({ compositions: [summary(crossed)] }))
    await expect(invalid.listCompositions(scope)).rejects.toBeInstanceOf(
      CreativeStudioV3CompositionError,
    )
  })

  it('normalizes malformed Foundation views into the focused client error contract', async () => {
    const client = createCreativeStudioV3CompositionClient(async () =>
      json({ composition: { id: 'composition-a' } }))

    await expect(client.getComposition({
      ...scope,
      compositionId: 'composition-a',
    })).rejects.toMatchObject({
      code: 'invalid_foundation_response',
      status: 502,
    })
  })
})
