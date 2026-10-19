import { KeelError } from '../host.ts';
import type { Route } from '../../shared/manual/schema.ts';
import { LEAD_DEFAULT_PROVIDER } from '../../shared/manual/stages.ts';
import { parseNodeReport, type NodeReport } from './report.ts';

export function sameRoute(left: Route, right: Route): boolean {
  return left.agent === right.agent && left.model === right.model
    && left.provider_id === right.provider_id && (left.effort ?? '') === (right.effort ?? '');
}

/** A 查资料 sub (provider LEAD_DEFAULT_PROVIDER) only pins the harness; configured routes must match exactly. */
export function routeMatches(observed: Route, expected: Route): boolean {
  if (expected.provider_id === LEAD_DEFAULT_PROVIDER) return observed.agent === expected.agent;
  return sameRoute(observed, expected);
}

export function readExecutionRoute(raw: unknown): Route | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (!['codex', 'claude-code', 'pi'].includes(String(value.agent)) || typeof value.model !== 'string'
    || typeof value.provider_id !== 'string' || !value.model || !value.provider_id) return undefined;
  if (value.effort !== undefined && typeof value.effort !== 'string') return undefined;
  return { agent: value.agent as Route['agent'], model: value.model, provider_id: value.provider_id,
    ...(typeof value.effort === 'string' ? { effort: value.effort } : {}) };
}

export function collectParallelReports(parentKey: string, arms: readonly { dispatch_key: string; route: Route }[], raw: unknown): NodeReport {
  if (!Array.isArray(raw) || raw.length !== arms.length) throw new KeelError('REPORT_INCOMPLETE', '必须收齐所有协作模型的报告，不能只取第一份。');
  const reports: NodeReport[] = [];
  const ids = new Set<string>();
  for (const arm of arms) {
    const matches = raw.filter((item) => item && typeof item === 'object' && item.dispatch_key === arm.dispatch_key);
    if (matches.length !== 1) throw new KeelError('REPORT_INCOMPLETE', `协作报告缺失或重复：${arm.dispatch_key}`);
    const item = matches[0] as Record<string, unknown>;
    const report = parseNodeReport(typeof item.report === 'string' ? item.report : JSON.stringify(item.report), arm.dispatch_key);
    if (report.status === 'done' || report.status === 'partial') {
      const route = readExecutionRoute(item.execution_route);
      if (!route || !routeMatches(route, arm.route)) throw new KeelError('EXECUTION_ROUTE_MISMATCH', `协作模型实际路线与选择不一致：${arm.dispatch_key}`);
      if (typeof item.native_agent_id !== 'string' || !item.native_agent_id || ids.has(item.native_agent_id)) throw new KeelError('REPORT_INVALID', '每个协作模型必须返回不同的原生 sub id。');
      ids.add(item.native_agent_id);
    }
    reports.push(report);
  }
  const failed = reports.some((report) => report.status === 'failed' || report.status === 'blocked');
  const head = reports.find((report) => report.head_sha)?.head_sha;
  if (head && reports.some((report) => report.head_sha !== head)) throw new KeelError('HEAD_MISMATCH', '协作报告必须针对同一个 HEAD。');
  const verdict = reports.some((report) => report.verdict === 'FAIL') ? 'FAIL'
    : reports.every((report) => report.verdict === 'PASS' || report.verdict === 'PASS+NOTES')
      ? reports.some((report) => report.verdict === 'PASS+NOTES') ? 'PASS+NOTES' : 'PASS' : undefined;
  const evidenceIds = [...new Set(reports.flatMap((report) => Object.keys(report.sc_evidence ?? {})))];
  return {
    dispatch_key: parentKey,
    status: failed ? 'blocked' : reports.some((report) => report.status === 'partial') ? 'partial' : 'done',
    summary: reports.map((report, index) => `[${index + 1}] ${report.summary}`).join('\n'),
    files_changed: [...new Set(reports.flatMap((report) => [...report.files_changed]))],
    ran: reports.flatMap((report) => [...report.ran]),
    findings: reports.flatMap((report) => [...(report.findings ?? [])]),
    citation: reports.map((report) => report.citation).filter(Boolean).join('\n'),
    ...(head ? { head_sha: head } : {}),
    ...(verdict ? { verdict } : {}),
    sc_evidence: Object.fromEntries(evidenceIds.map((id) => [id, reports.every((report) => report.sc_evidence?.[id] === true)])),
    ui_evidence: reports.every((report) => report.ui_evidence?.length) ? reports.flatMap((report) => [...report.ui_evidence!]) : [],
    surface: failed ? 'blocked' : reports.every((report) => report.surface === 'live-ui') ? 'live-ui' : reports.every((report) => report.surface === 'unit-test' || report.surface === 'live-ui') ? 'unit-test' : 'type-check',
  };
}
