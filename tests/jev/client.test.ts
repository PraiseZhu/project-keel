import { describe, expect, it } from "vitest";
import { evaluate, listModels, toRequestBody } from "../../src/main/jev/client.ts";
import { fakeHost, typesafeAnswering } from "../helpers/fakeHost.ts";

const q = { a: { type: "choice", instructions: "pick", criteria: { x: null, y: "why" } } } as const;

describe("jev client (typesafe-jev parity)", () => {
  it("builds the same body shape as typesafe-jev, defaulting to jev-latest", () => {
    expect(JSON.parse(toRequestBody({ state: "s", questions: q as any }))).toEqual({ model: "jev-latest", state: "s", questions: q });
  });
  it.each([
    [{ state: 1, questions: q }],
    [{ state: "s", questions: {} }],
    [{ state: "s", questions: q, model: "gpt-4" }],
    [{ state: "s", questions: { a: { type: "score", instructions: "x", criteria: ["one"] } } }],
    [{ state: "s", questions: { a: { type: "noul", instructions: "x", criteria: { maybe: "x" } } } }],
    [{ state: "s", questions: { a: { type: "choice", instructions: "x", criteria: {} } } }],
  ])("rejects invalid input %#", (args) => {
    expect(() => toRequestBody(args as any)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
  it("rejects bodies over 256 KB", () => {
    expect(() => toRequestBody({ state: "x".repeat(270_000), questions: q as any })).toThrowError(expect.objectContaining({ code: "INPUT_TOO_LARGE" }));
  });
  it("maps transport and HTTP failures to the legacy error codes", async () => {
    await expect(evaluate(fakeHost(), { state: "s", questions: q as any })).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    const http = fakeHost({ fetch: () => ({ ok: true, status: 401, body: "" }) });
    await expect(evaluate(http, { state: "s", questions: q as any })).rejects.toMatchObject({ code: "UPSTREAM_HTTP_ERROR" });
    const trunc = fakeHost({ fetch: () => ({ ok: true, status: 200, body: "{}", truncated: true }) });
    await expect(evaluate(trunc, { state: "s", questions: q as any })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const bad = fakeHost({ fetch: () => ({ ok: true, status: 200, body: JSON.stringify({ model: "m", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }) }) });
    await expect(evaluate(bad, { state: "s", questions: q as any })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const thrown = fakeHost({ fetch: () => { throw new Error("x"); } });
    await expect(evaluate(thrown, { state: "s", questions: q as any })).rejects.toMatchObject({ code: "REQUEST_FAILED" });
  });
  it("returns {model, answers, usage} on success and posts to /v1/systemone", async () => {
    const h = fakeHost({ fetch: typesafeAnswering(0.9) });
    const r = await evaluate(h, { state: "s", questions: q as any });
    expect(r.model).toBe("jev-latest");
    expect(r.answers.a?.choice).toBe("x");
    expect(h.fetches[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
  });
  it("reports JEV_NOT_CONFIGURED before calling out when no key is saved", async () => {
    const h = fakeHost({ fetch: typesafeAnswering(0.9) });
    await expect(evaluate(h, { state: "s", questions: q as any }, undefined, { configured: async () => false })).rejects.toMatchObject({ code: "JEV_NOT_CONFIGURED" });
    expect(h.fetches).toHaveLength(0);
  });
  it("lists models", async () => {
    expect(await listModels(fakeHost({ fetch: typesafeAnswering(0.9) }))).toEqual({ models: ["jev-latest"] });
  });
});

describe("missing credential", () => {
  it("maps the host's credential-not-configured failure to JEV_NOT_CONFIGURED", async () => {
    const h = fakeHost({ fetch: () => ({ ok: false, status: 0, body: "", message: "凭证未配置：请在插件详情页填写 Typesafe API Key" }) });
    await expect(evaluate(h, { state: "s", questions: q as any })).rejects.toMatchObject({ code: "JEV_NOT_CONFIGURED" });
  });
});
