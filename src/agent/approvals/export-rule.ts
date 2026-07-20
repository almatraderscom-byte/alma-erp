/**
 * Data export approval rules (G12 / SPEC-116).
 *
 * Moving data OUT of the system — bulk exports, downloads, shares to an external
 * destination — is a leak risk, so it is approval-gated by default. An export is
 * autonomous only when its destination is internal AND its scope (row count) is
 * known and at/below the owner's autonomous ceiling AND it is not marked
 * sensitive. Anything else — external destination, sensitive data, unknown scope,
 * or over the ceiling — requires approval. Non-export actions abstain.
 *
 * Deterministic, pure (INV-01). Fail-closed (INV-05): unknown scope/destination
 * asks before any data leaves.
 */
import { z } from 'zod';
import type { ApprovalRule, ApprovalVerdict, AutonomyInput } from '../autonomy/states';

export const EXPORT_REASON_CODES = {
  EXTERNAL_DESTINATION: 'EXPORT_EXTERNAL_DESTINATION',
  SENSITIVE_DATA: 'EXPORT_SENSITIVE_DATA',
  SCOPE_UNKNOWN: 'EXPORT_SCOPE_UNKNOWN',
  OVER_ROW_CEILING: 'EXPORT_OVER_ROW_CEILING',
  INTERNAL_SMALL_OK: 'EXPORT_INTERNAL_SMALL_OK',
} as const;

export interface ExportRuleConfig {
  autonomousRowCeiling: number;
  exportResourceTypes?: string[];
  exportActionPrefixes?: string[];
  internalDestinations?: string[];
}

const DEFAULT_TYPES = ['export', 'report', 'dump', 'backup'];
const DEFAULT_PREFIXES = ['export.', 'download.', 'share.', 'report.export', 'data.export'];
const DEFAULT_INTERNAL_DEST = ['internal', 'self', 'owner', 'same-tenant'];

const configSchema = z.object({
  autonomousRowCeiling: z.number().int().nonnegative(),
  exportResourceTypes: z.array(z.string().min(1)).optional(),
  exportActionPrefixes: z.array(z.string().min(1)).optional(),
  internalDestinations: z.array(z.string().min(1)).optional(),
});

/** Strict non-negative integer row count, or null. */
export function readRowCount(attributes: Record<string, unknown> | undefined): number | null {
  const raw = attributes?.rowCount;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return null;
  return raw;
}

export class ExportApprovalRule implements ApprovalRule {
  readonly name = 'export';
  private readonly ceiling: number;
  private readonly types: string[];
  private readonly prefixes: string[];
  private readonly internalDest: string[];

  constructor(config: ExportRuleConfig) {
    if (!configSchema.safeParse(config).success) throw new Error('invalid ExportRuleConfig');
    this.ceiling = config.autonomousRowCeiling;
    this.types = config.exportResourceTypes ?? DEFAULT_TYPES;
    this.prefixes = config.exportActionPrefixes ?? DEFAULT_PREFIXES;
    this.internalDest = config.internalDestinations ?? DEFAULT_INTERNAL_DEST;
  }

  private isExport(action: string, resourceType: string): boolean {
    return this.types.includes(resourceType) || this.prefixes.some((p) => action.startsWith(p));
  }

  evaluate(input: AutonomyInput): ApprovalVerdict {
    const { action, resourceType, attributes } = input.action;
    if (!this.isExport(action, resourceType)) {
      return { rule: this.name, effect: 'abstain', reasonCodes: [] };
    }
    // Sensitive data always asks.
    if (attributes?.sensitive === true) {
      return { rule: this.name, effect: 'require_approval', reasonCodes: [EXPORT_REASON_CODES.SENSITIVE_DATA] };
    }
    // Destination must be a known-internal value to be autonomous.
    const dest = attributes?.destination;
    if (typeof dest !== 'string' || !this.internalDest.includes(dest)) {
      return { rule: this.name, effect: 'require_approval', reasonCodes: [EXPORT_REASON_CODES.EXTERNAL_DESTINATION] };
    }
    // Scope must be known and bounded.
    const rows = readRowCount(attributes);
    if (rows === null) {
      return { rule: this.name, effect: 'require_approval', reasonCodes: [EXPORT_REASON_CODES.SCOPE_UNKNOWN] };
    }
    if (rows > this.ceiling) {
      return { rule: this.name, effect: 'require_approval', reasonCodes: [EXPORT_REASON_CODES.OVER_ROW_CEILING] };
    }
    return { rule: this.name, effect: 'autonomous_ok', reasonCodes: [EXPORT_REASON_CODES.INTERNAL_SMALL_OK] };
  }
}

export function exportApprovalRule(config: ExportRuleConfig): ExportApprovalRule {
  return new ExportApprovalRule(config);
}
