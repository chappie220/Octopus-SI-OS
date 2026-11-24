import { useCallback, useEffect, useState } from "react";
import { isAgentWebClient } from "./webClient";
import type { OctopusClientAccessProfile, OctopusHomeStorageHealth, OctopusInterfaceFailure, OctopusRuntimeHostState } from "./electron";

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
      let timer: number;
      const poll = async () => {
        try {
          const response = await fetch("/__octopus/runtime-status", { signal: abort.signal });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || `Runtime status failed: HTTP ${response.status}`);
          if (!abort.signal.aborted) setState({
            ...EMPTY_STATE,
            available: false,
            phase: result.phase,
            ready: result.ready,
            home: result.home,
            error: result.error,
            storageHealth: result.storageHealth,
            interfaceFailures: result.interfaceFailures,
          });
        } catch (error) {
          if (!abort.signal.aborted) setState((previous) => ({
            ...previous, available: false, ready: false, phase: "degraded",
            error: error instanceof Error ? error.message : String(error),
          }));
        } finally {
          if (!abort.signal.aborted) timer = window.setTimeout(() => { void poll(); }, 3_000);
        }
      };
      void poll();
      return () => { abort.abort(); window.clearTimeout(timer); };
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
