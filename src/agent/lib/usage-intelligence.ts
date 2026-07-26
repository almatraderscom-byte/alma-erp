import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getPeriodRangeDhaka } from '@/lib/agent-api/period'
import { queryBillableCostSumBetween } from '@/agent/lib/cost-budget'
import { getBudgetSettings } from '@/agent/lib/cost-events'
import { getApiBalances, type BalanceProviderRow } from '@/agent/lib/api-balances'
import {
  AUTO_MODEL_ID,
  MODEL_REGISTRY,
  getModel,
  isKnownModelId,
  type ModelEntry,
  type Provider,
} from '@/agent/lib/models/registry'

type ContextSource = 'provider_last_round' | 'single_round_legacy' | 'legacy_estimate' | 'awaiting_provider'

export type ContextBreakdownItem = {
  id: 'messages' | 'system' | 'tools' | 'memory' | 'runtime' | 'free'
  label: string
  tokens: number
  percentage: number
  color: string
}

export type WeeklyModelUsage = {
  modelId: string
  label: string
  costUsd: number
  percentage: number
  tokens: number
  color: string
}

export type UsageIntelligenceSnapshot = {
  checkedAt: string
  selectedModelId: string
  resolvedModelId: string | null
  model: {
    id: string | null
    label: string
    resolvedLabel: string | null
    provider: Provider | null
    contextWindow: number | null
    inPerM: number | null
    outPerM: number | null
    auto: boolean
  }
  context: {
    usedTokens: number | null
    percentage: number
    source: ContextSource
    measuredAt: string | null
    exact: boolean
    breakdownSource: 'reconciled_estimate'
    breakdown: ContextBreakdownItem[]
  }
  daily: {
    spentUsd: number
    budgetUsd: number | null
    percentage: number | null
    date: string
  }
  weekly: {
    spentUsd: number
    startDate: string
    endDate: string
    models: WeeklyModelUsage[]
  }
  wallet: {
    providerId: string | null
    providerLabel: string | null
    balanceUsd: number | null
    authoritative: boolean
    status: string
    fetchedAt: string | null
    staleAfter: string | null
    estimatedTokens: number | null
    estimatedTokenMin: number | null
    estimatedTokenMax: number | null
    estimateBasis: 'observed_7d_mix' | 'published_price_range' | 'unavailable'
    note: string
  }
}

type ModelSpendRow = {
  model_id: string
  total: string
  input_tokens: string
  output_tokens: string
  cache_tokens: string
}

const MODEL_COLORS = ['#9B8AFB', '#57C7FF', '#62D9A7', '#F6B85A', '#F07F8D', '#B5C1D8']

const PROVIDER_BALANCE_ID: Record<Provider, string> = {
  anthropic: 'anthropic',
  google: 'gemini',
  openai: 'openai',
  openrouter: 'openrouter',
  xai: 'xai',
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10))
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function jsonTokens(value: unknown): number {
  if (value == null) return 0
  try {
    return Math.max(0, Math.ceil(JSON.stringify(value).length / 4))
  } catch {
    return 0
  }
}

function numberFromUsage(usage: Record<string, unknown>, key: string): number {
  const value = usage[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

export function readContextUsage(
  usage: Record<string, unknown> | null,
  modelMatches: boolean,
): { tokens: number | null; source: ContextSource; measuredAt: string | null; exact: boolean } {
  if (!usage) {
    return { tokens: null, source: 'awaiting_provider', measuredAt: null, exact: false }
  }

  const contextTokens = numberFromUsage(usage, 'context_tokens')
  if (contextTokens > 0 && usage.context_source === 'provider_last_round') {
    return {
      tokens: contextTokens,
      source: 'provider_last_round',
      measuredAt: typeof usage.context_measured_at === 'string' ? usage.context_measured_at : null,
      // OWNER BUG 2026-07-26: switching the head mid-chat reset the context meter
      // to zero. But the conversation did not shrink — the same messages are
      // still there; only the WINDOW changed. So the measurement carries over and
      // is re-scaled against the new model's window; it is simply no longer
      // "exact", because another tokenizer produced it.
      exact: modelMatches,
    }
  }

  const legacyTokens =
    numberFromUsage(usage, 'input_tokens')
    + numberFromUsage(usage, 'cache_read_input_tokens')
    + numberFromUsage(usage, 'cache_creation_input_tokens')
  if (legacyTokens <= 0) {
    return { tokens: null, source: 'awaiting_provider', measuredAt: null, exact: false }
  }
  const rounds = numberFromUsage(usage, 'api_rounds')
  return {
    tokens: legacyTokens,
    source: rounds <= 1 ? 'single_round_legacy' : 'legacy_estimate',
    measuredAt: null,
    exact: modelMatches && rounds <= 1,
  }
}

export function buildContextBreakdown(input: {
  usedTokens: number | null
  contextWindow: number | null
  messageTokens: number
  systemTokens: number
  toolTokens: number
  memoryTokens: number
}): ContextBreakdownItem[] {
  const used = Math.max(0, input.usedTokens ?? 0)
  const limit = Math.max(0, input.contextWindow ?? 0)
  const raw = [
    { id: 'messages' as const, label: 'Messages', tokens: input.messageTokens, color: '#57C7FF' },
    { id: 'system' as const, label: 'System prompt', tokens: input.systemTokens, color: '#9B8AFB' },
    { id: 'tools' as const, label: 'Tools', tokens: input.toolTokens, color: '#62D9A7' },
    { id: 'memory' as const, label: 'Memory & summaries', tokens: input.memoryTokens, color: '#F6B85A' },
  ].map((item) => ({ ...item, tokens: Math.max(0, Math.round(item.tokens)) }))

  const rawTotal = raw.reduce((sum, item) => sum + item.tokens, 0)
  const scale = used > 0 && rawTotal > used ? used / rawTotal : 1
  const scaled = raw.map((item) => ({ ...item, tokens: Math.round(item.tokens * scale) }))
  let allocated = scaled.reduce((sum, item) => sum + item.tokens, 0)
  // Rounding the normalized category estimates can overshoot by a token or two.
  // Remove that residue deterministically so category sum always reconciles.
  let overshoot = Math.max(0, allocated - used)
  for (const item of scaled) {
    if (overshoot <= 0) break
    const deduction = Math.min(item.tokens, overshoot)
    item.tokens -= deduction
    overshoot -= deduction
  }
  allocated = scaled.reduce((sum, item) => sum + item.tokens, 0)
  const runtimeTokens = Math.max(0, used - allocated)
  const all = [
    ...scaled,
    { id: 'runtime' as const, label: 'Runtime & attachments', tokens: runtimeTokens, color: '#F07F8D' },
    { id: 'free' as const, label: 'Free space', tokens: Math.max(0, limit - used), color: '#4A5262' },
  ]
  return all.map((item) => ({
    ...item,
    percentage: limit > 0 ? clampPercentage((item.tokens / limit) * 100) : 0,
  }))
}

function selectBalanceRow(model: ModelEntry | null, rows: BalanceProviderRow[]): BalanceProviderRow | null {
  if (!model) return null
  const providerId = PROVIDER_BALANCE_ID[model.provider]
  return rows.find((row) => row.id === providerId) ?? null
}

function tokenRunway(
  model: ModelEntry | null,
  balance: number | null,
  observed: { costUsd: number; tokens: number } | null,
) {
  if (!model || balance == null || balance < 0) {
    return { estimatedTokens: null, min: null, max: null, basis: 'unavailable' as const }
  }
  if (observed && observed.costUsd > 0 && observed.tokens > 0) {
    return {
      estimatedTokens: Math.floor((balance / observed.costUsd) * observed.tokens),
      min: null,
      max: null,
      basis: 'observed_7d_mix' as const,
    }
  }
  const lowRate = Math.min(model.inPerM, model.outPerM)
  const highRate = Math.max(model.inPerM, model.outPerM)
  if (lowRate <= 0 || highRate <= 0) {
    return { estimatedTokens: null, min: null, max: null, basis: 'unavailable' as const }
  }
  return {
    estimatedTokens: null,
    min: Math.floor((balance / highRate) * 1_000_000),
    max: Math.floor((balance / lowRate) * 1_000_000),
    basis: 'published_price_range' as const,
  }
}

export async function getUsageIntelligence(input: {
  conversationId?: string | null
  requestedModelId?: string | null
}): Promise<UsageIntelligenceSnapshot> {
  const conversation = input.conversationId
    ? await prisma.agentConversation.findUnique({
        where: { id: input.conversationId },
        select: {
          id: true,
          modelId: true,
          contextSummary: true,
          tailSummary: true,
          tailCompactedCount: true,
        },
      })
    : null

  const selectedModelId =
    input.requestedModelId === AUTO_MODEL_ID || (input.requestedModelId && isKnownModelId(input.requestedModelId))
      ? input.requestedModelId
      : conversation?.modelId ?? AUTO_MODEL_ID

  const latestAssistant = conversation
    ? await prisma.agentMessage.findFirst({
        where: { conversationId: conversation.id, role: 'assistant' },
        orderBy: { createdAt: 'desc' },
        select: { usage: true, createdAt: true },
      })
    : null
  const latestUsage = latestAssistant?.usage && typeof latestAssistant.usage === 'object'
    ? latestAssistant.usage as Record<string, unknown>
    : null
  const latestModelId = typeof latestUsage?.model === 'string' && isKnownModelId(latestUsage.model)
    ? latestUsage.model
    : null
  const resolvedModelId =
    selectedModelId === AUTO_MODEL_ID
      ? latestModelId
      : isKnownModelId(selectedModelId) ? selectedModelId : null
  const model = resolvedModelId ? getModel(resolvedModelId) : null
  const contextRead = readContextUsage(latestUsage, Boolean(model && latestModelId === model.id))

  const [todayRange, weekRange] = [
    getPeriodRangeDhaka('today'),
    getPeriodRangeDhaka('week'),
  ]
  const sevenDaysAgo = new Date(todayRange.to.getTime() - 7 * 86_400_000)

  const [
    dailySpent,
    budgets,
    weeklyRows,
    observedRows,
    balances,
    recentMessages,
    latestCostEvent,
  ] = await Promise.all([
    queryBillableCostSumBetween(todayRange.from, todayRange.to),
    getBudgetSettings(),
    prisma.$queryRaw<ModelSpendRow[]>(
      Prisma.sql`SELECT
        COALESCE(units->>'model', 'unknown') AS model_id,
        COALESCE(SUM(cost_usd), 0)::text AS total,
        COALESCE(SUM(COALESCE(NULLIF(units->>'input_tokens', '')::numeric, 0)), 0)::text AS input_tokens,
        COALESCE(SUM(COALESCE(NULLIF(units->>'output_tokens', '')::numeric, 0)), 0)::text AS output_tokens,
        COALESCE(SUM(
          COALESCE(NULLIF(units->>'cache_read_input_tokens', '')::numeric, 0)
          + COALESCE(NULLIF(units->>'cache_creation_input_tokens', '')::numeric, 0)
        ), 0)::text AS cache_tokens
      FROM agent_cost_events
      WHERE kind = 'chat' AND occurred_at >= ${weekRange.from} AND occurred_at < ${weekRange.to}
      GROUP BY 1
      ORDER BY SUM(cost_usd) DESC`,
    ),
    model
      ? prisma.$queryRaw<ModelSpendRow[]>(
          Prisma.sql`SELECT
            ${model.id}::text AS model_id,
            COALESCE(SUM(cost_usd), 0)::text AS total,
            COALESCE(SUM(COALESCE(NULLIF(units->>'input_tokens', '')::numeric, 0)), 0)::text AS input_tokens,
            COALESCE(SUM(COALESCE(NULLIF(units->>'output_tokens', '')::numeric, 0)), 0)::text AS output_tokens,
            COALESCE(SUM(
              COALESCE(NULLIF(units->>'cache_read_input_tokens', '')::numeric, 0)
              + COALESCE(NULLIF(units->>'cache_creation_input_tokens', '')::numeric, 0)
            ), 0)::text AS cache_tokens
          FROM agent_cost_events
          WHERE kind = 'chat'
            AND units->>'model' = ${model.id}
            AND occurred_at >= ${sevenDaysAgo} AND occurred_at < ${todayRange.to}`,
        )
      : Promise.resolve([] as ModelSpendRow[]),
    getApiBalances(),
    conversation
      ? prisma.agentMessage.findMany({
          where: { conversationId: conversation.id },
          orderBy: { createdAt: 'desc' },
          take: 80,
          select: { content: true },
        })
      : Promise.resolve([]),
    conversation
      ? prisma.agentCostEvent.findFirst({
          where: { conversationId: conversation.id, kind: 'chat' },
          orderBy: { occurredAt: 'desc' },
          select: { units: true },
        })
      : Promise.resolve(null),
  ])

  const weeklyTotal = weeklyRows.reduce((sum, row) => sum + (parseFloat(row.total) || 0), 0)
  const weeklyModels = weeklyRows.map((row, index) => {
    const registryModel = MODEL_REGISTRY.find((entry) => entry.id === row.model_id)
    const tokens =
      (parseFloat(row.input_tokens) || 0)
      + (parseFloat(row.output_tokens) || 0)
      + (parseFloat(row.cache_tokens) || 0)
    return {
      modelId: row.model_id,
      label: registryModel?.label ?? (row.model_id === 'unknown' ? 'Other' : row.model_id),
      costUsd: roundUsd(parseFloat(row.total) || 0),
      percentage: weeklyTotal > 0 ? clampPercentage(((parseFloat(row.total) || 0) / weeklyTotal) * 100) : 0,
      tokens: Math.round(tokens),
      color: MODEL_COLORS[index % MODEL_COLORS.length],
    }
  })

  const costUnits = latestCostEvent?.units && typeof latestCostEvent.units === 'object'
    ? latestCostEvent.units as Record<string, unknown>
    : {}
  const prefixChars = numberFromUsage(costUnits, 'prefix_system_chars')
  const toolCount = numberFromUsage(costUnits, 'prefix_tool_count')
  const messageTokens = recentMessages.reduce((sum, row) => sum + jsonTokens(row.content), 0)
  const memoryTokens = jsonTokens(conversation?.contextSummary) + jsonTokens(conversation?.tailSummary)
  const breakdown = buildContextBreakdown({
    usedTokens: contextRead.tokens,
    contextWindow: model?.contextWindow ?? null,
    messageTokens,
    systemTokens: Math.ceil(prefixChars / 4),
    toolTokens: toolCount * 180,
    memoryTokens,
  })

  const balanceRow = selectBalanceRow(model, balances.providers)
  const walletBalance =
    balanceRow?.balanceKind === 'wallet' && balanceRow.balanceCurrency === 'USD'
      ? balanceRow.balanceUsd
      : null
  const observedRow = observedRows[0]
  const observedTokens = observedRow
    ? (parseFloat(observedRow.input_tokens) || 0)
      + (parseFloat(observedRow.output_tokens) || 0)
      + (parseFloat(observedRow.cache_tokens) || 0)
    : 0
  const runway = tokenRunway(
    model,
    walletBalance,
    observedRow ? { costUsd: parseFloat(observedRow.total) || 0, tokens: observedTokens } : null,
  )

  const dailyBudget = budgets.dailyUsd != null && budgets.dailyUsd > 0 ? budgets.dailyUsd : null
  const contextLimit = model?.contextWindow ?? 0
  const contextPercentage =
    contextRead.tokens != null && contextLimit > 0
      ? clampPercentage((contextRead.tokens / contextLimit) * 100)
      : 0

  const walletNote = !model
    ? 'Auto will resolve after the first provider turn.'
    : !balanceRow
      ? 'No provider billing row is connected.'
      : walletBalance == null
        ? 'This provider does not expose a live prepaid USD wallet.'
        : runway.basis === 'observed_7d_mix'
          ? 'Token runway uses this model’s observed 7-day input/output mix.'
          : 'Token runway is a range from the model’s published input/output prices.'

  return {
    checkedAt: new Date().toISOString(),
    selectedModelId,
    resolvedModelId,
    model: {
      id: model?.id ?? null,
      label: selectedModelId === AUTO_MODEL_ID ? 'Auto · Dynamic routing' : model?.label ?? selectedModelId,
      resolvedLabel: model?.label ?? null,
      provider: model?.provider ?? null,
      contextWindow: model?.contextWindow ?? null,
      inPerM: model?.inPerM ?? null,
      outPerM: model?.outPerM ?? null,
      auto: selectedModelId === AUTO_MODEL_ID,
    },
    context: {
      usedTokens: contextRead.tokens,
      percentage: contextPercentage,
      source: contextRead.source,
      measuredAt: contextRead.measuredAt ?? latestAssistant?.createdAt.toISOString() ?? null,
      exact: contextRead.exact,
      breakdownSource: 'reconciled_estimate',
      breakdown,
    },
    daily: {
      spentUsd: roundUsd(dailySpent),
      budgetUsd: dailyBudget,
      percentage: dailyBudget ? clampPercentage((dailySpent / dailyBudget) * 100) : null,
      date: todayRange.startDate,
    },
    weekly: {
      spentUsd: roundUsd(weeklyTotal),
      startDate: weekRange.startDate,
      endDate: weekRange.endDate,
      models: weeklyModels,
    },
    wallet: {
      providerId: balanceRow?.id ?? null,
      providerLabel: balanceRow?.label ?? null,
      balanceUsd: walletBalance,
      authoritative: Boolean(balanceRow?.balanceAuthoritative && walletBalance != null),
      status: balanceRow?.status ?? 'unavailable',
      fetchedAt: balanceRow?.fetchedAt ?? null,
      staleAfter: balanceRow?.staleAfter ?? null,
      estimatedTokens: runway.estimatedTokens,
      estimatedTokenMin: runway.min,
      estimatedTokenMax: runway.max,
      estimateBasis: runway.basis,
      note: walletNote,
    },
  }
}
