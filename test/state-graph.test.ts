// test/state-graph.test.ts — task state machine + DAG helpers
import { describe, it, expect } from 'vitest';
import { canTransition, assertTransition, topoOrder, hasCycle } from '../src/orchestrator.js';

describe('task state machine', () => {
  it('allows legal transitions', () => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'completed')).toBe(true);
    expect(canTransition('running', 'failed')).toBe(true);
    expect(canTransition('failed', 'retrying')).toBe(true);
  });

  it('rejects illegal transitions', () => {
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('queued', 'completed')).toBe(false);
    expect(canTransition('cancelled', 'running')).toBe(false);
    expect(() => assertTransition('completed', 'running')).toThrow(/illegal/);
  });
});

describe('DAG helpers', () => {
  it('topologically orders tasks', () => {
    const order = topoOrder([
      { id: 'c', deps: ['b'] },
      { id: 'a', deps: [] },
      { id: 'b', deps: ['a'] },
    ]);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
  });

  it('detects cycles', () => {
    expect(hasCycle([{ id: 'a', deps: ['b'] }, { id: 'b', deps: ['a'] }])).toBe(true);
    expect(hasCycle([{ id: 'a', deps: [] }, { id: 'b', deps: ['a'] }])).toBe(false);
  });

  it('ignores deps to unknown tasks', () => {
    const order = topoOrder([{ id: 'a', deps: ['ghost'] }]);
    expect(order).toEqual(['a']);
  });
});
