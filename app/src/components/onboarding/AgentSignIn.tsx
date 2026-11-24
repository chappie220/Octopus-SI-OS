import { useEffect, useRef, useState, type FormEvent } from "react";
import { signInAgent } from "../../clientAccess";
import type { OctopusClientAccessStatus } from "../../electron";

type Turnstile = {
  render(container: HTMLElement, options: {
    sitekey: string;
    action: string;
    size: "flexible" | "compact";
    retry: "never";
    "response-field": false;
    callback: (token: string) => void;
    "expired-callback": () => void;
    "timeout-callback": () => void;
    "error-callback": () => boolean;
  }): string | undefined;
  reset(id: string): void;
  remove(id: string): void;
};

const turnstileWindow = () => window as Window & { turnstile?: Turnstile };
let turnstileScript: Promise<Turnstile> | undefined;

function loadTurnstile(): Promise<Turnstile> {
  const existing = turnstileWindow().turnstile;
  if (existing) return Promise.resolve(existing);
  turnstileScript ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    const fail = () => {
      window.clearTimeout(timer);
      script.remove();
      reject(new Error("Human verification could not load."));
    };
    const timer = window.setTimeout(fail, 12_000);
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onerror = fail;
    script.onload = () => {
      const api = turnstileWindow().turnstile;
      if (!api) return fail();
      window.clearTimeout(timer);
      resolve(api);
    };
    document.head.append(script);
  }).catch((error: unknown) => {
    turnstileScript = undefined;
    throw error;
  });
  return turnstileScript;
}

export function AgentSignIn({ onDone, siteKey }: {
  onDone: (status: OctopusClientAccessStatus) => void;
  siteKey?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<{ api: Turnstile; id: string } | null>(null);
  const submitting = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [widgetError, setWidgetError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!siteKey) return;
    let active = true;
    setLoading(true);
    setWidgetError("");
    setToken("");
    void loadTurnstile().then((api) => {
      if (!active || !container.current) return;
      const fail = () => {
        if (active) {
          setToken("");
          setWidgetError("Human verification could not complete. Try again.");
        }
      };
      const id = api.render(container.current, {
        sitekey: siteKey,
        action: "agent_login",
        size: container.current.clientWidth < 300 ? "compact" : "flexible",
        retry: "never",
        "response-field": false,
        callback: (value) => {
          if (!active) return;
          setWidgetError("");
          setToken(value);
        },
        "expired-callback": () => { if (active) setToken(""); },
        "timeout-callback": fail,
        "error-callback": () => { fail(); return true; },
      });
      if (id === undefined) throw new Error("Human verification could not start.");
      widget.current = { api, id };
      setLoading(false);
    }).catch(() => {
      if (!active) return;
      setLoading(false);
      setWidgetError("Human verification could not load. Try again.");
    });
    return () => {
      active = false;
      if (widget.current) widget.current.api.remove(widget.current.id);
      widget.current = null;
    };
  }, [siteKey, attempt]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !token) return;
    const data = new FormData(event.currentTarget);
    const username = String(data.get("username") ?? "").trim();
    const password = String(data.get("password") ?? "");
    if (!username || !password) {
      setSubmitError("Enter your username and password.");
      return;
    }
    submitting.current = true;
    setBusy(true);
    setSubmitError("");
    setToken("");
    try {
      onDone(await signInAgent({ username, password, turnstileToken: token }));
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Sign-in failed.");
      setToken("");
      if (widget.current) widget.current.api.reset(widget.current.id);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <main className="welcome welcome-agent" aria-labelledby="agent-sign-in-title">
      <header className="welcome-top">
        <div className="welcome-brand">
          <img className="welcome-brand-mark" src="./octopus-logo.png" alt="" />
          <span className="welcome-brand-name">Octopus&nbsp;OS</span>
        </div>
      </header>
      <div className="welcome-stage">
        <form className="welcome-lock-form welcome-agent-form" method="post" onSubmit={(event) => { void submit(event); }}>
          <h1 id="agent-sign-in-title" className="welcome-title">Sign in to Octopus Agent</h1>
          <label>
            Username
            <span className="welcome-lock-row">
              <input className="welcome-lock-input" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={128} required autoFocus />
            </span>
          </label>
          <label>
            Password
            <span className="welcome-lock-row">
              <input className="welcome-lock-input" name="password" type="password" autoComplete="current-password" maxLength={16_384} required />
            </span>
          </label>
          <div ref={container} className="welcome-agent-challenge" aria-label="Cloudflare human verification" />
          {siteKey && loading && <p className="welcome-body" role="status">Loading human verification…</p>}
          {!siteKey && <p className="welcome-lock-error" role="alert">Human verification is unavailable on this server.</p>}
          {widgetError && (
            <div>
              <p className="welcome-lock-error" role="alert">{widgetError}</p>
              <button className="welcome-lock-forgot" type="button" onClick={() => setAttempt((value) => value + 1)}>Retry verification</button>
            </div>
          )}
          {submitError && <p className="welcome-lock-error" role="alert">{submitError}</p>}
          <button className="welcome-lock-primary" type="submit" disabled={!token || busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}
