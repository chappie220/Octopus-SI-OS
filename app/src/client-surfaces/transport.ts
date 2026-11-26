import { isWebClient } from "../webClient";
import { notifyClientAccessUnauthorized } from "../clientAccess";
import { createReconnectingEventSource, fetchWithRetry } from "../resilientTransport";
import type { ClientSurfaceDocumentChange, ClientSurfaceDocumentSnapshot } from "./types";

export async function readClientSurfaceDocuments(): Promise<ClientSurfaceDocumentSnapshot> {
  if (window.octopusTransport?.clientSurfaceDocuments) {
    return window.octopusTransport.clientSurfaceDocuments();
  }
  if (!isWebClient()) throw new Error("client surface documents require the desktop app or Agent server");
  const response = await fetchWithRetry(
    "/__octopus/client-surfaces",
    { cache: "no-store", credentials: "same-origin" },
    { timeoutMs: 8_000, maxAttempts: 4, initialDelayMs: 600, maxDelayMs: 5_000 },
  );
  if (response.status === 401) {
    notifyClientAccessUnauthorized();
  }
  if (!response.ok) throw new Error(`client surface read failed: HTTP ${response.status}`);
  return response.json() as Promise<ClientSurfaceDocumentSnapshot>;
}

export function subscribeClientSurfaceDocuments(
  listener: (change: ClientSurfaceDocumentChange) => void,
): () => void {
  if (window.octopusTransport?.onClientSurfaceDocumentsChanged) {
    return window.octopusTransport.onClientSurfaceDocumentsChanged(listener);
  }
  if (!isWebClient()) return () => {};
  return createReconnectingEventSource("/__octopus/client-surface-events", {
    onMessage: (event) => {
      try {
        const value = JSON.parse(event.data) as ClientSurfaceDocumentChange;
        if (typeof value.generation === "number") listener(value);
      } catch {
        listener({ generation: Date.now() });
      }
    },
    onReconnect: () => {
      listener({ generation: Date.now() });
    },
    onAuthError: notifyClientAccessUnauthorized,
  });
}
