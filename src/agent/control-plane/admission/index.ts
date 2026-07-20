/**
 * Admission control-plane PUBLIC barrel (G02 / SPEC-011, SPEC-020).
 *
 * The public entrypoint of the admission package. Cross-zone consumers import
 * from here (or the gateway), never from an internal stage module — the SPEC-020
 * bypass gate treats `registry`, `normalize`, `fast-path`, `intent`, `complexity`,
 * `planning`, `risk` and `dedup` as INTERNAL.
 *
 * This re-exports the shared intent vocabulary so consumers such as the G09
 * capability broker/resolver can use it through the sanctioned public surface
 * instead of deep-importing `./intent`. Additive only.
 */
export { INTENT_CLASSES, type IntentClass } from './intent';
