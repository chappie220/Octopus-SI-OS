import type { OctopusTerminalSession, OctopusTerminalSessionHandlers } from "./OctopusTerminal";
import type {
  OctopusProcessViewerActionRequest,
  OctopusProcessViewerEvent,
  OctopusProcessViewerState,
} from "../../electron";

import { backoffDelayMs } from "../../resilientTransport";

export type WebSocketTerminalState = {
  detail: string;
  state: "connecting" | "connected" | "disconnected" | "failed";
};

const WS_CONNECT_TIMEOUT_MS = 12_000;
const WS_RECONNECT_INITIAL_MS = 1_000;
const WS_RECONNECT_MAX_MS = 15_000;

export function createWebSocketTerminalSession(
  socketUrl: string,
  onState: (state: WebSocketTerminalState) => void,
): OctopusTerminalSession {
  let socket: WebSocket | null = null;
  let handlers: OctopusTerminalSessionHandlers | null = null;
  let disposed = false;
  let openedOnce = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let connectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  const update = (state: WebSocketTerminalState) => {
    if (!disposed) onState(state);
  };

  const clearTimers = () => {
    if (reconnectTimer !== null) {
      globalThis.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (connectTimer !== null) {
      globalThis.clearTimeout(connectTimer);
      connectTimer = null;
    }
  };

  const scheduleReconnect = (immediate = false) => {
    if (disposed || !openedOnce) return;
    clearTimers();
    reconnectAttempt += 1;
    const delayMs = immediate ? 0 : backoffDelayMs(reconnectAttempt, WS_RECONNECT_INITIAL_MS, WS_RECONNECT_MAX_MS);
    update({
      detail: `Reconnecting terminal (attempt ${reconnectAttempt})…`,
      state: "connecting",
    });
    reconnectTimer = globalThis.setTimeout(() => {
      reconnectTimer = null;
      connectSocket();
    }, delayMs);
  };

  const onOnline = () => {
    if (disposed || !openedOnce) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      reconnectAttempt = 0;
      scheduleReconnect(true);
    }
  };

  const connectSocket = (onInitialSettle?: { resolve: () => void; reject: (error: Error) => void }) => {
    if (disposed) return;
    clearTimers();
    let settled = false;
    let next: WebSocket;
    try {
      next = new WebSocket(socketUrl);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (openedOnce) {
        scheduleReconnect();
      } else {
        update({ detail, state: "failed" });
        onInitialSettle?.reject(error instanceof Error ? error : new Error(detail));
      }
      return;
    }
    socket = next;
    next.binaryType = "arraybuffer";

    connectTimer = globalThis.setTimeout(() => {
      connectTimer = null;
      if (disposed || socket !== next || next.readyState === WebSocket.OPEN) return;
      try { next.close(); } catch {}
    }, WS_CONNECT_TIMEOUT_MS);

    next.addEventListener("open", () => {
      if (disposed || socket !== next) return;
      if (connectTimer !== null) {
        globalThis.clearTimeout(connectTimer);
        connectTimer = null;
      }
      openedOnce = true;
      reconnectAttempt = 0;
      update({ detail: "Terminal connected", state: "connected" });
      if (!settled) {
        settled = true;
        onInitialSettle?.resolve();
      }
    });

    next.addEventListener("message", (event) => {
      if (disposed || socket !== next) return;
      if (typeof event.data === "string") handlers?.onData(event.data);
      else if (event.data instanceof ArrayBuffer) handlers?.onData(new TextDecoder().decode(event.data));
    });

    next.addEventListener("error", () => {
      if (disposed || socket !== next) return;
      try { next.close(); } catch {}
    });

    next.addEventListener("close", (event) => {
      if (disposed || socket !== next) return;
      if (connectTimer !== null) {
        globalThis.clearTimeout(connectTimer);
        connectTimer = null;
      }
      socket = null;
      if (event.code === 1000) {
        update({ detail: event.reason || "The terminal socket closed.", state: "disconnected" });
        return;
      }
      if (openedOnce) {
        scheduleReconnect();
        return;
      }
      const detail = "The projected terminal socket could not be reached.";
      update({ detail, state: "failed" });
      if (!settled) {
        settled = true;
        onInitialSettle?.reject(new Error(detail));
      }
    });
  };

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("online", onOnline);
  }

  return {
    open() {
      if (disposed) return Promise.reject(new Error("The terminal session is closed."));
      if (socket) return Promise.reject(new Error("The terminal session is already open."));
      update({ detail: "Opening the projected terminal socket…", state: "connecting" });
      return new Promise<void>((resolve, reject) => {
        connectSocket({ resolve, reject });
      });
    },
    write(data) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(data);
    },
    resize() {},
    subscribe(next) {
      handlers = next;
      return () => {
        if (handlers === next) handlers = null;
        disposed = true;
        clearTimers();
        if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
          window.removeEventListener("online", onOnline);
        }
        if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "surface closed");
        socket = null;
      };
    },
  };
}

export function createTranscriptTerminalSession(content: string): OctopusTerminalSession {
  let handlers: OctopusTerminalSessionHandlers | null = null;
  return {
    async open() {
      handlers?.onInitLog(content || "\u001b[2mNo output yet\u001b[0m");
    },
    write() {},
    resize() {},
    subscribe(next) {
      handlers = next;
      return () => {
        if (handlers === next) handlers = null;
      };
    },
  };
}

export type ProcessViewerTerminalState = {
  sessionId: string;
  state: OctopusProcessViewerState;
};

export type ProcessViewerTerminalSession = OctopusTerminalSession & {
  interrupt(): void;
  terminate(): void;
  restart(): void;
  startNewShell(): void;
};

type ProcessViewerCommand =
  | { action: "write"; data: string }
  | { action: "resize"; cols: number; rows: number }
  | { action: "interrupt" | "terminate" | "restart" | "start_new_shell" };

export function createProcessViewerTerminalSession(
  workerEnvironmentId: string,
  surfaceId: string,
  onState: (state: ProcessViewerTerminalState | null, error?: string) => void,
): ProcessViewerTerminalSession {
  let handlers: OctopusTerminalSessionHandlers | null = null;
  let snapshot: ProcessViewerTerminalState | null = null;
  const bufferedOutput: string[] = [];
  const earlyEvents: OctopusProcessViewerEvent[] = [];
  let lastDimensions = { cols: 80, rows: 24 };
  let disposed = false;
  let unsubscribe: (() => void) | null = null;

  const perform = async (request: ProcessViewerCommand): Promise<boolean> => {
    if (!snapshot || disposed || !window.octopusTransport) return false;
    try {
      const outcome = await window.octopusTransport.processViewerAction({
        ...request,
        sessionId: snapshot.sessionId,
      } as OctopusProcessViewerActionRequest);
      if (!disposed && snapshot) {
        snapshot = { ...snapshot, state: outcome.state };
        onState(snapshot);
      }
      return true;
    } catch (error) {
      onState(snapshot, error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  return {
    async open(dimensions) {
      lastDimensions = { ...dimensions };
      const transport = window.octopusTransport;
      if (!transport) throw new Error("Process viewer bridge is unavailable.");
      unsubscribe = transport.onProcessViewerEvent((message) => {
        if (disposed) return;
        if (!snapshot) {
          earlyEvents.push(message);
          return;
        }
        if (message.sessionId !== snapshot.sessionId) return;
        deliverProcessViewerEvent(message, handlers, bufferedOutput, snapshot, (next) => {
          snapshot = next;
          onState(next);
        }, (error) => onState(snapshot, error));
      });
      const opened = await transport.openProcessViewer({ surfaceId, workerEnvironmentId });
      if (disposed) {
        await transport.closeProcessViewer({ sessionId: opened.sessionId }).catch(() => undefined);
        return;
      }
      snapshot = opened;
      onState(snapshot);
      handlers?.onInitLog("");
      for (const message of earlyEvents.splice(0)) {
        if (message.sessionId !== opened.sessionId) continue;
        deliverProcessViewerEvent(message, handlers, bufferedOutput, snapshot, (next) => {
          snapshot = next;
          onState(next);
        }, (error) => onState(snapshot, error));
      }
      if (snapshot.state.tty) void perform({ action: "resize", ...dimensions });
    },
    write(data) {
      void perform({ action: "write", data });
    },
    resize(dimensions) {
      lastDimensions = { ...dimensions };
      if (snapshot?.state.tty) void perform({ action: "resize", ...dimensions });
    },
    interrupt() {
      void perform({ action: "interrupt" });
    },
    terminate() {
      void perform({ action: "terminate" });
    },
    restart() {
      void perform({ action: "restart" }).then((started) => {
        if (started && snapshot?.state.tty) void perform({ action: "resize", ...lastDimensions });
      });
    },
    startNewShell() {
      void perform({ action: "start_new_shell" }).then((started) => {
        if (started && snapshot?.state.tty) void perform({ action: "resize", ...lastDimensions });
      });
    },
    subscribe(next) {
      handlers = next;
      if (bufferedOutput.length) {
        next.onData(bufferedOutput.splice(0).join(""));
      }
      return () => {
        if (handlers === next) handlers = null;
        disposed = true;
        unsubscribe?.();
        unsubscribe = null;
        if (snapshot) void window.octopusTransport?.closeProcessViewer({ sessionId: snapshot.sessionId });
        snapshot = null;
      };
    },
  };
}

function deliverProcessViewerEvent(
  message: OctopusProcessViewerEvent,
  handlers: OctopusTerminalSessionHandlers | null,
  bufferedOutput: string[],
  snapshot: ProcessViewerTerminalState,
  update: (state: ProcessViewerTerminalState) => void,
  fail: (error: string) => void,
) {
  if (message.event.type === "output") {
    if (handlers) handlers.onData(message.event.data);
    else bufferedOutput.push(message.event.data);
  }
  if (message.event.type === "history_truncated") {
    const notice = "\r\n\u001b[2m… Earlier process output is no longer retained.\u001b[0m\r\n";
    if (handlers) handlers.onData(notice);
    else bufferedOutput.push(notice);
  }
  if (message.event.type === "reset") handlers?.onInitLog("");
  if (message.event.type === "state") {
    update({ ...snapshot, state: message.event.state });
  }
  if (message.event.type === "failure") fail(message.event.message);
}
