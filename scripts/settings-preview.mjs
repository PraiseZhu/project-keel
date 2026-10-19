import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundled = await build({ stdin: { contents: `export { DEFAULT_MANUAL } from './src/shared/manual/schema.ts'; export { fakeHost } from './tests/helpers/fakeHost.ts'; export { runTool } from './src/main/dispatch.ts'; export { makeContext } from './src/main/context.ts';`, resolveDir: root, sourcefile: 'settings-preview-entry.ts' }, bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22' });
const { DEFAULT_MANUAL, fakeHost, runTool, makeContext } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
let kv = { manual: structuredClone(DEFAULT_MANUAL), previewUnrelatedPreference: 'preserve-me' };
let models = [];
let catalogStatus = 200;
let saveStatus = 204;
const routes = DEFAULT_MANUAL.profiles.flatMap((profile) => [profile.lead, profile.direction_route, profile.final_review_route, ...(profile.final_review_fallbacks ?? []),
  ...Object.values(profile.nodes).flatMap((roles) => Object.values(roles).flatMap((slot) => [slot.primary, ...(slot.fallbacks ?? [])]))]).filter(Boolean);
for (const route of routes) {
  if (models.some((model) => model.id === route.model && model.providerId === route.provider_id && model.agent === route.agent)) continue;
  models.push({ id: route.model, name: route.model, agent: route.agent, providerId: route.provider_id,
    providerName: route.provider_id === 'xd' ? 'Cindy AI（测试）' : 'Art Cindy（测试）', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', visible: true });
}
const modelCatalog = { ok: true, status: 200, models };
const host = fakeHost({ kv, agentModels: models, agentModelsResponse: modelCatalog, node(method) {
  if (method === 'git/state') return { ok: true, result: { root: '/preview/repo', branch: 'fixture', head: 'a'.repeat(40), gh_repo: 'fixture/repo' } };
  if (method === 'git/content-fingerprint') return { ok: true, result: { head: 'a'.repeat(40), status_digest: 'clean-fixture', content_hash: 'fixture-content' } };
  if (method === 'git/changed-files') return { ok: true, result: { files: [] } };
  return { ok: false, message: `PREVIEW_BLOCKED: ${method}` };
} });
const bridge = `const bridge=new BroadcastChannel('keel');bridge.onmessage=({data})=>{if(data.op==='clock-status')bridge.postMessage({type:'clock-status',reqId:data.reqId,result:{state:'running'}});if(data.op==='hooks-status')bridge.postMessage({type:'hooks-status',reqId:data.reqId,result:{claude_code:'not_installed',codex:'not_installed'}});};`;
const permitted = new Set(['settings.html', 'settings.js', 'settings.css']);
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const json = (data, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
  };
  let body = '';
  for await (const chunk of request) body += chunk;
  try {
    if (url.pathname === '/kv') {
      if (request.method === 'PUT') {
        if (saveStatus !== 204) return json({ error: 'simulated save failure' }, saveStatus);
        kv = JSON.parse(body);
        response.writeHead(204);
        return response.end();
      }
      return json(kv);
    }
    if (url.pathname === '/agent-models') return json({ ok: catalogStatus === 200, models }, catalogStatus);
    if (url.pathname === '/secrets' && request.method === 'GET') return json([{ key: 'api_key', saved: false }]);
    if (url.pathname.startsWith('/secrets/')) return json({ error: 'preview has no credentials' }, 403);
    if (url.pathname === '/app-context') return json({ context: { locale: 'zh-CN' } });
    if (url.pathname === '/test/state') return json({ kv, models, catalogStatus, saveStatus });
    if (url.pathname === '/test/control' && request.method === 'POST') {
      const control = JSON.parse(body);
      if (control.models) models = control.models;
      if (control.kv) kv = control.kv;
      if (control.catalogStatus) catalogStatus = control.catalogStatus;
      if (control.saveStatus) saveStatus = control.saveStatus;
      return json({ ok: true });
    }
    if (url.pathname === '/test/run' && request.method === 'POST') {
      const input = JSON.parse(body);
      host.kv = structuredClone(kv);
      host.agentModelList = structuredClone(models);
      Object.assign(modelCatalog, { ok: catalogStatus === 200, status: catalogStatus, models: structuredClone(models) });
      host.clock.t += 1000;
      const result = await runTool(makeContext(host, 'settings-preview', { lanes: [], routingPath: null, boardRepos: [], plansDir: null }, undefined, 'preview-lead'), input.tool || 'keel_run', input.args || {
        goal: '调查模型配置的保存与派工路径', sc: [{ id: 'SC-1', text: '提供文件指针' }], repo_dir: '/preview/repo', lead: input.lead || 'codex', playbook: 'investigation', ...(input.profile ? { profile: input.profile } : {}),
      });
      return json(result);
    }
    if (url.pathname === '/test/bridge.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      return response.end(bridge);
    }
    const name = url.pathname === '/' ? 'settings.html' : url.pathname.slice(1);
    if (!permitted.has(name)) return json({ error: 'not found' }, 404);
    let bytes = readFileSync(join(root, 'plugin', name));
    if (name.endsWith('.html')) bytes = Buffer.from(bytes.toString().replace('</body>', '<script src="/test/bridge.js"></script></body>'));
    response.writeHead(200, { 'Content-Type': name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript', 'Cache-Control': 'no-store' });
    response.end(bytes);
  } catch (error) { json({ error: error.message }, 500); }
});
server.listen(0, '127.0.0.1', () => console.log(`KEEL_SETTINGS_PREVIEW=http://127.0.0.1:${server.address().port}`));
