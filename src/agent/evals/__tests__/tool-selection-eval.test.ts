import { describe, it, expect } from 'vitest';
import { evaluateToolSelection } from '../tool-selection-eval';

describe('tool-selection evaluation (SPEC-186)', () => {
  it('perfect selection scores precision & recall 1', () => {
    const r = evaluateToolSelection([
      { taskId: 'g-order-status', selectedTools: ['order.read'] },
      { taskId: 'g-refund', selectedTools: ['wallet.refund'] },
    ]);
    expect(r.meanPrecision).toBe(1);
    expect(r.meanRecall).toBe(1);
  });
  it('penalises over-exposure (extra tools lower precision)', () => {
    const r = evaluateToolSelection([{ taskId: 'g-order-status', selectedTools: ['order.read', 'wallet.refund'] }]);
    expect(r.perTask[0].precision).toBe(0.5);
    expect(r.perTask[0].extra).toContain('wallet.refund');
  });
  it('penalises under-exposure (missing tool lowers recall)', () => {
    const r = evaluateToolSelection([{ taskId: 'g-refund', selectedTools: [] }]);
    expect(r.perTask[0].recall).toBe(0);
    expect(r.perTask[0].missing).toContain('wallet.refund');
  });
});
