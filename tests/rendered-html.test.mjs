import assert from "node:assert/strict";
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

test("server-renders the xlator interface", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>xlator/);
  assert.match(html, /日本語ログ/);
  assert.match(html, /English log/);
  assert.match(html, /こんちわ、今日は暑いですね/);
  assert.match(html, /Yep, I(?:'|&#x27;)m fine/);
  assert.match(html, /ありがとう。また月曜日に！/);
  assert.match(html, /Thanks. See you on Monday!/);
  assert.match(html, /href="https:\/\/github\.com\/shinichi-takayanagi\/xlator"/);
  assert.match(html, /aria-label="GitHubでリポジトリを開く"/);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /react-loading-skeleton/);
});
