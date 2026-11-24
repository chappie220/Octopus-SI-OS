const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { PassThrough, Readable } = require("node:stream");
const { test } = require("node:test");
const { createAgentServer } = require("../electron/agentServer.cjs");

test("Agent server serves the WebUI and grants access only to authenticated same-origin clients", async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "octopus-agent-test-"));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const dist = path.join(scratch, "dist");
  await fs.mkdir(dist);
  await fs.writeFile(path.join(dist, "index.html"), "<title>Octopus</title>");
  await fs.writeFile(path.join(scratch, "private.txt"), "private");
  await fs.symlink(path.join(scratch, "private.txt"), path.join(dist, "outside.txt"));

  const username = "octopus-owner";
  const password = "agent-server-test-password";
  const siteKey = "fixture-turnstile-site-key";
  const secret = "fixture-turnstile-secret-key";
  const environmentValues = {
    OCTOPUS_CLIENT_ADMIN_USERNAME: username,
    OCTOPUS_CLIENT_ADMIN_SECRET: password,
    OCTOPUS_CLIENT_ACCESS_OPEN: "1",
    OCTOPUS_TURNSTILE_SITE_KEY: siteKey,
    OCTOPUS_TURNSTILE_SECRET_KEY: secret,
  };
  for (const [key, value] of Object.entries(environmentValues)) {
    const original = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
  }

  const verify = t.mock.method(globalThis, "fetch", async (url, request) => {
    assert.equal(url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    assert.equal(request.method, "POST");
    assert.equal(request.body.get("secret"), secret);
    const response = request.body.get("response");
    if (response === "offline") throw new Error("network unavailable");
    return Response.json({
      success: response !== "forged",
      hostname: response === "other-host" ? "other.example.test" : "agent.example.test",
      action: response === "other-action" ? "other_action" : "agent_login",
    });
  });

  const createServer = t.mock.method(http, "createServer");
  const environment = {
    home: scratch,
    packageRoots: { stateRoot: path.join(scratch, "client", "package-state") },
    async status() {
      return {
        phase: "ready", ready: false, runtimeReady: true, workspaceConfigured: false,
        home: scratch, reason: "Home is not configured", storageHealth: null, interfaceFailures: [],
      };
    },
  };
  delete process.env.OCTOPUS_TURNSTILE_SECRET_KEY;
  await assert.rejects(createAgentServer({ environment, dist }), /OCTOPUS_TURNSTILE_SITE_KEY and OCTOPUS_TURNSTILE_SECRET_KEY/);
  process.env.OCTOPUS_TURNSTILE_SECRET_KEY = secret;
  const server = await createAgentServer({ environment, dist, publicOrigin: "https://agent.example.test" });
  const [handler] = createServer.mock.calls[0].arguments;
  t.after(() => server.close());

  const requestTo = (url, { method = "GET", cookie, headers, body } = {}) => {
    const request = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(request, {
      url, method,
      headers: {
        host: "agent.example.test",
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
    });
    const response = new PassThrough();
    const responseHeaders = {};
    response.setHeader = (key, value) => { responseHeaders[key] = value; };
    response.writeHead = (status, values) => {
      response.statusCode = status;
      Object.assign(responseHeaders, values);
      response.headersSent = true;
    };
    handler(request, response);
    return { response, responseHeaders };
  };

  const call = async (url, options) => {
    const { response, responseHeaders } = requestTo(url, options);
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    return {
      status: response.statusCode,
      headers: responseHeaders,
      text,
      json: () => JSON.parse(text),
    };
  };

  const page = await call("/");
  assert.equal(page.text, "<title>Octopus</title>");
  assert.match(page.headers["content-security-policy"], /script-src [^;]*https:\/\/challenges\.cloudflare\.com/);
  assert.match(page.headers["content-security-policy"], /frame-src [^;]*https:\/\/challenges\.cloudflare\.com/);
  assert.equal((await call("/outside.txt")).status, 404);
  assert.equal((await call("/%2e%2e/private.txt")).status, 404);
  assert.equal((await call("/", { headers: { host: "other.example.test" } })).status, 403);
  assert.equal((await call("/__octopus/runtime-status")).status, 401);
  assert.equal((await call("/__octopus/events")).status, 401);
  const locked = await call("/__octopus/access/status");
  assert.equal(locked.json().authenticated, false);
  assert.equal(locked.json().labAvailable, false);

  assert.equal(locked.json().turnstileSiteKey, siteKey);
  assert.doesNotMatch(locked.text, /fixture-turnstile-secret-key|octopus-owner|agent-server-test-password/);

  const login = (fields = {}, headers) => call("/__octopus/access/unlock", {
    method: "POST", headers, body: { username, password, ...fields },
  });
  assert.equal((await login({}, { origin: "https://other.example.test" })).status, 403);
  assert.equal((await login({}, { "content-type": "text/plain" })).status, 415);
  assert.equal((await login({ username: undefined })).status, 400);
  assert.equal((await login()).status, 401);
  assert.equal(verify.mock.callCount(), 0);
  for (const turnstileToken of ["forged", "other-host", "other-action"]) {
    const rejected = await login({ turnstileToken });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers["set-cookie"], undefined);
  }
  const offline = await login({ turnstileToken: "offline" });
  assert.equal(offline.status, 503);
  assert.equal(offline.headers["set-cookie"], undefined);

  const wrongUsername = await login({ username: "other-user", turnstileToken: "wrong-user" });
  const wrongPassword = await login({ password: "octopus-test", turnstileToken: "wrong-password" });
  assert.equal(wrongUsername.status, 401);
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongUsername.json().error, "Incorrect username or password.");
  assert.equal(wrongUsername.json().error, wrongPassword.json().error);
  assert.equal((await login({ turnstileToken: "wrong-user" })).headers["set-cookie"], undefined);

  const unlocked = await login({ turnstileToken: "valid" });
  const replay = await login({ turnstileToken: "valid" });
  assert.equal(replay.status, 401);
  assert.equal(replay.headers["set-cookie"], undefined);
  assert.equal(unlocked.json().profile, "live");
  assert.match(unlocked.headers["set-cookie"], /HttpOnly; SameSite=Strict; Secure;/);
  const cookie = unlocked.headers["set-cookie"].split(";", 1)[0];
  assert.equal((await call("/__octopus/runtime-status", { cookie })).json().phase, "setup_required");
  assert.equal((await call("/__octopus/runtime-status/extra", { cookie })).status, 404);
  const events = requestTo("/__octopus/events", { cookie });
  assert.equal(events.response.statusCode, 200);
  assert.equal(events.responseHeaders["content-type"], "text/event-stream");
  const [initial] = await once(events.response, "data");
  assert.match(initial.toString(), /^data: {"generation":\d+}\n\n$/);
  events.response.destroy();
  assert.equal((await call("/__octopus/workspace", {
    method: "POST", cookie, body: { action: "install_package" },
  })).status, 400);
  const signedOut = await call("/__octopus/access/lock", { method: "POST", cookie, body: {} });
  assert.equal(signedOut.json().authenticated, false);
  assert.equal(signedOut.json().turnstileSiteKey, siteKey);
  assert.equal((await call("/__octopus/runtime-status", { cookie })).status, 401);
});
