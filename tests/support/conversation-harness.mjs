import { mock } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"]) {
  if (!(key in globalThis)) Object.defineProperty(globalThis, key, { value: undefined, configurable: true, writable: true });
}
const harness = { vad: null, transcriptions: [], translations: [], tracks: [] };
const stopLocalVad = mock.fn();
const startLocalVad = mock.fn();
const markSpeechDetected = mock.fn();
const overrides = {
  "@/app/hooks/use-local-vad": {
    useLocalVad(options) {
      harness.vad = options;
      return { stopLocalVad, startLocalVad, markSpeechDetected };
    },
  },
  "@/lib/realtime-transcription": {
    prefetchTranscriptionClientSecret: async () => {},
    connectTranscription: async (options) => {
      const connection = { close: mock.fn(), clear: () => true, commit: mock.fn(() => true) };
      harness.transcriptions.push({ ...options, connection });
      return connection;
    },
  },
  "@/lib/realtime-translation": {
    prefetchTranslationClientSecrets: async () => {},
    connectTranslation: async (options) => {
      let resolveDrain;
      const drained = new Promise((resolve) => { resolveDrain = resolve; });
      const connection = {
        targetLanguage: options.targetLanguage,
        audio: { muted: true, play: async () => {} },
        close: mock.fn(() => resolveDrain()),
        drain: mock.fn(() => drained),
      };
      harness.translations.push({ ...options, connection, resolveDrain });
      return connection;
    },
  },
};
const hookPath = new URL("../../app/hooks/use-conversation-session.ts", import.meta.url);
const compiled = ts.transpileModule(readFileSync(hookPath, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const dependencies = { react: React, ...overrides };
for (const [, specifier] of compiled.matchAll(/require\("([^"\n]+)"\)/gu)) {
  if (specifier in dependencies) continue;
  if (!specifier.startsWith("@/")) throw new Error(`Unexpected hook dependency: ${specifier}`);
  dependencies[specifier] = await import(new URL(`../../${specifier.slice(2)}.ts`, import.meta.url));
}
const hookExports = {};
new Function("require", "exports", compiled)((specifier) => dependencies[specifier], hookExports);
const { useConversationSession } = hookExports;

export async function mountConversation(t, render = () => null) {
  harness.transcriptions = [];
  harness.translations = [];
  harness.tracks = [];
  stopLocalVad.mock.resetCalls();
  markSpeechDetected.mock.resetCalls();
  startLocalVad.mock.resetCalls();
  const savedGlobals = new Map();
  const installGlobal = (key, value) => {
    savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  installGlobal("window", dom.window);
  installGlobal("document", dom.window.document);
  installGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  installGlobal("CustomEvent", dom.window.CustomEvent);
  installGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => {
      const track = { stop: mock.fn() };
      harness.tracks.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    } },
  });
  installGlobal("fetch", async () => ({ ok: true, json: async () => ({ configured: true }) }));
  t.mock.method(console, "info", () => {});
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 100_000 });
  window.setTimeout = globalThis.setTimeout;
  window.clearTimeout = globalThis.clearTimeout;
  window.setInterval = globalThis.setInterval;
  window.clearInterval = globalThis.clearInterval;
  t.mock.method(performance, "now", () => Date.now() - 100_000);
  let session;
  function Host() {
    session = useConversationSession();
    return render(session);
  }
  const root = createRoot(document.getElementById("root"));
  await act(async () => root.render(createElement(Host)));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    t.mock.timers.reset();
    t.mock.restoreAll();
    for (const [key, descriptor] of savedGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return {
    get session() { return session; },
    get vad() { return harness.vad; },
    get transcription() { return harness.transcriptions.at(-1); },
    get translations() { return harness.translations.slice(-2); },
    get tracks() { return harness.tracks; },
    stopLocalVad,
    markSpeechDetected,
    start: async () => act(async () => session.startConversation()),
    stop: async () => act(async () => session.stopConversation()),
    advance: async (ms) => act(async () => t.mock.timers.tick(ms)),
    event: async (event) => act(async () => harness.transcriptions.at(-1).onEvent(event)),
    speech: async () => act(async () => harness.vad.onSpeechStart(performance.now())),
    silence: async () => act(async () => harness.vad.onSilenceStart(performance.now())),
    resume: async () => act(async () => harness.vad.onSilenceCancel()),
    end: async () => act(async () => harness.vad.onSpeechEnd(performance.now())),
    unmount: async () => act(async () => root.unmount()),
  };
}
