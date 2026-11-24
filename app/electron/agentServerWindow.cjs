const { createHash } = require("node:crypto");
const path = require("node:path");
const { TURNSTILE_ORIGIN } = require("./turnstile.cjs");
const { app, BrowserWindow, dialog, ipcMain, Menu, session } = require("electron");

const CONNECT_CHANNEL = "octopus:connect-agent-server";
let connectionWindow;
let remoteWindow;

function agentServerOrigin(value) {
  let address;
  try { address = new URL(String(value ?? "").trim()); }
  catch { throw new Error("Enter a valid Agent server address, such as https://agent.example.com."); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(address.hostname);
  if ((address.protocol !== "https:" && !(address.protocol === "http:" && loopback))
    || address.username || address.password || address.pathname !== "/" || address.search || address.hash) {
    throw new Error("Enter an HTTPS server origin, or a loopback HTTP address for a local server.");
  }
  return address.origin;
}

async function openAgentServer(value) {
  const origin = agentServerOrigin(value);
  const partition = `persist:octopus-agent-${createHash("sha256").update(origin).digest("hex")}`;
  const remoteSession = session.fromPartition(partition);
  remoteSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  remoteSession.setPermissionCheckHandler(() => false);
  const window = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 360,
    minHeight: 480,
    show: false,
    title: "Octopus Agent",
    webPreferences: { session: remoteSession, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const enforceOrigin = (event) => {
    const destination = new URL(event.url).origin;
    if (destination !== origin && (event.isMainFrame || destination !== TURNSTILE_ORIGIN)) event.preventDefault();
  };
  window.webContents.on("will-navigate", enforceOrigin);
  window.webContents.on("will-redirect", enforceOrigin);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.once("closed", () => {
    if (remoteWindow === window) remoteWindow = null;
  });
  try {
    await window.loadURL(origin);
    if (window.isDestroyed()) throw new Error("The Agent window was closed.");
    remoteWindow = window;
    window.show();
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
}

function showAgentServerConnection() {
  if (connectionWindow && !connectionWindow.isDestroyed()) {
    connectionWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    width: 480,
    height: 276,
    title: "Connect to Agent Server",
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "agentServerPreload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  connectionWindow = window;
  ipcMain.handle(CONNECT_CHANNEL, async (event, address) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error("The connection form must run in its own window.");
    }
    await openAgentServer(address);
    if (!window.isDestroyed()) window.close();
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.once("ready-to-show", () => window.show());
  window.once("closed", () => {
    ipcMain.removeHandler(CONNECT_CHANNEL);
    connectionWindow = null;
  });
  void window.loadFile(path.join(__dirname, "agentServerConnection.html"));
}

function startAgentDesktopClient(address) {
  let connecting = false;
  const open = () => {
    if (remoteWindow && !remoteWindow.isDestroyed()) {
      remoteWindow.show();
      remoteWindow.focus();
      return;
    }
    if (connecting) return;
    connecting = true;
    void openAgentServer(address).catch(async (error) => {
      showAgentServerConnection();
      await dialog.showMessageBox(connectionWindow, {
        type: "error",
        message: "Could not connect to the Agent server.",
        detail: error.message,
      });
    }).finally(() => { connecting = false; });
  };
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => { void app.whenReady().then(open); });
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) open(); });
  app.on("window-all-closed", () => { if (!connecting && process.platform !== "darwin") app.quit(); });
  void app.whenReady().then(() => {
    app.setName("Octopus");
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
      { label: "File", submenu: [
        { label: "Connect to Agent Server…", click: showAgentServerConnection },
        { role: "close" },
      ] },
      { role: "editMenu" },
      { role: "viewMenu" },
    ]));
    open();
  });
}

module.exports = { showAgentServerConnection, startAgentDesktopClient };
