import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/translate/route.ts";
import {
  createResponseTextDeltaStream,
  parseTextTranslationInput,
} from "../lib/text-translation.ts";

const originalApiKey = process.env.OPENAI_API_KEY;
const originalModel = process.env.OPENAI_TEXT_TRANSLATION_MODEL;
const originalFetch = globalThis.fetch;

test.afterEach(() => {
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
  if (originalModel === undefined) delete process.env.OPENAI_TEXT_TRANSLATION_MODEL;
  else process.env.OPENAI_TEXT_TRANSLATION_MODEL = originalModel;
  globalThis.fetch = originalFetch;
});

function request(body) {
  return new Request("http://localhost/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("validates opposite Japanese and English translation directions", () => {
  assert.deepEqual(parseTextTranslationInput({
    text: "こんにちは",
    sourceLanguage: "ja",
    targetLanguage: "en",
  }), {
    text: "こんにちは",
    sourceLanguage: "ja",
    targetLanguage: "en",
  });
  assert.equal(parseTextTranslationInput({
    text: "hello",
    sourceLanguage: "en",
    targetLanguage: "en",
  }), null);
  assert.equal(parseTextTranslationInput({
    text: "",
    sourceLanguage: "ja",
    targetLanguage: "en",
  }), null);
});

test("extracts only output text deltas from split Responses SSE chunks", async () => {
  const encoder = new TextEncoder();
  const upstream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: {\"type\":\"response.created\"}\n\ndata: {\"type\":\"response.output_"));
      controller.enqueue(encoder.encode("text.delta\",\"delta\":\"Good \"}\n\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"morning\"}\n\n"));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  const result = await new Response(createResponseTextDeltaStream(upstream)).text();
  assert.equal(result, "Good morning");
});

test("proxies streamed Responses translation deltas as plain text", async () => {
  process.env.OPENAI_API_KEY = "server-only-test-key";
  process.env.OPENAI_TEXT_TRANSLATION_MODEL = "custom-text-model";
  let upstreamRequest;
  globalThis.fetch = async (url, init) => {
    upstreamRequest = { url, init };
    return new Response([
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Good \"}\n\n",
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"morning.\"}\n\n",
      "data: [DONE]\n\n",
    ].join(""), { headers: { "Content-Type": "text/event-stream" } });
  };

  const response = await POST(request({
    text: "おはようございます。",
    sourceLanguage: "ja",
    targetLanguage: "en",
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/plain/);
  assert.equal(await response.text(), "Good morning.");
  assert.equal(upstreamRequest.url, "https://api.openai.com/v1/responses");

  const body = JSON.parse(upstreamRequest.init.body);
  assert.equal(body.model, "custom-text-model");
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.deepEqual(body.reasoning, { effort: "none" });
  assert.equal(body.input, "おはようございます。");
  assert.match(body.instructions, /Japanese to English/);
});

test("rejects text translation without the server API key", async () => {
  delete process.env.OPENAI_API_KEY;
  const response = await POST(request({
    text: "hello",
    sourceLanguage: "en",
    targetLanguage: "ja",
  }));
  assert.equal(response.status, 503);
});
