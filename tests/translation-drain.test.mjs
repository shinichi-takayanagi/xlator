import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { connectTranslation } from "../lib/realtime-translation.ts";

async function connectMock(t) {
  const saved = new Map();
  function install(name, value) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  class Channel extends EventTarget {
    readyState = "open";
    sent = [];
    onmessage = null;
    send(data) { this.sent.push(JSON.parse(data)); }
    emit(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
    close() { this.readyState = "closed"; this.dispatchEvent(new Event("close")); }
  }
  const channel = new Channel();
  const closePeer = mock.fn();
  install("RTCPeerConnection", class {
    connectionState = "connected";
    addTrack() {}
    createDataChannel() { return channel; }
    async createOffer() { return { sdp: "offer" }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close = closePeer;
  });
  install("Audio", class { muted = true; pause() {} });
  install("fetch", async (url) => String(url).startsWith("/api/")
    ? Response.json({ value: "test-secret", expires_at: 0 })
    : new Response("answer"));
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const received = [];
  const connection = await connectTranslation({
    targetLanguage: "ja",
    sourceStream: { getAudioTracks: () => [{}] },
    muted: true,
    onEvent: (_language, event) => received.push(event),
    onConnectionState() {},
  });
  t.after(() => connection.close());
  return { connection, channel, closePeer, received };
}

test("translation drain delivers final fragments before session.closed and is idempotent", async (t) => {
  const h = await connectMock(t);
  const pending = h.connection.drain(5_000);
  assert.equal(h.connection.drain(5_000), pending);
  assert.deepEqual(h.channel.sent, [{ type: "session.close" }]);
  assert.equal(h.closePeer.mock.callCount(), 0);
  h.channel.emit({ type: "session.output_transcript.delta", delta: "最後の訳" });
  assert.equal(h.received[0].delta, "最後の訳");
  h.channel.emit({ type: "session.closed" });
  await pending;
  assert.equal(h.closePeer.mock.callCount(), 1);
  h.channel.emit({ type: "session.output_transcript.delta", delta: "late" });
  assert.equal(h.received.length, 2);
});

test("translation drain closes on deadline or immediate cancellation", async (t) => {
  const h = await connectMock(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = h.connection.drain(5_000);
  t.mock.timers.tick(4_999);
  assert.equal(h.closePeer.mock.callCount(), 0);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(h.closePeer.mock.callCount(), 1);
  h.connection.close();
  assert.equal(h.closePeer.mock.callCount(), 1);
});

test("immediate close releases a pending translation drain", async (t) => {
  const h = await connectMock(t);
  const pending = h.connection.drain(5_000);
  h.connection.close();
  await pending;
  assert.equal(h.closePeer.mock.callCount(), 1);
});
