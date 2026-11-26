import React, { Suspense, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { applyAppearance } from "./appearance";
import { RendererFailureBoundary } from "./RendererFailureBoundary";
import { AgentSignIn } from "./components/onboarding/AgentSignIn";
import { OctopusLoadingState } from "./components/OctopusLoadingLogo";
import { isAgentWebClient } from "./webClient";
import { useClientAccess } from "./useClientAccess";
import { lazyWithRetry } from "./resilientTransport";
import type { OctopusClientAccessStatus } from "./electron";
import "./boot.css";

applyAppearance();

const windowTransport = window.octopusTransport;
if (windowTransport) {
  const applyWindowState = (state: { opaqueSurface: boolean; resizing: boolean }) => {
    document.documentElement.classList.toggle("electron-opaque", state.opaqueSurface);
    document.documentElement.classList.toggle("electron-window-resizing", state.resizing);
  };
  void windowTransport.windowState().then(applyWindowState);
  windowTransport.onWindowStateChanged(applyWindowState);
}

const LazyFullAppEntry = lazyWithRetry(() => import("./FullAppEntry"));

function AgentWebPreAuthGate({ onAuthenticated }: { onAuthenticated: (status: OctopusClientAccessStatus) => void }) {
  const { access, accessError, accessAttempt, accessRetryReason, retryAccess, setAccess } = useClientAccess();
  const [slowWait, setSlowWait] = useState(false);

  useEffect(() => {
    if (access?.authenticated) {
      onAuthenticated(access);
    }
  }, [access, onAuthenticated]);

  useEffect(() => {
    if (access || accessError) {
      setSlowWait(false);
      return;
    }
    const timer = window.setTimeout(() => setSlowWait(true), 3_000);
    return () => window.clearTimeout(timer);
  }, [access, accessError]);

  if (!access) {
    const connectingLabel = "Connecting to the Agent server";
    const connectingDetail = accessAttempt > 1
      ? `Reconnecting to the Agent server (attempt ${accessAttempt})${accessRetryReason ? ` · ${accessRetryReason}` : "…"}`
      : slowWait
        ? `${connectingLabel}…`
        : undefined;
    return (
      <main className="welcome">
        <div className="welcome-access-state" role={accessError ? "alert" : "status"}>
          {accessError ? (
            <>
              <strong>Unable to connect to the Agent server</strong>
              <span>{accessError}</span>
              <span>Retrying automatically when the connection recovers…</span>
              <div className="welcome-access-actions">
                <button onClick={retryAccess} type="button">Retry now</button>
                <button onClick={() => window.location.reload()} type="button">Reload</button>
              </div>
            </>
          ) : (
            <OctopusLoadingState
              actionLabel={accessAttempt > 1 || slowWait ? "Retry now" : undefined}
              className="app-loading-state"
              detail={connectingDetail}
              label={connectingLabel}
              onAction={accessAttempt > 1 || slowWait ? retryAccess : undefined}
            />
          )}
        </div>
      </main>
    );
  }

  if (!access.authenticated) {
    return (
      <AgentSignIn
        siteKey={access.turnstileSiteKey}
        onDone={(next) => {
          setAccess(next);
          if (next.authenticated) onAuthenticated(next);
        }}
      />
    );
  }

  return (
    <OctopusLoadingState
      className="app-loading-state"
      detail="Loading Octopus workspace…"
      label="Loading Octopus workspace"
    />
  );
}

export function BootRoot() {
  const [authenticatedAccess, setAuthenticatedAccess] = useState<OctopusClientAccessStatus | null>(null);
  const agentWebClient = isAgentWebClient();

  if (agentWebClient && !authenticatedAccess) {
    return <AgentWebPreAuthGate onAuthenticated={setAuthenticatedAccess} />;
  }

  return (
    <Suspense
      fallback={
        <OctopusLoadingState
          className="app-loading-state"
          detail={agentWebClient ? "Loading Octopus workspace…" : undefined}
          label={agentWebClient ? "Loading Octopus workspace" : "Opening Octopus"}
        />
      }
    >
      <LazyFullAppEntry initialAccess={authenticatedAccess} />
    </Suspense>
  );
}

(window as Window & { __octopusBootMounted?: boolean }).__octopusBootMounted = true;
try {
  window.sessionStorage.removeItem("octopus_boot_retries");
} catch {
  // Ignore unavailable sessionStorage in restricted browser contexts.
}

const rootElement = document.getElementById("root");
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <RendererFailureBoundary>
        <BootRoot />
      </RendererFailureBoundary>
    </React.StrictMode>,
  );
}
