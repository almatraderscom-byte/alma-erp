/**
 * Workflow versioning (G14 / SPEC-132).
 *
 * A durable instance may run for hours or days. If a template is updated
 * mid-flight, the running instance must NOT silently jump versions — it pins the
 * version it started on and runs that to completion (INV-09: existing behavior
 * stays compatible until an explicit, evidence-backed migration). This module is
 * the deterministic pin/resolve/guard for that rule.
 *
 * Pure, no I/O (INV-01).
 */
import { z } from 'zod';
import type { WorkflowTemplate, WorkflowTemplateRegistry } from './registry';

/** The immutable version pin an instance carries for its whole life. */
export interface TemplatePin {
  templateId: string;
  templateVersion: number;
}

export const templatePinSchema: z.ZodType<TemplatePin> = z.object({
  templateId: z.string().min(1),
  templateVersion: z.number().int().positive(),
}) as z.ZodType<TemplatePin>;

export const VERSION_REASON_CODES = {
  UNKNOWN_TEMPLATE: 'WF_UNKNOWN_TEMPLATE',
  VERSION_DRIFT: 'WF_VERSION_DRIFT',
  MALFORMED_PIN: 'WF_MALFORMED_PIN',
} as const;

/**
 * Choose the version to pin when STARTING an instance. `requested` pins that
 * exact version; omitted pins the current latest. Returns the pin or null if the
 * template/version does not exist (fail-closed: no instance without a real pin).
 */
export function pinAtStart(
  registry: WorkflowTemplateRegistry,
  templateId: string,
  requested?: number,
): TemplatePin | null {
  const version = requested ?? registry.latestVersion(templateId) ?? undefined;
  if (version === undefined) return null;
  if (!registry.get(templateId, version)) return null;
  return { templateId, templateVersion: version };
}

/**
 * Resolve the exact template for an already-pinned instance. Returns null if the
 * pin is malformed or its version is no longer in the registry — the runtime must
 * treat that as a hard error, never fall back to another version.
 */
export function templateForPin(
  registry: WorkflowTemplateRegistry,
  pin: TemplatePin,
): WorkflowTemplate | null {
  if (!templatePinSchema.safeParse(pin).success) return null;
  return registry.get(pin.templateId, pin.templateVersion);
}

/**
 * Guard a resume/continue: the version presented when resuming MUST equal the
 * instance's pinned version. Any drift is rejected (never silently migrated).
 */
export function assertNoVersionDrift(pin: TemplatePin, presentedVersion: number): string[] {
  if (!templatePinSchema.safeParse(pin).success) return [VERSION_REASON_CODES.MALFORMED_PIN];
  if (presentedVersion !== pin.templateVersion) return [VERSION_REASON_CODES.VERSION_DRIFT];
  return [];
}

/**
 * Whether an explicit migration from one version to another is permitted. Default
 * policy is DENY (INV-09) — migration of an in-flight instance requires an
 * explicit opt-in and is only same-template. Higher layers supply evidence.
 */
export function isMigrationAllowed(pin: TemplatePin, toVersion: number, opts: { explicit: boolean } = { explicit: false }): boolean {
  if (!opts.explicit) return false;
  if (!templatePinSchema.safeParse(pin).success) return false;
  return toVersion > pin.templateVersion; // only forward, and only when explicit
}
