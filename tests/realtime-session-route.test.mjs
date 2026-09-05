import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GET, POST } from "../app/api/realtime/session/route.ts";

const originalApiKey = process.env.OPENAI_API_KEY;
const originalFetch = globalThis.fetch;

test.afterEach(() => {
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
  globalThis.fetch = originalFetch;
});

test("reports whether the server API key is configured", async () => {
  delete process.env.OPENAI_API_KEY;
  assert.deepEqual(await (await GET()).json(), { configured: false });
  process.env.OPENAI_API_KEY = "   ";
  assert.deepEqual(await (await GET()).json(), { configured: false });
  process.env.OPENAI_API_KEY = "server-only-test-key";
  assert.deepEqual(await (await GET()).json(), { configured: true });
});

test("rejects session creation without a server API key", async () => {
  delete process.env.OPENAI_API_KEY;
  const response = await POST(new Request("http://localhost/api/realtime/session", {
    method: "POST",
    body: JSON.stringify({ targetLanguage: "en" }),
  }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "missing_api_key");
});

test("validates the target language", async () => {
  process.env.OPENAI_API_KEY = "server-only-test-key";
  const response = await POST(new Request("http://localhost/api/realtime/session", {
    method: "POST",
    body: JSON.stringify({ targetLanguage: "fr" }),
  }));
  assert.equal(response.status, 400);
});

test("creates a ten-minute translation secret without duplicate transcription", async () => {
  process.env.OPENAI_API_KEY = "server-only-test-key";
  let upstreamRequest;
  globalThis.fetch = async (url, init) => {
    upstreamRequest = { url, init };
    return Response.json({
      value: "short-lived-secret",
      expires_at: 1234,
      session: { model: "gpt-realtime-translate" },
    });
  };

  const response = await POST(new Request("http://localhost/api/realtime/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetLanguage: "ja" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    value: "short-lived-secret",
    expires_at: 1234,
  });
  assert.equal(upstreamRequest.url, "https://api.openai.com/v1/realtime/translations/client_secrets");
  assert.equal(upstreamRequest.init.headers.Authorization, "Bearer server-only-test-key");

  const body = JSON.parse(upstreamRequest.init.body);
  assert.deepEqual(body.expires_after, { anchor: "created_at", seconds: 600 });
  assert.equal(body.session.model, "gpt-realtime-translate");
  assert.equal(body.session.audio.input.transcription, undefined);
  assert.equal(body.session.audio.input.noise_reduction.type, "far_field");
  assert.equal(body.session.audio.output.language, "ja");
});

test("keeps example environment values free of secrets", async () => {
  const exampleEnv = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(exampleEnv, /^OPENAI_API_KEY=$/m);
  assert.match(exampleEnv, /^OPENAI_TRANSCRIPTION_MODEL=gpt-live-transcribe$/m);
  assert.match(exampleEnv, /^OPENAI_TRANSCRIPTION_DELAY=minimal$/m);
  assert.doesNotMatch(exampleEnv, /sk-[A-Za-z0-9]{20,}/);
});
