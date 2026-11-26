import { useCallback, useEffect, useRef, useState } from "react";
import * as clientAccess from "./clientAccess";
import type { OctopusClientAccessStatus } from "./electron";

const AUTO_RETRY_INTERVAL_MS = 5_000;

export function useClientAccess(initialAccess: OctopusClientAccessStatus | null = null) {
  const [access, updateAccess] = useState<OctopusClientAccessStatus | null>(initialAccess);
  const [accessError, setAccessError] = useState("");
  const [accessAttempt, setAccessAttempt] = useState(1);
  const [accessRetryReason, setAccessRetryReason] = useState("");
  const generation = useRef(0);
  const accessRef = useRef<OctopusClientAccessStatus | null>(initialAccess);
  const activeAbort = useRef<AbortController | null>(null);
  const retryTimer = useRef<number | null>(null);

  const clearRetryTimer = useCallback(() => {
    if (retryTimer.current !== null) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }, []);

  const setAccess = useCallback((status: OctopusClientAccessStatus) => {
    generation.current += 1;
    activeAbort.current?.abort();
    activeAbort.current = null;
    clearRetryTimer();
    accessRef.current = status;
    updateAccess(status);
    setAccessError("");
    setAccessAttempt(1);
    setAccessRetryReason("");
  }, [clearRetryTimer]);

  const refresh = useCallback(async (options?: { forceResetError?: boolean }) => {
    clearRetryTimer();
    activeAbort.current?.abort();
    const abort = new AbortController();
    activeAbort.current = abort;
    const request = ++generation.current;
    if (options?.forceResetError) {
      setAccessError("");
      setAccessAttempt(1);
      setAccessRetryReason("");
    }
    try {
      const status = await clientAccess.readClientAccessStatus({
        signal: abort.signal,
        onRetry: (info) => {
          if (request !== generation.current) return;
          setAccessAttempt(info.attempt + 1);
          setAccessRetryReason(info.reason);
        },
      });
      if (request === generation.current) setAccess(status);
    } catch (error) {
      if (request !== generation.current || abort.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      // Preserve an already-loaded session across transient focus/visibility network blips.
      if (!accessRef.current) {
        updateAccess(null);
        setAccessError(message);
        retryTimer.current = window.setTimeout(() => {
          retryTimer.current = null;
          void refresh();
        }, AUTO_RETRY_INTERVAL_MS);
      }
    }
  }, [clearRetryTimer, setAccess]);

  const retryAccess = useCallback(() => {
    void refresh({ forceResetError: true });
  }, [refresh]);

  useEffect(() => {
    const onFocus = () => { void refresh(); };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const onOnline = () => { void refresh(); };
    const unsubscribeDesktop = window.octopusTransport?.onClientAccessLocked?.(setAccess);
    const unsubscribeUnauthorized = clientAccess.onClientAccessUnauthorized?.(() => {
      void refresh();
    });
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibility);
    void refresh();
    return () => {
      generation.current += 1;
      activeAbort.current?.abort();
      activeAbort.current = null;
      clearRetryTimer();
      unsubscribeDesktop?.();
      unsubscribeUnauthorized?.();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [clearRetryTimer, refresh, setAccess]);

  useEffect(() => {
    if (!access?.authenticated || !access.expiresAt) return;
    const expiresAt = Date.parse(access.expiresAt);
    if (!Number.isFinite(expiresAt)) return;
    const timer = window.setTimeout(() => { void refresh(); }, Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [access, refresh]);

  return { access, accessError, accessAttempt, accessRetryReason, retryAccess, setAccess };
}
