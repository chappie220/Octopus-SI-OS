import { useCallback, useEffect, useState } from "react";
import { isAgentWebClient } from "./webClient";
import { notifyClientAccessUnauthorized } from "./clientAccess";
import { backoffDelayMs, fetchWithTimeout, readJsonSafely } from "./resilientTransport";
import type { OctopusClientAccessProfile, OctopusHomeStorageHealth, OctopusInterfaceFailure, OctopusRuntimeHostState } from "./electron";

export const RUNTIME_STATUS_RETRY_EVENT = "octopus:retry-runtime-status";
const RUNTIME_STATUS_TIMEOUT_MS = 8_000;
const RUNTIME_STATUS_POLL_MS = 3_000;

export type RuntimeClientState = OctopusRuntimeHostState & {
  available: boolean;
};

const EMPTY_STATE: RuntimeClientState = {
  phase: "probing",
  ready: false,
  available: true,
  ownership: "none",
  pid: null,
  home: "",
  sourceRegistry: "",
  runtimeBinary: "",
  repoRoot: "",
  launchCwd: "",
  launchCommand: "",
  launchEnv: {},
  endpoint: "",
  error: null,
  storageHealth: null,
  interfaceFailures: [],
  updatedAtMs: 0,
};

export function useRuntimeHost(profile?: OctopusClientAccessProfile | null) {
  const [state, setState] = useState<RuntimeClientState>(EMPTY_STATE);

  const applyHostState = useCallback((next: OctopusRuntimeHostState) => {
    setState((current) => ({ ...current, ...next, available: true }));
  }, []);

  const refreshObservation = useCallback(async () => {
    const bridge = window.octopusTransport;
    if (!bridge?.bootStatus) {
      setState({
        ...EMPTY_STATE,
        phase: "external_preview",
        ready: true,
        available: false,
      });
      return;
    }
    try {
      applyHostState(await bridge.bootStatus());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const accessRequired = /locked or expired|profile lab|primary Octopus window/i.test(message);
      setState((current) => ({
        ...current,
        phase: accessRequired ? "access_required" : "degraded",
        ready: false,
        available: true,
        error: message,
        updatedAtMs: Date.now(),
      }));
    }
  }, [applyHostState]);

  useEffect(() => {
    if (isAgentWebClient()) {
      if (profile !== "live") return;
      const abort = new AbortController();
      let timer: number | undefined;
      let inFlight = false;
      let consecutiveFailures = 0;
      let everReady = false;
      const schedule = (delayMs: number) => {
        if (abort.signal.aborted) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => { void poll(); }, delayMs);
      };
      const poll = async () => {
        if (abort.signal.aborted || inFlight) return;
        inFlight = true;
        try {
          const response = await fetchWithTimeout(
            "/__octopus/runtime-status",
            { signal: abort.signal, cache: "no-store", credentials: "same-origin" },
            RUNTIME_STATUS_TIMEOUT_MS,
          );
          if (response.status === 401) {
            notifyClientAccessUnauthorized();
            return;
          }
          const result = await readJsonSafely(response);
          if (!response.ok) {
            throw new Error(typeof result?.error === "string" ? result.error : `Runtime status failed: HTTP ${response.status}`);
          }
          if (!result) throw new Error("Runtime status returned an unreadable response.");
          consecutiveFailures = 0;
          if (result.ready === true) everReady = true;
          if (!abort.signal.aborted) setState({
            ...EMPTY_STATE,
            available: false,
            phase: typeof result.phase === "string" ? result.phase as OctopusRuntimeHostState["phase"] : "degraded",
            ready: Boolean(result.ready),
            home: typeof result.home === "string" ? result.home : "",
            error: typeof result.error === "string" ? result.error : null,
            storageHealth: (result.storageHealth as OctopusHomeStorageHealth | null) ?? null,
            interfaceFailures: Array.isArray(result.interfaceFailures) ? (result.interfaceFailures as OctopusInterfaceFailure[]) : [],
            updatedAtMs: Date.now(),
          });
          schedule(RUNTIME_STATUS_POLL_MS);
        } catch (error) {
          if (abort.signal.aborted) return;
          consecutiveFailures += 1;
          const message = error instanceof Error ? error.message : String(error);
          setState((previous) => {
            if (everReady && consecutiveFailures < 2) {
              return { ...previous, error: message, updatedAtMs: Date.now() };
            }
            return {
              ...previous,
              available: false,
              ready: false,
              phase: consecutiveFailures >= 2 ? "degraded" : previous.phase,
              error: message,
              updatedAtMs: Date.now(),
            };
          });
          schedule(backoffDelayMs(consecutiveFailures, 1_500, 6_000));
        } finally {
          inFlight = false;
        }
      };
      const triggerNow = () => {
        if (abort.signal.aborted) return;
        window.clearTimeout(timer);
        void poll();
      };
      const onVisibility = () => {
        if (document.visibilityState === "visible") triggerNow();
      };
      window.addEventListener("online", triggerNow);
      window.addEventListener(RUNTIME_STATUS_RETRY_EVENT, triggerNow);
      document.addEventListener("visibilitychange", onVisibility);
      void poll();
      return () => {
        abort.abort();
        window.clearTimeout(timer);
        window.removeEventListener("online", triggerNow);
        window.removeEventListener(RUNTIME_STATUS_RETRY_EVENT, triggerNow);
        document.removeEventListener("visibilitychange", onVisibility);
      };
    }
    const bridge = window.octopusTransport;
    if (!bridge?.bootStatus) {
      setState({ ...EMPTY_STATE, phase: "external_preview", ready: true, available: false });
      return;
    }
    const unsubscribe = bridge.onRuntimeHostState?.(applyHostState);
    void refreshObservation();
    return () => unsubscribe?.();
  }, [applyHostState, profile, refreshObservation]);

  return state;
}

export type RuntimeHostView = ReturnType<typeof useRuntimeHost>;

const EMPTY_HOME_HEALTH = { storageHealth: null, interfaceFailures: [] as OctopusInterfaceFailure[] };

export function useRuntimeHomeHealth(home: string, enabled: boolean): Pick<OctopusRuntimeHostState, "storageHealth" | "interfaceFailures"> {
  const [observation, setObservation] = useState<{ home: string; storageHealth: OctopusHomeStorageHealth | null; interfaceFailures: OctopusInterfaceFailure[] } | null>(null);
  useEffect(() => {
    const bridge = window.octopusTransport;
    if (!enabled || !home || !bridge?.bootStatus) return;
    let active = true;
    let observedEvent = false;
    const apply = (state: OctopusRuntimeHostState) => {
      if (active && state.home === home) setObservation({ home, storageHealth: state.storageHealth, interfaceFailures: state.interfaceFailures });
    };
    const unsubscribe = bridge.onRuntimeHostState?.((state) => { observedEvent = true; apply(state); });
    void bridge.bootStatus().then((state) => { if (!observedEvent) apply(state); }).catch(() => undefined);
    return () => { active = false; unsubscribe?.(); };
  }, [home, enabled]);
  return enabled && observation?.home === home ? observation : EMPTY_HOME_HEALTH;
}
