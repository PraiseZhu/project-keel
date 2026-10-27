import { describe, expect, it } from 'vitest';
import { collectParallelReports, readExecutionRoute, routeMatches, sameRoute } from '../src/main/graph/collaboration.ts';
import type { Route } from '../src/shared/manual/schema.ts';

const first: Route = { agent: 'codex', model: 'gpt-6-luna', provider_id: 'gateway-a', effort: 'high' };
const second: Route = { ...first, provider_id: 'gateway-b' };
const arms = [{ dispatch_key: 'run/explore/1/parallel/1', route: first }, { dispatch_key: 'run/explore/1/parallel/2', route: second }];
const report = (index: number) => ({ dispatch_key: arms[index]!.dispatch_key, native_agent_id: `native-${index}`,
  execution_route: arms[index]!.route, report: { dispatch_key: arms[index]!.dispatch_key, status: 'done', summary: `finding-${index}`,
    files_changed: [], ran: [{ cmd: 'npm test', exit_code: 0, tests_passed: 1 }], verdict: 'PASS', surface: 'unit-test', head_sha: 'same-head', sc_evidence: { 'SC-1': true } } });

describe('collaboration results', () => {
  it('collects every parallel arm and preserves all evidence', () => {
    const combined = collectParallelReports('parent', arms, [report(1), report(0)]);
    expect(combined.dispatch_key).toBe('parent');
    expect(combined.ran).toHaveLength(2);
    expect(combined.summary).toContain('finding-0');
    expect(combined.summary).toContain('finding-1');
    expect(combined.verdict).toBe('PASS');
    expect(combined.sc_evidence).toEqual({ 'SC-1': true });
  });
  it('rejects missing, repeated, wrong-provider and reused native-agent receipts', () => {
    expect(() => collectParallelReports('parent', arms, [report(0)])).toThrow(/收齐/);
    expect(() => collectParallelReports('parent', arms, [report(0), report(0)])).toThrow(/重复/);
    expect(() => collectParallelReports('parent', arms, [report(0), { ...report(1), execution_route: first }])).toThrow(/路线/);
    expect(() => collectParallelReports('parent', arms, [report(0), { ...report(1), native_agent_id: 'native-0' }])).toThrow(/不同/);
  });
  it('cannot upgrade a failed or unverified arm to a successful final review', () => {
    const rejected = report(1);
    rejected.report.verdict = 'FAIL';
    rejected.report.sc_evidence['SC-1'] = false;
    const combined = collectParallelReports('parent', arms, [report(0), rejected]);
    expect(combined.verdict).toBe('FAIL');
    expect(combined.sc_evidence?.['SC-1']).toBe(false);
    const blocked = { ...report(1), report: { ...report(1).report, status: 'blocked', surface: 'blocked' }, execution_route: undefined };
    expect(collectParallelReports('parent', arms, [report(0), blocked]).status).toBe('blocked');
  });
  it('does not equate models from different providers or with different effort', () => {
    expect(sameRoute(first, second)).toBe(false);
    expect(sameRoute(first, { ...first, effort: 'medium' })).toBe(false);
    expect(readExecutionRoute({ model: first.model, provider_id: 'gateway-a' })).toBeUndefined();
  });
  it('treats missing, null and local as the same device, and splits same-name models on different computers', () => {
    expect(sameRoute(first, { ...first, agent_device_id: 'local' })).toBe(true);
    expect(sameRoute({ ...first, agent_device_id: 'local' }, first)).toBe(true);
    expect(sameRoute({ ...first, agent_device_id: 'dev-a' }, { ...first, agent_device_id: 'dev-b' })).toBe(false);
    expect(sameRoute({ ...first, agent_device_id: 'dev-a' }, first)).toBe(false);
    const observed = readExecutionRoute({ agent: first.agent, model: first.model, provider_id: first.provider_id, effort: first.effort });
    expect(observed).toEqual(first);
    expect(routeMatches(observed!, { ...first, agent_device_id: 'dev-a' })).toBe(true);
    expect(routeMatches(
      { ...first, agent_device_id: 'dev-b' },
      { ...first, agent_device_id: 'dev-a' },
    )).toBe(false);
    expect(routeMatches(
      { ...first, agent_device_id: 'local' },
      { ...first, agent_device_id: 'dev-a' },
    )).toBe(false);
  });
});
