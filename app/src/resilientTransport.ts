export type FetchRetryInfo = {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
};

export type FetchWithRetryOptions = {
  timeoutMs?: number;
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  retryOnStatuses?: readonly number[];
  signal?: AbortSignal;
  onRetry?: (info: FetchRetryInfo) => void;
};

const DEFAULT_RETRYABLE_STATUSES: readonly number[] = [408, 429, 500, 502, 503, 504];

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function createTimeoutError(timeoutMs: number): Error {
  const error = new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
  error.name = "TimeoutError";
  return error;
}

export function backoffDelayMs(attempt: number, initialDelayMs: number, maxDelayMs: number): number {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(maxDelayMs, initialDelayMs * (2 ** exponent));
  const jitter = Math.round(base * (0.15 * Math.random()));
  return Math.min(maxDelayMs, base + jitter);
}

export function waitForRetryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }
  return new Promise((resolve, reject) => {
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const onOnline = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        window.removeEventListener("online", onOnline);
      }
    };
    const timer = globalThis.setTimeout(onDone, Math.max(0, delayMs));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("online", onOnline, { once: true });
    }
  });
}

function createAbortError(): Error {
  const error = new Error("The request was aborted.");
  error.name = "AbortError";
  return error;
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 8_000,
): Promise<Response> {
  const outerSignal = init.signal ?? undefined;
  if (outerSignal?.aborted) {
    throw createAbortError();
  }
  const controller = new AbortController();
  let timedOut = false;
  const onOuterAbort = () => controller.abort();
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(100, timeoutMs));
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw createTimeoutError(timeoutMs);
    if (outerSignal?.aborted) throw createAbortError();
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
  const initialDelayMs = options.initialDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  const retryableStatuses = new Set(options.retryOnStatuses ?? DEFAULT_RETRYABLE_STATUSES);
  const signal = options.signal ?? init.signal ?? undefined;

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw createAbortError();
    try {
      const response = await fetchWithTimeout(input, { ...init, signal }, timeoutMs);
      if (!retryableStatuses.has(response.status) || attempt >= maxAttempts) {
        return response;
      }
      const reason = `HTTP ${response.status}`;
      const delayMs = backoffDelayMs(attempt, initialDelayMs, maxDelayMs);
      options.onRetry?.({ attempt, maxAttempts, delayMs, reason });
      await waitForRetryDelay(delayMs, signal);
    } catch (error) {
      if (signal?.aborted) throw createAbortError();
      lastError = error;
      if (attempt >= maxAttempts) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      const delayMs = backoffDelayMs(attempt, initialDelayMs, maxDelayMs);
      options.onRetry?.({ attempt, maxAttempts, delayMs, reason });
      await waitForRetryDelay(delayMs, signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Request failed after retries");
}

export async function readJsonValueSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function readJsonSafely(response: Response): Promise<Record<string, unknown> | null> {
  const value = await readJsonValueSafely(response);
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const error = (payload as Record<string, unknown>).error;
  return typeof error === "string" && error.trim() ? error : null;
}

export type ReconnectingEventSourceOptions = {
  onMessage: (event: MessageEvent) => void;
  onOpen?: () => void;
  onReconnect?: () => void;
  onAuthError?: () => void;
  initialDelayMs?: number;
  maxDelayMs?: number;
  connectTimeoutMs?: number;
};

export function createReconnectingEventSource(
  url: string,
  options: ReconnectingEventSourceOptions,
): () => void {
  if (typeof EventSource !== "function") return () => {};
  const initialDelayMs = options.initialDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 15_000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 12_000;

  let disposed = false;
  let source: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let connectWatchdog: ReturnType<typeof globalThis.setTimeout> | null = null;
  let attempt = 0;
  let hasOpenedBefore = false;
  let consecutiveFailedOpens = 0;

  const clearTimers = () => {
    if (reconnectTimer !== null) {
      globalThis.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (connectWatchdog !== null) {
      globalThis.clearTimeout(connectWatchdog);
      connectWatchdog = null;
    }
  };

  const closeCurrent = () => {
    if (!source) return;
    source.onopen = null;
    source.onmessage = null;
    source.onerror = null;
    try {
      source.close();
    } catch {
      // Ignore browser EventSource close errors.
    }
    source = null;
  };

  const scheduleReconnect = (immediate = false) => {
    if (disposed) return;
    clearTimers();
    closeCurrent();
    attempt += 1;
    const delayMs = immediate ? 0 : backoffDelayMs(attempt, initialDelayMs, maxDelayMs);
    reconnectTimer = globalThis.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delayMs);
  };

  const connect = () => {
    if (disposed) return;
    clearTimers();
    closeCurrent();
    let next: EventSource;
    try {
      next = new EventSource(url);
    } catch {
      scheduleReconnect();
      return;
    }
    source = next;
    let openedThisAttempt = false;

    connectWatchdog = globalThis.setTimeout(() => {
      connectWatchdog = null;
      if (disposed || source !== next || openedThisAttempt) return;
      consecutiveFailedOpens += 1;
      scheduleReconnect();
    }, connectTimeoutMs);

    next.onopen = () => {
      if (disposed || source !== next) return;
      openedThisAttempt = true;
      if (connectWatchdog !== null) {
        globalThis.clearTimeout(connectWatchdog);
        connectWatchdog = null;
      }
      const wasReconnect = hasOpenedBefore;
      hasOpenedBefore = true;
      attempt = 0;
      consecutiveFailedOpens = 0;
      options.onOpen?.();
      if (wasReconnect) options.onReconnect?.();
    };

    next.onmessage = (event) => {
      if (disposed || source !== next) return;
      options.onMessage(event);
    };

    next.onerror = () => {
      if (disposed || source !== next) return;
      if (!openedThisAttempt) {
        consecutiveFailedOpens += 1;
        if (consecutiveFailedOpens >= 2) {
          options.onAuthError?.();
        }
      }
      scheduleReconnect();
    };
  };

  const onOnline = () => {
    if (disposed) return;
    if (!source || source.readyState !== EventSource.OPEN) {
      attempt = 0;
      scheduleReconnect(true);
    }
  };

  const onVisibilityChange = () => {
    if (disposed || typeof document === "undefined" || document.visibilityState !== "visible") return;
    if (!source || source.readyState !== EventSource.OPEN) {
      attempt = 0;
      scheduleReconnect(true);
    }
  };

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("online", onOnline);
  }
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  connect();

  return () => {
    disposed = true;
    clearTimers();
    closeCurrent();
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("online", onOnline);
    }
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}
