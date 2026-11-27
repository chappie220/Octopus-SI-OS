import React from "react";
import { WorkerPoolContextProvider, useWorkerPool } from "@pierre/diffs/react";
import PierreDiffWorker from "@pierre/diffs/worker/worker.js?worker";
import { App } from "./App";
import { useAppearance } from "./appearance";
import { octopusDiffThemeName, registerOctopusDiffThemes } from "./components/settings/octopusDiffThemes";
import type { OctopusClientAccessStatus } from "./electron";
import "./foundation.css";
import "./owned-utilities.css";
import "./octopus-owned-components.css";
import "katex/dist/katex.min.css";
import "./styles.css";
import "./theme.css";
import "./shell.css";
import "@xterm/xterm/css/xterm.css";

const pierreThemeRegistrationKey = Symbol.for("octopus.diff-themes.registered");
const pierreThemeRegistry = globalThis as typeof globalThis & { [pierreThemeRegistrationKey]?: boolean };
if (!pierreThemeRegistry[pierreThemeRegistrationKey]) {
  registerOctopusDiffThemes();
  pierreThemeRegistry[pierreThemeRegistrationKey] = true;
}

const pierreWorkerPoolOptions = {
  workerFactory: () => new PierreDiffWorker(),
};

export default function FullAppEntry({ initialAccess = null }: { initialAccess?: OctopusClientAccessStatus | null }) {
  return (
    <PierreDiffWorkerProvider>
      <App initialAccess={initialAccess} />
    </PierreDiffWorkerProvider>
  );
}

function PierreDiffWorkerProvider({ children }: { children: React.ReactNode }) {
  const appearance = useAppearance();
  const theme = React.useMemo(() => ({
    dark: octopusDiffThemeName("dark", appearance.darkCodeTheme),
    light: octopusDiffThemeName("light", appearance.lightCodeTheme),
  }), [appearance.darkCodeTheme, appearance.lightCodeTheme]);
  const highlighterOptions = React.useMemo(() => ({ theme }), [theme]);
  return (
    <WorkerPoolContextProvider highlighterOptions={highlighterOptions} poolOptions={pierreWorkerPoolOptions}>
      <PierreDiffWorkerThemeSync theme={theme} />
      {children}
    </WorkerPoolContextProvider>
  );
}

function PierreDiffWorkerThemeSync({ theme }: { theme: { dark: string; light: string } }) {
  const pool = useWorkerPool();
  const [failure, setFailure] = React.useState<Error | null>(null);
  React.useEffect(() => {
    let active = true;
    setFailure(null);
    if (!pool) {
      setFailure(new Error("Pierre worker pool is unavailable."));
      return () => { active = false; };
    }
    void pool.setRenderOptions({ theme }).catch((error) => {
      if (active) setFailure(error instanceof Error ? error : new Error(String(error)));
    });
    return () => { active = false; };
  }, [pool, theme]);
  if (failure) throw failure;
  return null;
}
