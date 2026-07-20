# SPEC-157 Contract — Provider capability discovery
- `ModelCapabilities` + `CAPABILITY_REGISTRY` (json/tools/vision/streaming/
  reasoning + context/output ceilings) for every routable model.
- `discoverCapabilities(provider, model)` → caps | null (unknown model).
- `supportsCapability(caps, cap)` — fail-closed for unknown capability names.
- `createCapabilityGate()` → `check(provider, model, required[])` = missing detail
  codes (`CAP:<x>` / `UNKNOWN_MODEL:<p>/<m>`) or null.
- Fabric defaults to this gate: `requiredCapabilities` unmet →
  `MODEL_CAPABILITY_UNSUPPORTED` before cost authorization + provider call.
