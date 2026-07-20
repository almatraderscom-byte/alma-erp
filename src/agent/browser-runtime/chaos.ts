/**
 * Browser runtime chaos certification (G15 / SPEC-150, browser half).
 *
 * The red-team gate for the browser zone. It composes the whole browser stack —
 * plan/perception/action separation (146), compact observation state (147),
 * replan limits (148), cost + step hard-stops (149) — and injects the adversarial
 * conditions a browser agent faces (a hallucinated/injected target, a page full
 * of secrets, an oversize view, runaway replans/stalls, cost/step blow-ups),
 * asserting every guard holds by DRIVING the stack (INV-10). Deterministic +
 * self-contained (INV-01).
 */
import { isSuccess, type ExecutionIdentity } from '@/agent/contracts';
import { decideAction } from './runtime';
import { compactObservation, REDACTED, type RawSnapshot } from './observation-state';
import { emptyReplanState, requestReplan, recordStep, stepSignature, type ReplanCaps } from './replan';
import { emptyRunAccounting, admitStep, type BrowserRunBudget } from './hard-stops';
import type { BrowserPlan, Observation } from './contract';

const identity = (): ExecutionIdentity => ({
  tenantId: 'alma',
  actorId: 'maruf',
  workflowId: 'wf',
  stepId: 's',
  correlationId: 'c',
});

const plan = (steps: BrowserPlan['steps']): BrowserPlan => ({ planId: 'p', identity: identity(), goalId: 'g', steps });
const obs = (elements: Observation['elements']): Observation => ({ identity: identity(), observedAtMs: 1000, urlRef: 'x.com/p', elements });

export interface ChaosResult {
  invariant: string;
  ok: boolean;
}

export function runBrowserChaosSuite(): ChaosResult[] {
  const checks: Array<[string, () => boolean]> = [
    ['action on a non-present (hallucinated/injected) target is DENIED', () => {
      const p = plan([{ stepIndex: 0, intent: 'click', targetHint: 'Delete all records' }]);
      const r = decideAction(p, obs([{ ref: 'e1', role: 'button', label: 'Submit' }]), 0);
      return !isSuccess(r) && r.status === 'DENIED' && r.reasonCodes.includes('BR_TARGET_NOT_IN_PERCEPTION');
    }],
    ['an action is minted only for a target actually present', () => {
      const p = plan([{ stepIndex: 0, intent: 'click', targetHint: 'Submit' }]);
      const r = decideAction(p, obs([{ ref: 'e1', role: 'button', label: 'Submit' }]), 0);
      return isSuccess(r) && r.value.targetRef === 'e1';
    }],
    ['secrets never reach the compacted model view', () => {
      const snap: RawSnapshot = {
        identity: identity(),
        observedAtMs: 1000,
        rawUrl: 'https://x.com/p?session=SECRET123#f',
        elements: [
          { ref: 'e1', role: 'textbox', label: 'Password', value: 'hunter2' },
          { ref: 'e2', role: 'button', label: 'Submit', value: 'CARD-4111-1111' },
        ],
      };
      const { result } = compactObservation(snap, { maxElements: 8, maxLabelChars: 40, maxBytes: 8192 });
      if (!isSuccess(result)) return false;
      const s = JSON.stringify(result.value);
      return !s.includes('hunter2') && !s.includes('CARD-4111-1111') && !s.includes('SECRET123') && s.includes(REDACTED);
    }],
    ['an oversize observation is refused fail-closed', () => {
      const snap: RawSnapshot = { identity: identity(), observedAtMs: 1000, rawUrl: 'x.com', elements: [{ ref: 'e', role: 'button', label: 'z'.repeat(300) }] };
      const { result } = compactObservation(snap, { maxElements: 1, maxLabelChars: 500, maxBytes: 40 });
      return !isSuccess(result) && result.reasonCodes.includes('BR_OBS_OVERSIZE');
    }],
    ['runaway replanning hard-stops at the budget', () => {
      const caps: ReplanCaps = { maxReplans: 1, maxStalls: 5 };
      let st = emptyReplanState();
      const a = requestReplan(st, caps);
      st = a.state;
      const b = requestReplan(st, caps);
      return isSuccess(a.result) && !isSuccess(b.result) && b.result.reasonCodes.includes('BR_REPLAN_LIMIT_REACHED');
    }],
    ['a non-progressing loop is hard-stopped (stall)', () => {
      const caps: ReplanCaps = { maxReplans: 5, maxStalls: 1 };
      let st = emptyReplanState();
      const sig = stepSignature(0, 'stuck');
      let last = recordStep(st, sig, caps); // stalls 0
      st = last.state;
      last = recordStep(st, sig, caps); // stalls 1
      st = last.state;
      last = recordStep(st, sig, caps); // stalls 2 > 1 ⇒ STALLED
      return !isSuccess(last.result) && last.result.reasonCodes.includes('BR_STALLED_NO_PROGRESS');
    }],
    ['a cost blow-up hard-stops at the nano-USD ceiling', () => {
      const b: BrowserRunBudget = { costCeilingNanoUsd: 1000, maxSteps: 10 };
      const r = admitStep({ spentNanoUsd: 900, steps: 1 }, b, 200); // 1100 > 1000
      return !isSuccess(r.result) && r.result.status === 'BUDGET_EXCEEDED' && r.result.reasonCodes.includes('BR_COST_CEILING_REACHED');
    }],
    ['a step blow-up hard-stops at the step ceiling', () => {
      const b: BrowserRunBudget = { costCeilingNanoUsd: 100000, maxSteps: 2 };
      let acc = emptyRunAccounting();
      acc = admitStep(acc, b, 1).accounting;
      acc = admitStep(acc, b, 1).accounting;
      const r = admitStep(acc, b, 1); // 3rd over cap
      return !isSuccess(r.result) && r.result.reasonCodes.includes('BR_STEP_LIMIT_REACHED');
    }],
    ['a float cost cannot slip past the ceiling (integer nano-USD only)', () => {
      const b: BrowserRunBudget = { costCeilingNanoUsd: 1000, maxSteps: 10 };
      const r = admitStep(emptyRunAccounting(), b, 0.5);
      return !isSuccess(r.result) && r.result.reasonCodes.includes('BR_HARD_STOP_MALFORMED');
    }],
  ];
  return checks.map(([invariant, run]) => {
    let ok = false;
    try {
      ok = run();
    } catch {
      ok = false;
    }
    return { invariant, ok };
  });
}
