# SPEC-073 — Contract

## DomainPackage (domain-package.ts)
```
interface DomainPackage { domain: string; manifests: ToolManifest[] }
validateDomainPackage(pkg): PackageIssue[]   # SCHEMA_INVALID | DOMAIN_MISMATCH |
                                             # DUPLICATE_NAME | EMPTY_PACKAGE | UNSORTED
defineDomainPackage(domain, manifests): DomainPackage   # throws on any issue
domainPackageSchema (zod)
```

## Side-effect seed (derive-side-effects.ts)
`deriveSideEffects(mode, domain, risk): SideEffectKind[]` — deterministic:
read→[db_read]; write/stage→[db_write] + domain-driven extras (external_message,
external_api_write, model_invocation, browser_action, file_write, schedule,
push_notification, money_movement@high). Frozen-enum output order.

## Generated data (domains.generated.ts)
`DOMAIN_PACKAGES: readonly DomainPackage[]` — 63 packages / 326 manifests, sourced
from `registry/inventory.data.ts`. Regenerate via
`scripts/build-domain-manifests.ts`.

## Loader (loader.ts), contract v1.0.0
`validateAll(packages): GlobalIssue[]` (adds global name-uniqueness + duplicate
domain). Load-time throw on any issue (fail-closed). Query API: `ALL_MANIFESTS`,
`ALL_PACKAGES`, `getManifest`, `manifestsForDomain`, `domains`, `manifestCount`.
Boundary `queryManifests(raw): ComponentResult<LoaderResultValue>` (identity-
enforced; get|byDomain|domains|count).
