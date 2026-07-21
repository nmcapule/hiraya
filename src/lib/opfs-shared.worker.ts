/// <reference lib="webworker" />

import type { StorageDbRequest, StorageDbResponse } from "./opfs-db-protocol";

const ENGINE_TIMEOUT_MS = 5_000;
const pending = new Map<number, { port: MessagePort; requestId: number }>();
const queued: Array<{ port: MessagePort; request: StorageDbRequest }> = [];
const clients = new Set<MessagePort>();
let engineRequestId = 0;
let engine: MessagePort | null = null;
let hostRequested = false;
let heartbeatId: number | null = null;
let lastEngineResponse = 0;

function requestHost() {
  if (engine || hostRequested) return;
  hostRequested = true;
  for (const port of clients) port.postMessage({ type: "need-engine" });
}

function loseEngine(message: string) {
  engine?.close();
  engine = null;
  heartbeatId = null;
  lastEngineResponse = 0;
  hostRequested = false;
  for (const destination of pending.values()) {
    destination.port.postMessage({ id: destination.requestId, error: message });
  }
  pending.clear();
  requestHost();
}

function handleEngineMessage(event: MessageEvent<StorageDbResponse>) {
  lastEngineResponse = Date.now();
  if (event.data.id === heartbeatId) {
    heartbeatId = null;
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
  port.onmessage = (message: MessageEvent<StorageDbRequest | { type: "attach-engine"; port: MessagePort }>) => {
    if ("type" in message.data && message.data.type === "attach-engine") {
      if (engine) return;
      engine = message.data.port;
      hostRequested = false;
      heartbeatId = null;
      lastEngineResponse = Date.now();
      engine.onmessage = handleEngineMessage;
      engine.start();
      for (const item of queued.splice(0)) forward(item.port, item.request);
      return;
    }
    forward(port, message.data as StorageDbRequest);
  };
  port.start();
  requestHost();
};

setInterval(() => {
  if (!engine) {
    requestHost();
    return;
  }
  if (Date.now() - lastEngineResponse > ENGINE_TIMEOUT_MS) {
    loseEngine("The local database owner changed. Retry the operation.");
    return;
  }
  if (heartbeatId !== null) return;
  heartbeatId = ++engineRequestId;
  engine.postMessage({ id: heartbeatId, method: "ping", params: undefined });
}, 2_000);
