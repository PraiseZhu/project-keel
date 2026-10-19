import { describe, expect, it } from 'vitest';
import { cloneManual, DEFAULT_MANUAL, parseManual, type Profile, type Route } from '../../src/shared/manual/schema.ts';
import { resolve, resolveDirection, resolveFinalReview } from '../../src/shared/manual/resolve.ts';
import { validateManual } from '../../src/shared/manual/validate.ts';

const route: Route = { agent: 'codex', model: 'gpt-6-astra', provider_id: 'art-cindy', effort: 'high' };

describe('parallel collaborators model contract', () => {
  it('reads v1 without rewriting it and still preserves stored v2 collaborators without turning them into fallbacks', () => {
    const v1 = { ...cloneManual(DEFAULT_MANUAL), version: 1 as const };
    expect(parseManual(v1).version).toBe(1);
    expect(v1.version).toBe(1);

    const original = cloneManual(DEFAULT_MANUAL);
    expect(original.version).toBe(2);
    const profile = original.profiles[0]!;
    const updated: Profile = { ...profile, direction_route: route, final_review_route: route,
      direction_collaborators: [{ ...route, effort: 'medium' }],
      final_review_collaborators: [{ ...route, provider_id: 'other' }],
      nodes: { ...profile.nodes, default: { ...profile.nodes.default, architect: { primary: route, collaborators: [{ ...route, provider_id: 'second' }], fallbacks: [] } } } };
    const manual = parseManual({ ...original, version: 2, profiles: [updated, ...original.profiles.slice(1)] });
    expect(resolve(manual, profile.id, 'default', 'architect')).toMatchObject({ collaborators: [{ provider_id: 'second' }], fallbacks: [] });
    expect(resolveDirection(manual, profile.id, 'default').collaborators).toEqual(updated.direction_collaborators);
    expect(resolveFinalReview(manual, profile.id, 'default').collaborators).toEqual(updated.final_review_collaborators);
  });

  it('rejects v1 manuals that carry collaborators, unknown versions and more than three simultaneous models', () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    const profile = { ...manual.profiles[0]!, final_review_collaborators: [route] };
    expect(() => parseManual({ ...manual, version: 1, profiles: [profile] })).toThrow(/version=2/);
    expect(() => parseManual({ ...DEFAULT_MANUAL, version: 99 })).toThrow(/version/);
    const many = { ...manual.profiles[0]!, final_review_collaborators: Array(4).fill(route) };
    expect(() => parseManual({ ...manual, version: 2, profiles: [many] })).toThrow(/最多 3/);
  });

  it('validates only 写代码: stored collaborators on other slots are inert, a concurrent writer is still rejected', () => {
    const manual = cloneManual(DEFAULT_MANUAL);
    const profile = manual.profiles[0]!;
    const bogus: Route = { agent: 'codex', model: 'no-such-model', provider_id: 'nowhere', effort: 'ultra' };
    const updated = { ...manual, version: 2 as const, profiles: [{ ...profile, final_review_route: route,
      direction_collaborators: [bogus], final_review_collaborators: [bogus],
      nodes: { default: { ...profile.nodes.default, architect: { primary: profile.nodes.default!.architect!.primary, collaborators: [bogus] }, worker: { primary: route, collaborators: [route] } } } }] };
    const issues = validateManual(updated, [{ id: route.model, agent: route.agent, providerId: route.provider_id, efforts: ['high'], visible: true }], { manual: updated });
    expect(issues.some((issue) => issue.path === 'profiles/sol/nodes/default/worker' && issue.message.includes('单一写手'))).toBe(true);
    expect(issues.some((issue) => /collaborators/.test(issue.path))).toBe(false);
    expect(issues.some((issue) => issue.message.includes('no-such-model'))).toBe(false);
  });
});
