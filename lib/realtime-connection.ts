export const CONNECTION_TIMEOUT_MS = 15_000;

export type ConnectionAbortScope = {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
  clearDeadline: () => void;
  dispose: () => void;
};

export function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("接続がキャンセルされました。", "AbortError");
}

export function createConnectionAbortScope(
  parentSignal?: AbortSignal,
  timeoutMs: number | null = CONNECTION_TIMEOUT_MS,
): ConnectionAbortScope {
  const controller = new AbortController();
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;

  const clearDeadline = () => {
    if (timeout === undefined) return;
    globalThis.clearTimeout(timeout);
    timeout = undefined;
  };
  const abort = (reason?: unknown) => {
    if (controller.signal.aborted) return;
    controller.abort(
      reason ?? new DOMException("接続がキャンセルされました。", "AbortError"),
    );
  };
  const onParentAbort = () => abort(parentSignal?.reason);

  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    if (timeoutMs !== null) {
      timeout = globalThis.setTimeout(() => {
        abort(new Error("Realtime接続がタイムアウトしました。"));
      }, timeoutMs);
    }
  }

  return {
    signal: controller.signal,
    abort,
    clearDeadline,
    dispose() {
      clearDeadline();
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

export function withAbort<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

export function withAbortCleanup<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  cleanup: (value: T) => void,
) {
  void promise.then(
    (value) => {
      if (signal.aborted) cleanup(value);
    },
    () => undefined,
  );
  return withAbort(promise, signal);
}

export function waitForPeerConnection(
  peerConnection: RTCPeerConnection,
  signal?: AbortSignal,
  timeoutMs: number | null = CONNECTION_TIMEOUT_MS,
) {
  if (peerConnection.connectionState === "connected") return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortError(signal));

  return new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (complete: () => void) => {
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      peerConnection.removeEventListener("connectionstatechange", onStateChange);
      signal?.removeEventListener("abort", onAbort);
      complete();
    };
    const onStateChange = () => {
      if (peerConnection.connectionState === "connected") {
        finish(resolve);
      } else if (
        peerConnection.connectionState === "failed" ||
        peerConnection.connectionState === "closed"
      ) {
        finish(() => reject(new Error("Realtimeとの接続を確立できませんでした。")));
      }
    };
    const onAbort = () => finish(() => reject(abortError(signal!)));

    if (timeoutMs !== null) {
      timeout = globalThis.setTimeout(() => {
        finish(() => reject(new Error("Realtime接続がタイムアウトしました。")));
      }, timeoutMs);
    }
    peerConnection.addEventListener("connectionstatechange", onStateChange);
    signal?.addEventListener("abort", onAbort, { once: true });
    onStateChange();
  });
}

export function waitForDataChannel(
  dataChannel: RTCDataChannel,
  signal?: AbortSignal,
  timeoutMs: number | null = CONNECTION_TIMEOUT_MS,
) {
  if (dataChannel.readyState === "open") return Promise.resolve();
  if (dataChannel.readyState === "closed") {
    return Promise.reject(new Error("Realtimeデータチャネルを開けませんでした。"));
  }
  if (signal?.aborted) return Promise.reject(abortError(signal));

  return new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (complete: () => void) => {
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      dataChannel.removeEventListener("open", onOpen);
      dataChannel.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
      complete();
    };
    const onOpen = () => finish(resolve);
    const onClose = () => finish(() => (
      reject(new Error("Realtimeデータチャネルを開けませんでした。"))
    ));
    const onAbort = () => finish(() => reject(abortError(signal!)));

    if (timeoutMs !== null) {
      timeout = globalThis.setTimeout(() => {
        finish(() => reject(new Error("Realtime接続がタイムアウトしました。")));
      }, timeoutMs);
    }
    dataChannel.addEventListener("open", onOpen, { once: true });
    dataChannel.addEventListener("close", onClose, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (dataChannel.readyState === "open") onOpen();
    else if (dataChannel.readyState === "closed") onClose();
  });
}
