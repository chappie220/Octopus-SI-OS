import { isWebClient } from "./webClient";
import {
  fetchWithRetry,
  fetchWithTimeout,
  readJsonSafely,
  type FetchRetryInfo,
} from "./resilientTransport";
import type {
  OctopusAdministratorAccessUpdate,
  OctopusClientAccessDetails,
  OctopusClientAccessStatus,
  OctopusClientLabAccess,
  OctopusTouchIdStatus,
} from "./electron";

const ACCESS_URL = "/__octopus/access";
const STATUS_TIMEOUT_MS = 8_000;
const MUTATION_TIMEOUT_MS = 15_000;
const unauthorizedListeners = new Set<() => void>();

export function onClientAccessUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

export function notifyClientAccessUnauthorized(): void {
  for (const listener of [...unauthorizedListeners]) {
    try {
      listener();
    } catch {
      // Keep notifying remaining listeners.
    }
  }
}

export type ReadClientAccessOptions = {
  signal?: AbortSignal;
  onRetry?: (info: FetchRetryInfo) => void;
};

export async function readClientAccessStatus(
  options?: ReadClientAccessOptions,
): Promise<OctopusClientAccessStatus> {
  if (window.octopusTransport?.accessStatus) return window.octopusTransport.accessStatus();
  if (!isWebClient()) throw new Error("Client access host is unavailable");
  const response = await fetchWithRetry(
    `${ACCESS_URL}/status`,
    {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    },
    {
      timeoutMs: STATUS_TIMEOUT_MS,
      maxAttempts: 4,
      initialDelayMs: 600,
      maxDelayMs: 5_000,
      signal: options?.signal,
      onRetry: options?.onRetry,
    },
  );
  if (response.status === 401) {
    return {
      configured: true,
      labAvailable: false,
      authenticated: false,
      profile: null,
      expiresAt: null,
    };
  }
  const payload = await readJsonSafely(response);
  if (!response.ok) {
    throw new Error(typeof payload?.error === "string" ? payload.error : `Client access failed: HTTP ${response.status}`);
  }
  if (!payload) {
    throw new Error("Client access status returned an unreadable response.");
  }
  return payload as unknown as OctopusClientAccessStatus;
}

export async function configureClientAccess(password: string): Promise<OctopusClientAccessStatus> {
  if (window.octopusTransport?.configureAccess) return window.octopusTransport.configureAccess(password);
  return request("configure", "POST", { password });
}

export async function unlockClientAccess(password: string): Promise<OctopusClientAccessStatus> {
  if (window.octopusTransport?.unlockAccess) return window.octopusTransport.unlockAccess(password);
  return request("unlock", "POST", { password });
}

export async function signInAgent(credentials: {
  username: string;
  password: string;
  turnstileToken: string;
}): Promise<OctopusClientAccessStatus> {
  return request("unlock", "POST", credentials);
}

export async function readTouchIdStatus(): Promise<OctopusTouchIdStatus> {
  if (window.octopusTransport?.touchIdStatus) return window.octopusTransport.touchIdStatus();
  return { available: false, enrolled: false, prompted: false };
}

export async function setTouchIdEnabled(enabled: boolean): Promise<OctopusTouchIdStatus> {
  if (window.octopusTransport?.setTouchIdEnabled) return window.octopusTransport.setTouchIdEnabled(enabled);
  throw new Error("Touch ID is unavailable outside the Octopus desktop app.");
}

export async function unlockWithTouchId(): Promise<OctopusClientAccessStatus> {
  if (window.octopusTransport?.unlockWithTouchId) return window.octopusTransport.unlockWithTouchId();
  throw new Error("Touch ID is unavailable outside the Octopus desktop app.");
}

export async function lockClientAccess(): Promise<OctopusClientAccessStatus> {
  if (window.octopusTransport?.lockAccess) return window.octopusTransport.lockAccess();
  return request("lock", "POST", {});
}

export async function readClientLabAccess(): Promise<OctopusClientLabAccess> {
  if (window.octopusTransport?.labAccess) return window.octopusTransport.labAccess();
  return labRequest("lab-status", "GET");
}

export async function updateClientLabAccess(password: string): Promise<OctopusClientLabAccess> {
  if (window.octopusTransport?.updateLabAccess) return window.octopusTransport.updateLabAccess(password);
  return labRequest("lab-update", "POST", { password });
}

export async function readClientAccessDetails(): Promise<OctopusClientAccessDetails> {
  if (window.octopusTransport?.accessDetails) return window.octopusTransport.accessDetails();
  return detailsRequest("details", "GET");
}

export async function updateClientAdministratorAccess(
  request: OctopusAdministratorAccessUpdate,
): Promise<OctopusClientAccessDetails> {
  if (window.octopusTransport?.updateAdministratorAccess) {
    return window.octopusTransport.updateAdministratorAccess(request);
  }
  return detailsRequest("administrator-update", "POST", request);
}

async function request(
  operation: "status" | "configure" | "unlock" | "lock",
  method: "GET" | "POST",
  body?: Record<string, unknown>,
): Promise<OctopusClientAccessStatus> {
  if (!isWebClient()) throw new Error("Client access host is unavailable");
  const response = await fetchWithTimeout(`${ACCESS_URL}/${operation}`, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  }, MUTATION_TIMEOUT_MS);
  const payload = await readJsonSafely(response);
  if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : `Client access failed: HTTP ${response.status}`);
  if (!payload) throw new Error(`Client access failed: invalid response (HTTP ${response.status})`);
  return payload as unknown as OctopusClientAccessStatus;
}

async function labRequest(
  operation: "lab-status" | "lab-update",
  method: "GET" | "POST",
  body?: Record<string, unknown>,
): Promise<OctopusClientLabAccess> {
  if (!isWebClient()) throw new Error("Client access host is unavailable");
  const response = await fetchWithTimeout(`${ACCESS_URL}/${operation}`, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  }, MUTATION_TIMEOUT_MS);
  if (response.status === 401) notifyClientAccessUnauthorized();
  const payload = await readJsonSafely(response);
  if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : `Client access failed: HTTP ${response.status}`);
  if (!payload) throw new Error(`Client access failed: invalid response (HTTP ${response.status})`);
  return payload as unknown as OctopusClientLabAccess;
}

async function detailsRequest(
  operation: "details" | "administrator-update",
  method: "GET" | "POST",
  body?: OctopusAdministratorAccessUpdate,
): Promise<OctopusClientAccessDetails> {
  if (!isWebClient()) throw new Error("Client access host is unavailable");
  const response = await fetchWithTimeout(`${ACCESS_URL}/${operation}`, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  }, MUTATION_TIMEOUT_MS);
  if (response.status === 401) notifyClientAccessUnauthorized();
  const payload = await readJsonSafely(response);
  if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : `Client access failed: HTTP ${response.status}`);
  if (!payload) throw new Error(`Client access failed: invalid response (HTTP ${response.status})`);
  return payload as unknown as OctopusClientAccessDetails;
}
