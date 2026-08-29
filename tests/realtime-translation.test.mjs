import assert from "node:assert/strict";
import test from "node:test";
import {
  waitForPeerConnection,
  withAbort,
} from "../lib/realtime-translation.ts";

class FakePeerConnection extends EventTarget {
  connectionState = "connecting";

  transitionTo(connectionState) {
    this.connectionState = connectionState;
    this.dispatchEvent(new Event("connectionstatechange"));
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
