import { describe, it, expect } from 'vitest';
import { certifyKnownWorkflows, needsPlanner, ALL_KNOWN_TEMPLATES } from '../no-planner-gate';
import type { WorkflowTemplate } from '@/agent/workflows/registry';

describe('known-workflow no-planner certification (SPEC-180)', () => {
  it('certifies every known workflow: valid, planner-free, unique, deterministically runnable', () => {
    const cert = certifyKnownWorkflows();
    expect(cert.failures).toEqual([]);
    expect(cert.ok).toBe(true);
    expect(cert.total).toBeGreaterThanOrEqual(10);
  });

  it('flags a template that contains a planner step', () => {
    const bad: WorkflowTemplate = { id: 'x', version: 1, steps: [{ id: 'p', action: 'plan.decompose', sideEffect: false, onFailure: 'terminal' }] };
    expect(needsPlanner(bad)).toBe(true);
  });

  it('real known templates contain no planner steps', () => {
    expect(ALL_KNOWN_TEMPLATES.every((t) => !needsPlanner(t))).toBe(true);
  });

  it('template ids are unique across all domains', () => {
    const ids = ALL_KNOWN_TEMPLATES.map((t) => `${t.id}@${t.version}`);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
