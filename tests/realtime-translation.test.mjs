import assert from "node:assert/strict";
import test from "node:test";
import {
  createConnectionAbortScope,
  waitForDataChannel,
  waitForPeerConnection,
  withAbort,
  withAbortCleanup,
} from "../lib/realtime-connection.ts";

class FakePeerConnection extends EventTarget {
  connectionState = "connecting";

  transitionTo(connectionState) {
    this.connectionState = connectionState;
    this.dispatchEvent(new Event("connectionstatechange"));
  }
}

class FakeDataChannel extends EventTarget {
  readyState = "connecting";

  transitionTo(readyState) {
    this.readyState = readyState;
    this.dispatchEvent(new Event(readyState === "open" ? "open" : "close"));
  }
}

test("waits until a peer connection is connected", async () => {
  const peerConnection = new FakePeerConnection();
  const connected = waitForPeerConnection(peerConnection);
  peerConnection.transitionTo("connected");
  await connected;
});

test("rejects peer connection startup when it is aborted", async () => {
  const peerConnection = new FakePeerConnection();
  const controller = new AbortController();
  const connected = waitForPeerConnection(peerConnection, controller.signal);
  controller.abort();
  await assert.rejects(connected, { name: "AbortError" });
});

test("makes a shared pending operation cancelable for one caller", async () => {
  const controller = new AbortController();
  const pending = withAbort(new Promise(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("cleans up a media resource that arrives after startup cancellation", async () => {
  const controller = new AbortController();
  let resolveResource;
  const resourcePromise = new Promise((resolve) => {
    resolveResource = resolve;
  });
  const cleaned = [];
  const pending = withAbortCleanup(
    resourcePromise,
    controller.signal,
    (resource) => cleaned.push(resource),
  );

  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  resolveResource("late microphone stream");
  await Promise.resolve();
  assert.deepEqual(cleaned, ["late microphone stream"]);
});

test("waits for the realtime data channel before startup completes", async () => {
  const dataChannel = new FakeDataChannel();
  const opened = waitForDataChannel(dataChannel);
  dataChannel.transitionTo("open");
  await opened;
});

test("bounds the complete connection startup with one deadline", async () => {
  const scope = createConnectionAbortScope(undefined, 10);
  try {
    await assert.rejects(
      withAbort(new Promise(() => {}), scope.signal),
      /Realtime接続がタイムアウトしました。/,
    );
  } finally {
    scope.dispose();
  }
});

test("propagates caller cancellation through the connection scope", async () => {
  const controller = new AbortController();
  const scope = createConnectionAbortScope(controller.signal, 1_000);
  const pending = withAbort(new Promise(() => {}), scope.signal);
  controller.abort();
  try {
    await assert.rejects(pending, { name: "AbortError" });
  } finally {
    scope.dispose();
  }
});

test("clears the startup deadline after the connection is established", async () => {
  const scope = createConnectionAbortScope(undefined, 5);
  scope.clearDeadline();
  try {
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(scope.signal.aborted, false);
  } finally {
    scope.dispose();
  }
});
