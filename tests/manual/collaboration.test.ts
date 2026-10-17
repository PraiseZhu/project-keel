import { describe, expect, it } from 'vitest';
import { cloneManual, DEFAULT_MANUAL, parseManual, type Profile, type Route } from '../../src/shared/manual/schema.ts';
import { resolve, resolveDirection, resolveFinalReview } from '../../src/shared/manual/resolve.ts';
import { validateManual } from '../../src/shared/manual/validate.ts';

const route: Route = { agent: 'codex', model: 'gpt-6-astra', provider_id: 'art-cindy', effort: 'high' };

describe('parallel collaborators model contract', () => {
  it('reads v1 without rewriting it and preserves v2 collaborators without turning them into fallbacks', () => {
    const original = cloneManual(DEFAULT_MANUAL);
    expect(parseManual(original).version).toBe(1);
    const profile = original.profiles[0]!;
    const updated: Profile = { ...profile, direction_route: route, final_review_route: route,
      direction_collaborators: [{ ...route, effort: 'medium' }],
      final_review_collaborators: [{ ...route, provider_id: 'other' }],
      nodes: { ...profile.nodes, investigation: { explorer: { primary: route, collaborators: [{ ...route, provider_id: 'second' }], fallbacks: [] } } } };
    const manual = parseManual({ ...original, version: 2, profiles: [updated, ...original.profiles.slice(1)] });
    expect(resolve(manual, profile.id, 'investigation', 'explorer')).toMatchObject({ collaborators: [{ provider_id: 'second' }], fallbacks: [] });
    expect(resolveDirection(manual, profile.id, 'default').collaborators).toEqual(updated.direction_collaborators);
    expect(resolveFinalReview(manual, profile.id, 'default').collaborators).toEqual(updated.final_review_collaborators);
    expect(original.version).toBe(1);
  });

  it('rejects unknown versions and more than four simultaneous models', () => {
    expect(() => parseManual({ ...DEFAULT_MANUAL, version: 99 })).toThrow(/version/);
    const manual = cloneManual(DEFAULT_MANUAL);
    const profile = { ...manual.profiles[0]!, final_review_collaborators: Array(4).fill(route) };
    expect(() => parseManual({ ...manual, version: 2, profiles: [profile] })).toThrow(/最多 3/);
  });

  it('rejects disabled collaborator routes and concurrent writing routes', () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    const profile = manual.profiles[0]!;
    const updated = { ...manual, version: 2 as const, profiles: [{ ...profile, final_review_route: route,
      final_review_collaborators: [route], nodes: { default: { ...profile.nodes.default, worker: { primary: route, collaborators: [route] } } } }] };
    const issues = validateManual(updated, [{ id: route.model, agent: route.agent, providerId: route.provider_id, efforts: ['high'], visible: false }], { manual: updated });
    expect(issues.some((issue) => issue.path.endsWith('final_review_collaborators/0'))).toBe(true);
    expect(issues.some((issue) => issue.message.includes('单一写手'))).toBe(true);
  });
});
