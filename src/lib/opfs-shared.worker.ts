/// <reference lib="webworker" />

import type { StorageDbRequest, StorageDbResponse } from "./opfs-db-protocol";

const ENGINE_TIMEOUT_MS = 30_000;
const pending = new Map<number, { port: MessagePort; requestId: number }>();
const queued: Array<{ port: MessagePort; request: StorageDbRequest }> = [];
const clients = new Set<MessagePort>();
let engineRequestId = 0;
let engine: MessagePort | null = null;
let hostRequested = false;
let hostRequestId = 0;
let hostRequestedAt = 0;
let heartbeatId: number | null = null;
let heartbeatSentAt = 0;
let engineHost: MessagePort | null = null;

function requestHost(candidate?: MessagePort) {
  if (engine) return;
  if (!hostRequested) {
    hostRequested = true;
    hostRequestId += 1;
    hostRequestedAt = Date.now();
  }
  if (candidate) {
    candidate.postMessage({ type: "need-engine", requestId: hostRequestId });
    return;
  }
  for (const port of clients) port.postMessage({ type: "need-engine", requestId: hostRequestId });
}

function loseEngine(message: string) {
  engine?.close();
  engine = null;
  engineHost = null;
  heartbeatId = null;
  heartbeatSentAt = 0;
  hostRequested = false;
  hostRequestedAt = 0;
  for (const destination of pending.values()) {
    destination.port.postMessage({ id: destination.requestId, error: message });
  }
  pending.clear();
  requestHost();
}

function handleEngineMessage(event: MessageEvent<StorageDbResponse>) {
  if (event.data.id === heartbeatId) {
    heartbeatId = null;
    heartbeatSentAt = 0;
    return;
  }
  const destination = pending.get(event.data.id);
  if (!destination) return;
  pending.delete(event.data.id);
  destination.port.postMessage({ ...event.data, id: destination.requestId });
}

function forward(port: MessagePort, request: StorageDbRequest) {
  if (!engine) {
    queued.push({ port, request });
    requestHost();
    return;
  }
  const id = ++engineRequestId;
  pending.set(id, { port, requestId: request.id });
  engine.postMessage({ ...request, id });
}

const scope = self as typeof self & {
  onconnect: ((event: MessageEvent & { ports: MessagePort[] }) => void) | null;
};

scope.onconnect = (event) => {
  const port = event.ports[0];
  clients.add(port);
  port.onmessage = (message: MessageEvent<StorageDbRequest | { type: "attach-engine"; requestId: number; port: MessagePort } | { type: "release-engine"; requestId: number }>) => {
    if ("type" in message.data && message.data.type === "attach-engine") {
      if (engine || message.data.requestId !== hostRequestId) {
        message.data.port.close();
        return;
      }
      engine = message.data.port;
      engineHost = port;
      hostRequested = false;
      hostRequestedAt = 0;
      heartbeatId = null;
      heartbeatSentAt = 0;
      engine.onmessage = handleEngineMessage;
      engine.start();
      for (const item of queued.splice(0)) forward(item.port, item.request);
      return;
    }
    if ("type" in message.data && message.data.type === "release-engine") {
      if (engineHost === port && message.data.requestId === hostRequestId) loseEngine("The local database owner changed. Retry the operation.");
      return;
    }
    forward(port, message.data as StorageDbRequest);
  };
  port.start();
  requestHost(port);
};

setInterval(() => {
  if (!engine) {
    if (hostRequested && Date.now() - hostRequestedAt > ENGINE_TIMEOUT_MS) hostRequested = false;
    requestHost();
    return;
  }
  if (heartbeatId !== null && Date.now() - heartbeatSentAt > ENGINE_TIMEOUT_MS) {
    loseEngine("The local database owner changed. Retry the operation.");
    return;
  }
  if (heartbeatId !== null) return;
  heartbeatId = ++engineRequestId;
  heartbeatSentAt = Date.now();
  engine.postMessage({ id: heartbeatId, method: "ping", params: undefined });
}, 2_000);
