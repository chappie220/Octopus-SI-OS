import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import "./components/icon-glyphs/shell";
import { OperatorShell } from "./components/shell/OperatorShell";
import { WelcomeOverlay } from "./components/onboarding/WelcomeOverlay";
import { AgentSignIn } from "./components/onboarding/AgentSignIn";
import { PasswordGate } from "./components/onboarding/PasswordGate";
import { StateMorphDotCloud } from "./components/onboarding/MorphVideoDotCloud";
import { LaunchTerminal } from "./components/onboarding/LaunchTerminal";
import { WorkspaceSetupGate } from "./components/onboarding/WorkspaceSetupGate";
import { TrafficLights } from "./components/shell/TrafficLights";
import { OctopusLoadingState } from "./components/OctopusLoadingLogo";
import {
  completeOnboarding,
  recordOnboardingVisit,
  resetOnboardingState,
  type OnboardingState,
} from "./onboarding/onboardingStorage";
import { lockClientAccess, readTouchIdStatus, setTouchIdEnabled, unlockWithTouchId } from "./clientAccess";
import { useClientAccess } from "./useClientAccess";
import type { OctopusClientAccessStatus, OctopusTouchIdStatus } from "./electron";
import { appToast, AppToastViewport } from "./toasts";
import { ClientPreferencesProvider } from "./clientPreferences";
import { isAgentWebClient } from "./webClient";
import { RUNTIME_STATUS_RETRY_EVENT, useRuntimeHost } from "./runtimeHost";
import { MAIN_CLIENT_WINDOW_BOOTSTRAP } from "./shell/clientWindowModel";

const QuickTaskAccessUnavailable = lazy(() => import("./components/QuickTaskWindow").then((module) => ({ default: module.QuickTaskAccessUnavailable })));
const QuickTaskWindow = lazy(() => import("./components/QuickTaskWindow").then((module) => ({ default: module.QuickTaskWindow })));
const WorkerEnvironmentWindowAccessUnavailable = lazy(() => import("./components/worker-environment/WorkerEnvironmentWindow").then((module) => ({ default: module.WorkerEnvironmentWindowAccessUnavailable })));
const WorkerEnvironmentWindow = lazy(() => import("./components/worker-environment/WorkerEnvironmentWindow").then((module) => ({ default: module.WorkerEnvironmentWindow })));
const TaskMonitorAccessUnavailable = lazy(() => import("./components/chat/TaskMonitorWindow").then((module) => ({ default: module.TaskMonitorAccessUnavailable })));
const TaskMonitorWindow = lazy(() => import("./components/chat/TaskMonitorWindow").then((module) => ({ default: module.TaskMonitorWindow })));

let recordedOnboardingVisit: OnboardingState | null = null;
const LOCK_TOUCH_ID_FRAMES = ["./octopus-lock.png", "./octopus-fingerprint.png"];
const LOCK_TOUCH_ID_FRAME_SCALES = [1, 2 / 3];

export function App({ initialAccess = null }: { initialAccess?: OctopusClientAccessStatus | null } = {}) {
  const [onboardingState, setOnboardingState] = useState<OnboardingState>(() => initializeOnboarding());
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const { access, accessError, accessAttempt = 1, accessRetryReason = "", retryAccess, setAccess } = useClientAccess(initialAccess);
  const agentWebClient = isAgentWebClient();
  const runtimeHost = useRuntimeHost(access?.profile);
  const [slowAccessWait, setSlowAccessWait] = useState(false);

  useEffect(() => {
    if (access || accessError) {
      setSlowAccessWait(false);
      return;
    }
    const timer = window.setTimeout(() => setSlowAccessWait(true), 3_000);
    return () => window.clearTimeout(timer);
  }, [access, accessError]);
  const windowMode = useMemo(() => new URLSearchParams(window.location.search).get("window"), []);
  const clientWindow = useMemo(
    () => window.octopusTransport?.clientWindowBootstrap?.() ?? MAIN_CLIENT_WINDOW_BOOTSTRAP,
    [],
  );
  const primaryWindowControls = windowMode ? null : <TrafficLights />;
  const welcomeMode = useMemo(() => new URLSearchParams(window.location.search).get("welcome"), []);
  const showWelcome = !agentWebClient && !welcomeDismissed && (onboardingState.completed !== true || welcomeMode === "1");
  const localUnlockRequired = Boolean(access?.configured && !access.authenticated);
  const [runtimeHasBeenReady, setRuntimeHasBeenReady] = useState(runtimeHost.ready);
  const launchGate = !agentWebClient && access?.profile !== "lab"
    && runtimeHost.available
    && runtimeHost.phase !== "probing"
    && runtimeHost.phase !== "access_required"
    && !runtimeHost.ready
    && !runtimeHasBeenReady;
  const [launchVisible, setLaunchVisible] = useState(false);
  const launchedOnceRef = useRef(false);

  useEffect(() => {
    if (runtimeHost.ready) setRuntimeHasBeenReady(true);
  }, [runtimeHost.ready]);

  useEffect(() => {
    if (launchGate) setLaunchVisible(true);
  }, [launchGate]);

  if (!access) {
    const triggerAccessRetry = () => {
      if (retryAccess) retryAccess();
      else window.location.reload();
    };
    const connectingLabel = agentWebClient ? "Connecting to the Agent server" : "Connecting to the local client host";
    const connectingDetail = accessAttempt > 1
      ? `${agentWebClient ? "Reconnecting to the Agent server" : "Reconnecting to the local client host"} (attempt ${accessAttempt})${accessRetryReason ? ` · ${accessRetryReason}` : "…"}`
      : slowAccessWait
        ? `${connectingLabel}…`
        : undefined;
    return (
      <>
        {primaryWindowControls}
        <main className="welcome">
          <div className="welcome-access-state" role={accessError ? "alert" : "status"}>
            {accessError ? (
              <>
                <strong>{agentWebClient ? "Unable to connect to the Agent server" : "Client access host is unavailable"}</strong>
                <span>{accessError}</span>
                <span>Retrying automatically when the connection recovers…</span>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button onClick={triggerAccessRetry} type="button">Retry now</button>
                  <button onClick={() => window.location.reload()} type="button">Reload</button>
                </div>
              </>
            ) : (
              <OctopusLoadingState
                actionLabel={accessAttempt > 1 || slowAccessWait ? "Retry now" : undefined}
                className="app-loading-state"
                detail={connectingDetail}
                label={connectingLabel}
                onAction={accessAttempt > 1 || slowAccessWait ? triggerAccessRetry : undefined}
              />
            )}
          </div>
        </main>
        <AppToastViewport />
      </>
    );
  }

  if (!agentWebClient && windowMode === "quick-task") {
    if (!access.authenticated || !access.profile) return <Suspense fallback={null}><QuickTaskAccessUnavailable /></Suspense>;
    return (
      <Suspense fallback={null}>
        <ClientPreferencesProvider profile={access.profile}>
          <WorkspaceSetupGate accessProfile={access.profile} runtimeHome={runtimeHost.home}>
            <QuickTaskWindow accessProfile={access.profile} runtimeReady={runtimeHost.ready} runtimeHome={runtimeHost.home} />
          </WorkspaceSetupGate>
        </ClientPreferencesProvider>
        <AppToastViewport />
      </Suspense>
    );
  }

  if (!agentWebClient && windowMode === "worker-environment") {
    if (!access.authenticated || !access.profile) return <Suspense fallback={null}><WorkerEnvironmentWindowAccessUnavailable /></Suspense>;
    return (
      <Suspense fallback={null}>
        <ClientPreferencesProvider profile={access.profile}>
          <WorkspaceSetupGate accessProfile={access.profile} runtimeHome={runtimeHost.home}>
            <WorkerEnvironmentWindow accessProfile={access.profile} />
          </WorkspaceSetupGate>
        </ClientPreferencesProvider>
        <AppToastViewport />
      </Suspense>
    );
  }

  if (!agentWebClient && windowMode === "task-monitor") {
    if (!access.authenticated || !access.profile) return <Suspense fallback={null}><TaskMonitorAccessUnavailable /></Suspense>;
    return (
      <Suspense fallback={null}>
        <ClientPreferencesProvider profile={access.profile}>
          <WorkspaceSetupGate accessProfile={access.profile} runtimeHome={runtimeHost.home}>
            <TaskMonitorWindow accessProfile={access.profile} />
          </WorkspaceSetupGate>
        </ClientPreferencesProvider>
        <AppToastViewport />
      </Suspense>
    );
  }

  if (showWelcome) {
    return (
      <>
      {primaryWindowControls}
      <WelcomeOverlay
        visitCount={onboardingState.visitCount}
        onComplete={() => {
          setOnboardingState(completeOnboarding());
          setWelcomeDismissed(true);
        }}
      />
      <AppToastViewport />
      </>
    );
  }

  if (agentWebClient && !access.authenticated) {
    return <AgentSignIn siteKey={access.turnstileSiteKey} onDone={setAccess} />;
  }

  if (localUnlockRequired) {
    return <>{primaryWindowControls}<LockScreen mode="unlock" onUnlock={setAccess} /><AppToastViewport /></>;
  }

  if (!agentWebClient && access.profile !== "lab" && runtimeHost.available && runtimeHost.phase === "probing" && !runtimeHasBeenReady) {
    return <>{primaryWindowControls}<OctopusLoadingState className="app-loading-state" label="Opening Octopus" /><AppToastViewport /></>;
  }

  const launchOverlay = launchGate || launchVisible
    ? (
      <LaunchTerminal
        greeting={!launchedOnceRef.current}
        key="boot-launch-terminal"
        leaving={!launchGate}
        onExited={() => {
          launchedOnceRef.current = true;
          setLaunchVisible(false);
        }}
      />
    )
    : null;

  if (launchGate) {
    return <>{primaryWindowControls}{launchOverlay}<AppToastViewport /></>;
  }

  if (!access.authenticated || !access.profile) {
    return <>{primaryWindowControls}<LockScreen mode="set" onUnlock={setAccess} />{launchOverlay}<AppToastViewport /></>;
  }

  const logOut = () => void lockClientAccess().then(setAccess).catch((error) => {
    appToast.danger(error instanceof Error ? error.message : String(error));
  });
  if (agentWebClient && !runtimeHasBeenReady && !runtimeHost.ready) {
    const retryRuntime = () => {
      window.dispatchEvent(new Event(RUNTIME_STATUS_RETRY_EVENT));
    };
    return (
      <main className="welcome">
        <div className="welcome-access-state" role="status">
          {runtimeHost.phase === "probing" ? (
            <OctopusLoadingState
              actionLabel={runtimeHost.error ? "Retry now" : undefined}
              className="app-loading-state"
              detail={runtimeHost.error ? `Reconnecting to Agent runtime… (${runtimeHost.error})` : "Checking Agent runtime…"}
              label="Checking Agent runtime"
              onAction={runtimeHost.error ? retryRuntime : undefined}
            />
          ) : (
            <>
              <strong>{runtimeHost.phase === "setup_required" ? "Agent Home is not ready" : "Agent runtime is unavailable"}</strong>
              <span>{runtimeHost.error}</span>
              {runtimeHost.phase === "setup_required" && <span>Run <code>./octopus setup</code> on the server to configure this Home.</span>}
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button onClick={retryRuntime} type="button">Retry now</button>
                <button onClick={logOut} type="button">Sign out</button>
              </div>
            </>
          )}
        </div>
        <AppToastViewport />
      </main>
    );
  }

  const shell = (
    <OperatorShell
      accessProfile={access.profile}
      clientWindow={clientWindow}
      onLogOut={logOut}
      runtimeHost={runtimeHost}
    />
  );
  return (
    <>
      {primaryWindowControls}
      <ClientPreferencesProvider profile={access.profile}>
        {agentWebClient ? shell : (
          <WorkspaceSetupGate accessProfile={access.profile} runtimeHome={runtimeHost.home}>
            {shell}
          </WorkspaceSetupGate>
        )}
      </ClientPreferencesProvider>
      {launchOverlay}
      <AppToastViewport anchorToWorkspace />
    </>
  );
}

function LockScreen({ mode, onUnlock }: { mode: "set" | "unlock"; onUnlock: (status: OctopusClientAccessStatus) => void }) {
  const [touchId, setTouchId] = useState<OctopusTouchIdStatus | null>(null);
  const [pendingPasswordAccess, setPendingPasswordAccess] = useState<OctopusClientAccessStatus | null>(null);
  const [touchIdBusy, setTouchIdBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void readTouchIdStatus().then((status) => {
      if (active) setTouchId(status);
    }).catch((error) => {
      if (active) {
        setTouchId({ available: false, enrolled: false, prompted: false });
        appToast.danger(error instanceof Error ? error.message : String(error));
      }
    });
    return () => { active = false; };
  }, []);

  async function handlePasswordAccess(status: OctopusClientAccessStatus) {
    let current = touchId;
    try {
      current = await readTouchIdStatus();
      setTouchId(current);
    } catch {
      current = { available: false, enrolled: false, prompted: false };
      setTouchId(current);
    }
    if (status.profile === "live" && current.available && !current.enrolled && !current.prompted) {
      setPendingPasswordAccess(status);
      return;
    }
    onUnlock(status);
  }

  async function enableTouchId() {
    if (!pendingPasswordAccess || touchIdBusy) return;
    setTouchIdBusy(true);
    try {
      const status = await setTouchIdEnabled(true);
      setTouchId(status);
      if (!status.enrolled) throw new Error("Touch ID could not be enabled on this device.");
      onUnlock(pendingPasswordAccess);
    } catch (error) {
      appToast.danger(error instanceof Error ? error.message : String(error));
      try {
        const status = await readTouchIdStatus();
        setTouchId(status);
        if (status.prompted) onUnlock(pendingPasswordAccess);
      } catch {
        return;
      }
    } finally {
      setTouchIdBusy(false);
    }
  }

  async function declineTouchId() {
    if (!pendingPasswordAccess || touchIdBusy) return;
    setTouchIdBusy(true);
    try {
      setTouchId(await setTouchIdEnabled(false));
      onUnlock(pendingPasswordAccess);
    } catch (error) {
      appToast.danger(error instanceof Error ? error.message : String(error));
    } finally {
      setTouchIdBusy(false);
    }
  }

  async function useTouchId() {
    if (touchIdBusy) return;
    setTouchIdBusy(true);
    try {
      onUnlock(await unlockWithTouchId());
    } catch (error) {
      appToast.danger(error instanceof Error ? error.message : String(error));
    } finally {
      setTouchIdBusy(false);
    }
  }

  return (
    <main className="welcome" aria-labelledby="welcome-title">
      <header className="welcome-top">
        <div className="welcome-brand">
          <img className="welcome-brand-mark" src="./octopus-logo.png" alt="" />
          <span className="welcome-brand-name">Octopus&nbsp;OS</span>
        </div>
      </header>
      <div className="welcome-stage">
        <section className="welcome-lock">
          {pendingPasswordAccess ? (
            <div className="welcome-lock-form">
              <span className="welcome-tag">Touch ID</span>
              <h1 id="welcome-title" className="welcome-title">Use Touch ID next time?</h1>
              <p className="welcome-body">
                Keep the Administrator password as the fallback, and allow this Mac to unlock Octopus after a Touch ID check.
              </p>
              <div className="welcome-lock-actions welcome-lock-choice-actions">
                <button className="welcome-lock-primary welcome-touch-id-enable" type="button" onClick={() => void enableTouchId()} disabled={touchIdBusy}>
                  {touchIdBusy ? "Enabling…" : "Enable Touch ID"}
                </button>
                <button className="welcome-lock-forgot" type="button" onClick={() => void declineTouchId()} disabled={touchIdBusy}>
                  Not now
                </button>
              </div>
            </div>
          ) : (
            <PasswordGate
              mode={mode}
              onDone={(status) => { void handlePasswordAccess(status); }}
            />
          )}
          <div className="welcome-lock-art" aria-hidden="true">
            <StateMorphDotCloud
              srcs={LOCK_TOUCH_ID_FRAMES}
              active={Boolean(pendingPasswordAccess)}
              frameScales={LOCK_TOUCH_ID_FRAME_SCALES}
            />
          </div>
        </section>
        {!pendingPasswordAccess && mode === "unlock" && touchId?.available && touchId.enrolled ? (
          <button className="welcome-lock-forgot" type="button" onClick={() => void useTouchId()} disabled={touchIdBusy}>
            {touchIdBusy ? "Checking Touch ID…" : "Unlock with Touch ID"}
          </button>
        ) : null}
      </div>
    </main>
  );
}

function initializeOnboarding() {
  if (recordedOnboardingVisit) return recordedOnboardingVisit;
  const welcomeMode = new URLSearchParams(window.location.search).get("welcome");
  if (welcomeMode === "reset") {
    resetOnboardingState();
  }
  recordedOnboardingVisit = recordOnboardingVisit();
  return recordedOnboardingVisit;
}
