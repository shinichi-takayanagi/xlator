import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the XLATOR interface", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>XLATOR/);
  assert.match(html, /日本語ログ/);
  assert.match(html, /English log/);
  assert.match(html, /こんちわ、今日は暑いですね/);
  assert.match(html, /Yep, I(?:'|&#x27;)m fine/);
  assert.match(html, /ありがとう。また月曜日に！/);
  assert.match(html, /Thanks. See you on Monday!/);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /react-loading-skeleton/);
});

test("keeps the standard OpenAI API key on the server", async () => {
  const route = await readFile(
    new URL("../app/api/realtime/session/route.ts", import.meta.url),
    "utf8",
  );
  const exampleEnv = await readFile(new URL("../.env.example", import.meta.url), "utf8");

  assert.match(route, /process\.env\.OPENAI_API_KEY/);
  assert.match(route, /realtime\/translations\/client_secrets/);
  assert.doesNotMatch(route, /NEXT_PUBLIC_OPENAI_API_KEY/);
  assert.match(exampleEnv, /^OPENAI_API_KEY=/m);
  assert.doesNotMatch(exampleEnv, /sk-[A-Za-z0-9]{20,}/);
});

test("accepts source transcript deltas from both translation sessions", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(
    page,
    /event\.type === "session\.input_transcript\.delta"\)\s*\{\s*handleSourceDelta\(targetLanguage, event\)/,
  );
  assert.doesNotMatch(
    page,
    /session\.input_transcript\.delta" && targetLanguage === "en"/,
  );
  assert.match(page, /candidate\.text\.length > best\.text\.length/);
  assert.match(page, /candidate\.endMs > best\.endMs \+ 600/);
});

test("keeps audio and downloads aligned with the product rules", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /const shouldPlay = outputIsTranslation && languageMatches/);
  assert.match(page, /formatSrtTimestamp\(startMs\).*formatSrtTimestamp\(endMs\)/s);
  assert.match(page, /anchor\.download = `xlator-log\.\$\{format\}`/);
  assert.doesNotMatch(page, /xlator-demo/);
});
