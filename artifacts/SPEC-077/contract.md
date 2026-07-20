# SPEC-077 — Contract  (versioning.ts, contract v1.0.0)

- `parseSemver(v): Semver|null`  (strict MAJOR.MINOR.PATCH; leading zeros rejected)
- `compareSemver(a,b): -1|0|1`
- `isCompatible(requested, available): boolean` — same MAJOR & available≥requested;
  malformed → false (fail-closed)
- `bumpKind(from,to): none|patch|minor|major|downgrade|invalid`
- `checkTransition(from,to,declaredBreaking): TransitionCheck` — forward-only, no
  no-op, breakingness must match a MAJOR bump
- `resolveToolVersion(name, requested): VersionResolution{found,compatible,availableVersion}`
  against the live loader
- Boundary `queryVersioning(raw): ComponentResult` — resolve|compatible|transition;
  identity-enforced; never throws.
