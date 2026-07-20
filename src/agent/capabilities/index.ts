/**
 * G09 — Capability control plane (barrel).
 *
 * Deterministic capability catalog + facet logic + resolver/broker/gate, built on
 * G01 contracts, G02 admission intent, and G08 tool manifests. No runtime
 * dependency on the monolith, prisma, the network or any model (INV-01). Grows
 * one spec at a time across G09 (SPEC-081..090).
 */
export * from './capability.schema'
export * from './store'
export * from './capability-model'
export * from './intent-map'
export * from './tool-map'
export * from './permission'
export * from './cost-tier'
export * from './runtime-owner'
