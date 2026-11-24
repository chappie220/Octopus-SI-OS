const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const COOKIE_NAME = "octopus_client_access";
const APP_DIR = path.resolve(__dirname, "..");
const WEB_WORKSPACE_ACTIONS = new Set([
  "create_project", "delete_project", "update_project_presentation",
  "create_agent_template", "configure_agent_template", "delete_agent_template",
  "rename_task", "set_task_archived", "delete_task",
]);

function createClientHttpApi({ route, environment, agentLogin, secure = false }) {
  const { createClientAccessController } = require("./clientAccess.cjs");
  const { createClientProjectionStore } = require("./clientDataSource.cjs");
  const { projectionReadRequest } = require("./projectionReadContract.cjs");
  const { createClientSurfaceDocumentStore, filterClientSurfaceSnapshot } = require("./surfaceDocuments.cjs");
  const repoRoot = path.dirname(APP_DIR);
  const octopusHome = environment?.home ?? ((process.env.OCTOPUS_HOME ?? "").trim() || path.join(os.homedir(), ".octopus"));
  const registryRoot = path.join(octopusHome, "registry");
  const installationRoot = environment?.installationRoot ?? configuredAbsolutePath(process.env.OCTOPUS_INSTALLATION_ROOT, repoRoot, "OCTOPUS_INSTALLATION_ROOT");
  const packageRoots = environment?.packageRoots ?? {
    sourceRegistryRoot: configuredAbsolutePath(process.env.OCTOPUS_LOCAL_PACKAGE_REGISTRY, path.join(repoRoot, "registry"), "OCTOPUS_LOCAL_PACKAGE_REGISTRY"),
    activeRegistryRoot: registryRoot,
    libraryRoot: configuredAbsolutePath(process.env.OCTOPUS_LOCAL_PACKAGE_LIBRARY, path.join(APP_DIR, "distribution", "local-packages"), "OCTOPUS_LOCAL_PACKAGE_LIBRARY"),
    stateRoot: path.join(octopusHome, "client", "package-state"),
  };
  const {
    assertOperatorChatArtifactBatch,
    createOperatorChatClientLoader,
    isOperatorChatClientInterfaceCandidate,
  } = require("./operatorChatClientContract.cjs");
  const operatorChatClientLoader = createOperatorChatClientLoader({
    packageRoots: () => packageRoots,
    clientPath: () => path.join(registryRoot, "interface", "world_operator_chat", "client.cjs"),
  });
  const access = createClientAccessController(environment ? {
    administratorSecret: process.env.OCTOPUS_CLIENT_ADMIN_SECRET,
    administratorUsername: agentLogin.administratorUsername,
    openAccess: false,
    labEnabled: false,
    labSecret: "",
  } : {});
  const stores = new Map();
  const projectionClients = new Map([
    ["live", new Map()],
    ["lab", new Map()],
  ]);
  const surfaceClients = new Map();
  let surfaceStore = null;
  let artifactStreamStore = null;
  let workspaceClient = null;
  const getWorkspaceClient = () => {
    if (!workspaceClient) {
      const { createClient } = require("../cli/client.cjs");
      workspaceClient = createClient(environment, { loader: operatorChatClientLoader });
    }
    return workspaceClient;
  };
  const clientArtifactsRoot = (interfaceId) => path.join(
    octopusHome,
    "interface-hand-in",
    interfaceId,
    "client",
  );
  const authorizeClientInterfaceArtifactSubmission = async (request) => {
    if (!isOperatorChatClientInterfaceCandidate(request?.interfaceId)) return;
    const { assertGenericOperatorChatArtifactAllowed } = await operatorChatClientLoader.load();
    await assertGenericOperatorChatArtifactAllowed(request);
  };

  const getStore = (profile) => {
    let store = stores.get(profile);
    if (store) return store;
    const onChange = (generation, kind) => {
      publish(projectionClients.get(profile), {
        generation,
        kind: ["ledger", "runs", "files"].includes(kind) ? kind : "structure",
      });
    };
    if (environment && profile === "live") {
      const { projectionStore } = require("../cli/environment.cjs");
      store = projectionStore(environment, { onChange });
    } else {
      store = createClientProjectionStore(profile, {
        resolveRepoRoot: () => fsSync.existsSync(path.join(repoRoot, "registry", "interface")) ? repoRoot : "",
        octopusHome: () => octopusHome,
        onChange,
      });
    }
    stores.set(profile, store);
    return store;
  };

  const labFixturePath = path.join(__dirname, "fixtureProjection.cjs");
  const reloadFixture = () => {
    delete require.cache[require.resolve(labFixturePath)];
    stores.get("lab")?.close?.();
    stores.delete("lab");
    publish(projectionClients.get("lab"), { generation: Date.now() });
  };
  const getSurfaceStore = () => {
    if (surfaceStore) return surfaceStore;
    surfaceStore = createClientSurfaceDocumentStore({
      root: path.join(APP_DIR, "client-surfaces"),
      onChange: (generation) => {
        publish(surfaceClients, { generation });
      },
    });
    return surfaceStore;
  };

  const getArtifactStreamStore = () => {
    if (artifactStreamStore) return artifactStreamStore;
    const { createClientArtifactStreamStore } = require("./clientArtifacts.cjs");
    artifactStreamStore = createClientArtifactStreamStore({
      clientArtifactsRoot,
      projectionStore: () => getStore("live"),
      handInArtifact: deliverInterfaceArtifact,
      authorizeSubmission: authorizeClientInterfaceArtifactSubmission,
    });
    return artifactStreamStore;
  };

  route("/__octopus/access", (req, res) => {
    void handleAccess(req, res, access, secure, agentLogin);
  });

  let runtimeStatusInProgress;
  const readRuntimeStatus = () => {
    runtimeStatusInProgress ??= environment.status().finally(() => { runtimeStatusInProgress = undefined; });
    return runtimeStatusInProgress;
  };

  if (environment) {
    route("/__octopus/runtime-status", (req, res) => {
      void withAccess(req, res, access, ["live"], async () => {
        if (req.method !== "GET") return sendJson(res, 405, { error: "runtime status requires GET" });
        const status = await readRuntimeStatus();
        sendJson(res, 200, {
          phase: status.runtimeReady && !status.workspaceConfigured ? "setup_required" : status.phase,
          ready: status.ready,
          home: status.home,
          error: status.reason,
          storageHealth: status.storageHealth,
          interfaceFailures: status.interfaceFailures,
        });
      });
    });

    route("/__octopus/workspace", (req, res) => {
      void withAccess(req, res, access, ["live"], async () => {
        if (req.method !== "POST") return sendJson(res, 405, { error: "workspace updates require POST" });
        const request = await readJson(req);
        if (!WEB_WORKSPACE_ACTIONS.has(request.action)) throw new Error("This workspace action is unavailable through the Agent server.");
        const result = await getWorkspaceClient().mutate(request);
        getStore("live").invalidate();
        sendJson(res, 200, result);
      });
    });
  }

  route("/__octopus/projection", (req, res) => {
    void withAccess(req, res, access, ["live", "lab"], async (session) => {
      if (req.method !== "POST") return sendJson(res, 405, { error: "projection reads require POST" });
      const request = await readJson(req);
      sendJson(res, 200, await getStore(session.profile).read(request));
    });
  });

  route("/__octopus/providers", (req, res) => {
    void withAccess(req, res, access, ["live", "lab"], async (session) => {
      if (req.method !== "GET") return sendJson(res, 405, { error: "providers require GET" });
      const providers = environment
        ? await getWorkspaceClient().catalogue()
        : (await getStore(session.profile).read(projectionReadRequest("projection.operator.providers.list"))).providers;
      sendJson(res, 200, {
        repoRoot: session.profile === "live" ? repoRoot : null,
        registryRoot: session.profile === "live" ? registryRoot : null,
        providers,
      });
    });
  });

  route("/__octopus/operator-chat-artifacts", (req, res) => {
    void withAccess(req, res, access, ["live"], async () => {
      if (req.method !== "POST") {
        return sendJson(res, 405, { error: "operator chat artifact reads require POST" });
      }
      const request = await readJson(req);
      const { readOperatorChatArtifacts } = await operatorChatClientLoader.load();
      const batch = await readOperatorChatArtifacts({ octopusHome: () => octopusHome, readArtifactPayload }, request);
      sendJson(res, 200, assertOperatorChatArtifactBatch(batch));
    });
  });

  route("/__octopus/operator-turn-control", (req, res) => {
    void withAccess(req, res, access, ["live"], async () => {
      if (req.method !== "POST") {
        return sendJson(res, 405, { error: "operator turn control requires POST" });
      }
      const request = await readJson(req);
      const { submitOperatorTurnControl } = await operatorChatClientLoader.load();
      sendJson(res, 200, await captureArtifactDelivery((deliver) => submitOperatorTurnControl({
        octopusHome: () => octopusHome,
        clientArtifactsRoot,
        handInArtifact: (input) => deliver({ ...input, octopusHome, ...(environment ? { timeoutMs: 120_000 } : {}) }),
      }, request)));
    });
  });

  route("/__octopus/validate-endpoint", (req, res) => {
    void withAccess(req, res, access, ["live"], async () => {
      if (req.method !== "POST") return sendJson(res, 405, { valid: false, endpoint: "", error: "endpoint validation requires POST" });
      const request = await readJson(req);
      const endpoint = typeof request?.endpoint === "string" ? request.endpoint : "";
      const { validateArtifactEndpoint } = require("./interfaceTransport.cjs");
      const normalized = environment ? "unix://" : validateArtifactEndpoint(endpoint, octopusHome, "world_operator_chat");
      sendJson(res, 200, { valid: true, endpoint: normalized });
    });
  });

  const { captureArtifactDelivery, defaultInterfaceEndpoint, handInArtifact, normalizedEndpoint } = require("./interfaceTransport.cjs");
  const { readContentAddressedArtifactPayload, payloadArtifactBindings, prepareContentAddressedPayloadBindings } = require("./contentAddressedArtifact.cjs");
  const blobsRoot = path.join(octopusHome, "ledger", "blobs");
  const readArtifactPayload = (input) => readContentAddressedArtifactPayload({
    ...input, blobsRoot,
    maxPayloadBytes: input.label === "turn.stream" ? 256 * 1024 * 1024 : undefined,
  });
  const defaultChatEndpoint = normalizedEndpoint(process.env.OCTOPUS_APP_LISTEN, octopusHome, "world_operator_chat");
  const deliverArtifact = (input) => handInArtifact({ ...input, octopusHome });
  const deliverInterfaceArtifact = (input) => {
    if (!environment) return deliverArtifact(input);
    const endpoint = defaultInterfaceEndpoint(octopusHome, input.interfaceId);
    if (input.endpoint !== endpoint) throw new Error("Artifact target is outside the server's runtime sockets.");
    return deliverArtifact({ ...input, timeoutMs: 45_000 });
  };
  const deliverOperatorTurn = (input) => deliverArtifact({
    ...input,
    endpoint: environment
      ? defaultInterfaceEndpoint(octopusHome, input.interfaceId)
      : input.endpoint && input.endpoint.trim() !== "unix://" ? input.endpoint : defaultChatEndpoint,
  });

  for (const [routeName, steer] of [["submit", false], ["chat-steer", true]]) {
    route(`/__octopus/${routeName}`, (req, res) => {
      void withAccess(req, res, access, ["live", "lab"], async (session) => {
        if (req.method !== "POST") return sendJson(res, 405, { error: `${routeName} requires POST` });
        const request = await readJson(req);
        if (session.profile === "lab") {
          const store = getStore("lab");
          return sendJson(res, 200, steer ? await store.submitChatSteer(request) : await store.submitChatTurn(request));
        }
        if (request.attachments?.length) throw new Error("Attachment submission requires the desktop attachment staging host.");
        let submissionStarted = false;
        try {
          if (environment) {
            const status = await readRuntimeStatus();
            if (!status.ready) throw Object.assign(new Error("The Agent runtime is unavailable."), { deliveryState: "not_sent" });
            if (status.storageHealth?.status === "blocked") {
              throw Object.assign(new Error(status.storageHealth.message), { code: "home_storage_blocked" });
            }
          }
          const { submitOperatorTurn } = await operatorChatClientLoader.load();
          const selectedPayloads = request.payloadArtifactBindings === undefined
            ? undefined : payloadArtifactBindings(request.payloadArtifactBindings);
          submissionStarted = true;
          const result = await submitOperatorTurn({
            clientArtifactsRoot,
            octopusHome: () => octopusHome,
            installationRoot: () => installationRoot,
            registryRoot: () => registryRoot,
            handInArtifact: deliverOperatorTurn,
            readArtifactPayload,
            readProjection: (method, params) => getStore("live").read(projectionReadRequest(method, params)),
            preparePayloadArtifactBindings: ({ payloadArtifactBindings: selectedBase }) => prepareContentAddressedPayloadBindings({
              blobsRoot, attachments: [], payloadArtifactBindings: selectedBase,
              revalidate: () => access.requireSession(readCookie(req, COOKIE_NAME), ["live"]),
            }),
          }, {
            ...request,
            ...(environment ? { endpoint: "unix://", timeoutMs: 120_000 } : {}),
            ...(selectedPayloads === undefined ? {} : { payloadArtifactBindings: selectedPayloads }),
            attachments: [],
          });
          sendJson(res, 200, steer ? {
            interfaceId: result.chatInterfaceId,
            runId: result.runId,
            label: result.label,
            messageId: result.messageId,
            attachmentCount: result.attachmentCount,
            contentHash: result.contentHash,
            messageRecovered: result.messageRecovered,
            verdict: result.messageVerdict,
          } : result);
        } catch (error) {
          const { operatorChatSubmitFailure } = require("./operatorChatSubmitResult.cjs");
          console.error(error);
          sendJson(res, 503, operatorChatSubmitFailure(error, { submissionStarted }));
        }
      });
    });
  }

  route("/__octopus/chat-pins", (req, res) => {
    void withAccess(req, res, access, ["live", "lab"], async (session) => {
      if (req.method !== "POST") return sendJson(res, 405, { error: "chat pin updates require POST" });
      const request = await readJson(req);
      if (session.profile === "lab") {
        return sendJson(res, 200, await getStore("lab").updateChatPins(request));
      }
      const { updateOperatorChatPins } = await operatorChatClientLoader.load();
      const outcome = await updateOperatorChatPins({
        octopusHome: () => octopusHome,
        installationRoot: () => installationRoot,
      }, request);
      sendJson(res, 200, outcome);
    });
  });

  route("/__octopus/interface-artifact", (req, res) => {
    void withAccess(req, res, access, ["live"], async () => {
      if (req.method !== "POST") return sendJson(res, 405, { error: "interface artifact submit requires POST" });
      const request = await readJson(req);
      const { submitClientInterfaceArtifact } = require("./clientArtifacts.cjs");
      const outcome = await submitClientInterfaceArtifact({
        clientArtifactsRoot,
        projectionStore: () => getStore("live"),
        handInArtifact: deliverInterfaceArtifact,
        authorizeSubmission: authorizeClientInterfaceArtifactSubmission,
      }, request);
      sendJson(res, 200, outcome);
    });
  });

  route("/__octopus/artifact-stream", (req, res, next) => {
    const operation = String(req.url ?? "").split("?")[0].replace(/^\/+/, "");
    if (operation !== "begin" && operation !== "append" && operation !== "finalize" && operation !== "abort") return next();
    void withAccess(req, res, access, ["live"], async () => {
      if (req.method !== "POST") return sendJson(res, 405, { error: `artifact stream ${operation} requires POST` });
      const request = await readJson(req);
      const owner = readCookie(req, COOKIE_NAME);
      const streamStore = getArtifactStreamStore();
      const outcome = operation === "begin"
        ? await streamStore.begin(owner, request)
        : operation === "append"
          ? await streamStore.append(owner, request)
          : operation === "finalize"
            ? await streamStore.finalize(owner, request)
            : await streamStore.abort(owner, request);
      sendJson(res, 200, outcome);
    });
  });

  route("/__octopus/client-surfaces", (req, res) => {
    void withAccess(req, res, access, ["live", "lab"], async (session) => {
      if (req.method !== "GET") return sendJson(res, 405, { error: "client surface documents require GET" });
      sendJson(res, 200, filterClientSurfaceSnapshot(await getSurfaceStore().snapshot(), session.profile));
    });
  });

  route("/__octopus/client-surface-events", (req, res) => {
    if (req.method !== "GET") return sendJson(res, 405, { error: "client surface events require GET" });
    const session = requireHttpAccess(req, res, access, ["lab"]);
    if (!session) return;
    const store = getSurfaceStore();
    subscribeEvents(req, res, access, surfaceClients, store.generation());
    store.ensureWatcher();
  });

  route("/__octopus/events", (req, res) => {
    if (req.method !== "GET") return sendJson(res, 405, { error: "projection events require GET" });
    const session = requireHttpAccess(req, res, access, ["live", "lab"]);
    if (!session) return;
    const store = getStore(session.profile);
    subscribeEvents(req, res, access, projectionClients.get(session.profile), store.generation());
    store.ensureWatchers();
  });

  return {
    reloadFixture,
    labFixturePath,
    async close() {
      for (const clients of [...projectionClients.values(), surfaceClients]) {
        for (const client of clients.keys()) client.end();
        clients.clear();
      }
      for (const store of stores.values()) store.close?.();
      surfaceStore?.close();
      await artifactStreamStore?.abortAll();
      await workspaceClient?.close();
    },
  };
}

async function handleAccess(req, res, access, secure, agentLogin) {
  const status = (token) => ({
    ...access.status(token),
    ...(agentLogin ? { turnstileSiteKey: agentLogin.turnstile.siteKey } : {}),
  });
  try {
    const operation = String(req.url ?? "").split("?")[0].replace(/^\/+/, "");
    const token = readCookie(req, COOKIE_NAME);
    if (agentLogin && !["status", "unlock", "lock", "details"].includes(operation)) {
      return sendJson(res, 404, { error: "Unknown client access operation" });
    }
    if (operation === "status" && req.method === "GET") return sendJson(res, 200, status(token));
    if (operation === "configure" && req.method === "POST") {
      const session = access.configure((await readJson(req)).password);
      setAccessCookie(res, session.token, session.expiresAt, secure);
      return sendJson(res, 200, access.status(session.token));
    }
    if (operation === "unlock" && req.method === "POST") {
      const request = await readJson(req);
      if (agentLogin) {
        if (typeof request.username !== "string" || !request.username.trim() || request.username.length > 128
          || typeof request.password !== "string" || !request.password || request.password.length > 16_384) {
          return sendJson(res, 400, { error: "Enter your username and password." });
        }
        await agentLogin.turnstile.verify(request.turnstileToken);
      }
      const session = access.unlock(request.password, request.username);
      setAccessCookie(res, session.token, session.expiresAt, secure);
      return sendJson(res, 200, status(session.token));
    }
    if (operation === "lock" && req.method === "POST") {
      access.lock(token);
      clearAccessCookie(res, secure);
      return sendJson(res, 200, status(""));
    }
    if (operation === "lab-status" && req.method === "GET") {
      return sendJson(res, 200, access.labAccess(token));
    }
    if (operation === "lab-update" && req.method === "POST") {
      return sendJson(res, 200, access.updateLabAccess(token, (await readJson(req)).password));
    }
    if (operation === "details" && req.method === "GET") {
      return sendJson(res, 200, access.accessDetails(token));
    }
    if (operation === "administrator-update" && req.method === "POST") {
      const request = await readJson(req);
      return sendJson(res, 200, access.updateAdministratorAccess(token, request.currentPassword, request.password));
    }
    sendJson(res, 404, { error: "Unknown client access operation" });
  } catch (error) {
    sendJson(res, error?.code === "turnstile_unavailable" ? 503 : 401, { error: formatError(error) });
  }
}

async function withAccess(
  req,
  res,
  access,
  profiles,
  handler,
) {
  const session = requireHttpAccess(req, res, access, profiles);
  if (!session) return;
  try {
    await handler(session);
  } catch (error) {
    sendJson(res, 400, { error: formatError(error) });
  }
}

function requireHttpAccess(req, res, access, profiles) {
  try {
    return access.requireSession(readCookie(req, COOKIE_NAME), profiles);
  } catch (error) {
    sendJson(res, 401, { error: formatError(error) });
    return null;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > 8 * 1024 * 1024) {
        reject(new Error("Request body exceeds 8 MiB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be a JSON object.");
        resolve(value);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("Request body was interrupted.")));
  });
}

function sendJson(res, status, value) {
  if (res.headersSent || res.destroyed) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(value));
}

function readCookie(req, name) {
  const prefix = `${name}=`;
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return "";
}

function setAccessCookie(res, token, expiresAt, secure) {
  res.setHeader("set-cookie", `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict;${secure ? " Secure;" : ""} Expires=${new Date(expiresAt).toUTCString()}`);
}

function clearAccessCookie(res, secure) {
  res.setHeader("set-cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict;${secure ? " Secure;" : ""} Max-Age=0`);
}

function publish(clients, event) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const [client, sessionActive] of clients) {
    if (!sessionActive()) client.end();
    else if (!client.write(frame)) client.destroy();
  }
}

function subscribeEvents(req, res, access, clients, generation) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
  const token = readCookie(req, COOKIE_NAME);
  const sessionActive = () => {
    try { return Boolean(access.requireSession(token)); }
    catch { return false; }
  };
  const heartbeat = setInterval(() => {
    if (!sessionActive()) res.end();
    else if (!res.write(": heartbeat\n\n")) res.destroy();
  }, 15_000);
  res.once("close", () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
  clients.set(res, sessionActive);
  res.write(`data: ${JSON.stringify({ generation })}\n\n`);
}

function configuredAbsolutePath(value, fallback, field) {
  const configured = (value ?? "").trim();
  if (!configured) return fallback;
  if (!path.isAbsolute(configured)) throw new Error(`${field} must be absolute`);
  return configured;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = { createClientHttpApi };
