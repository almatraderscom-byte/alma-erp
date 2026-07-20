/**
 * Provider runtime barrel (G16).
 *
 * Concrete, deterministic runtime pieces that sit behind the vendor-neutral
 * model fabric: the provider adapter interface + FAKE adapter (SPEC-151),
 * capability discovery (SPEC-157), timeout/quota controls (SPEC-158), failover
 * (SPEC-159) and the adapter conformance harness (SPEC-160).
 *
 * No file in this zone performs a real network call. Real SDK adapters are a
 * documented seam implemented outside this group.
 */
export * from './adapter';
export * from './fake-adapter';
export * from './capabilities';
export * from './timeout-quota';
export * from './failover';
export * from './conformance';
