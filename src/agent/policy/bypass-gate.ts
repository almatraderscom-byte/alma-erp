/**
 * Authorization bypass gate (G11 / SPEC-110, CI half).
 *
 * The unified policy engine (SPEC-105 `PolicyEngine.decide` / `decidePolicy`) is
 * the ONLY sanctioned way to reach an authorization decision. Two bypasses are
 * statically detectable and both are forbidden for code OUTSIDE the policy
 * package:
 *
 *  1. Calling a single policy LAYER's `.evaluate(` directly — that skips the
 *     engine's deny-overrides, explicit-permit-required and tenant checks, so a
 *     lone layer's `permit` could be mistaken for a decision. Wiring assembles
 *     layers via the builders (`rbacLayer(...)`) and hands them to `PolicyEngine`;
 *     it never calls `.evaluate` itself, so this rule is precise.
 *  2. Hand-rolled authorization — gating a side effect on a raw comparison to a
 *     privileged role literal (`=== 'owner'`, `.roles.includes('admin')`) instead
 *     of asking the engine. Flagged so it is reviewed, not shipped silently.
 *
 * Pure functions over (file, importSpec/sourceText); the `.mjs` runner walks the
 * repo and applies them. Deterministic, no I/O here.
 */

/** The policy package. Files here are the engine itself — exempt from the gate. */
export const POLICY_PACKAGE_PATH = 'src/agent/policy/';

/** Internal layer modules an outsider must not deep-import to self-authorize. */
export const POLICY_LAYER_MODULES = ['rbac', 'abac', 'relationship'] as const;

/** Privileged role literals that must not gate a side effect by raw comparison. */
export const PRIVILEGED_ROLE_LITERALS = ['owner', 'admin', 'root', 'superuser'] as const;

const IMPORT_TO_POLICY_LAYER =
  /(?:^|\/)src\/agent\/policy\/(rbac|abac|relationship)(?:\.ts)?$/;

export interface BypassViolation {
  file: string;
  kind: 'layer-evaluate' | 'hand-rolled-authz';
  detail: string;
  line?: number;
}

function normalize(file: string): string {
  return file.replace(/^\.\//, '');
}

/** Is this file inside the policy package (and therefore exempt)? */
export function isInsidePolicyPackage(file: string): boolean {
  return normalize(file).includes(POLICY_PACKAGE_PATH);
}

/** Resolve an import specifier to a repo-relative POSIX path (`@/…`→`src/…`, relatives). */
export function resolveToRepoPath(fromFile: string, spec: string): string {
  const from = normalize(fromFile);
  if (spec.startsWith('.')) {
    const parts = from.split('/').slice(0, -1);
    for (const seg of spec.split('/')) {
      if (seg === '.' || seg === '') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return parts.join('/');
  }
  if (spec.startsWith('@/')) return 'src/' + spec.slice(2);
  return spec;
}

/** True if `spec` (imported from `fromFile`) deep-imports a policy layer module. */
export function importsPolicyLayer(fromFile: string, spec: string): string | null {
  const resolved = resolveToRepoPath(fromFile, spec);
  const m = IMPORT_TO_POLICY_LAYER.exec(resolved);
  return m ? m[1] : null;
}

/**
 * Is this file "authorization-aware" — does it import the policy or identity
 * package? The raw-role-literal rule fires ONLY for such files, because the
 * literal `'owner'` is an overloaded DATA value elsewhere in the agent (task
 * source, author type) and scanning every file for it is all false positives.
 * A module that pulls in principals/policy and STILL hand-rolls a role check is
 * the real target.
 */
export function isAuthorizationAware(fromFile: string, imports: string[]): boolean {
  return imports.some((spec) => {
    const r = resolveToRepoPath(fromFile, spec);
    return /(?:^|\/)src\/agent\/(policy|identity)(?:\/|$)/.test(r);
  });
}

/**
 * Scan a single non-policy source file for authorization bypasses. `imports` is
 * the list of import specifiers the file declares (the runner extracts them).
 * Returns violations; empty when clean. Files inside the policy package are
 * always clean (they ARE the engine).
 */
export function scanFileForBypass(
  file: string,
  sourceText: string,
  imports: string[],
): BypassViolation[] {
  if (isInsidePolicyPackage(file)) return [];
  const violations: BypassViolation[] = [];

  // (1) Deep-imports a layer AND calls `.evaluate(` → self-authorizing.
  const layer = imports.map((s) => importsPolicyLayer(file, s)).find(Boolean);
  if (layer && /\.evaluate\s*\(/.test(sourceText)) {
    violations.push({
      file,
      kind: 'layer-evaluate',
      detail: `imports policy layer "${layer}" and calls .evaluate() directly — route decisions through PolicyEngine.decide()/decidePolicy()`,
    });
  }

  // (2) Hand-rolled authz: raw comparison to a privileged role literal — only in
  //     authorization-aware files (see isAuthorizationAware) to avoid false
  //     positives on 'owner' used as an ordinary data value.
  if (!isAuthorizationAware(file, imports)) return violations;
  const lines = sourceText.split('\n');
  const rawRole = new RegExp(
    `(===|!==|==|!=)\\s*['"\`](${PRIVILEGED_ROLE_LITERALS.join('|')})['"\`]` +
      `|\\.(roles|scopes)\\b[\\s\\S]{0,40}?\\.includes\\(\\s*['"\`](${PRIVILEGED_ROLE_LITERALS.join('|')})['"\`]\\s*\\)`,
  );
  lines.forEach((text, i) => {
    // Allow an explicit, reviewed opt-out marker on the line.
    if (/policy-bypass-ok/.test(text)) return;
    if (rawRole.test(text)) {
      violations.push({
        file,
        kind: 'hand-rolled-authz',
        detail: `raw privileged-role check "${text.trim().slice(0, 80)}" — authorize via the policy engine, not an inline role literal`,
        line: i + 1,
      });
    }
  });

  return violations;
}
