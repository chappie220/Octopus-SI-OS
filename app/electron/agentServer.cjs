const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { createTurnstile, TURNSTILE_ORIGIN } = require("./turnstile.cjs");
const { createClientHttpApi } = require("./clientHttpApi.cjs");

const LISTEN_HOST = "127.0.0.1";
const DEFAULT_PORT = 4180;
const DIST = path.resolve(__dirname, "../dist");
const ROUTE_GROUPS = new Set(["/__octopus/access", "/__octopus/artifact-stream"]);
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

async function createAgentServer({ environment, port = DEFAULT_PORT, publicOrigin, dist = DIST }) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("The Agent server port must be an integer between 1 and 65535.");
  }
  if ((process.env.OCTOPUS_CLIENT_ADMIN_SECRET ?? "").trim().length < 8) {
    throw new Error("Set OCTOPUS_CLIENT_ADMIN_SECRET to an administrator password of at least 8 characters.");
  }
  const administratorUsername = (process.env.OCTOPUS_CLIENT_ADMIN_USERNAME ?? "").trim();
  if (!administratorUsername || administratorUsername.length > 128) {
    throw new Error("Set OCTOPUS_CLIENT_ADMIN_USERNAME to an administrator username of at most 128 characters.");
  }
  const origin = webOrigin(publicOrigin, port);
  const turnstile = createTurnstile(origin.hostname);
  const distRoot = await fs.realpath(dist).catch(() => null);
  if (!distRoot || !(await fs.stat(path.join(distRoot, "index.html")).catch(() => null))?.isFile()) {
    throw new Error("Build the WebUI first with npm --prefix app run build.");
  }

  const routes = [];
  const api = createClientHttpApi({
    environment,
    agentLogin: { administratorUsername, turnstile },
    secure: origin.protocol === "https:",
    route: (prefix, handler) => routes.push({ prefix, handler }),
  });
  const server = http.createServer((req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("content-security-policy", [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "worker-src 'self' blob:",
      `script-src 'self' 'wasm-unsafe-eval' ${TURNSTILE_ORIGIN}`,
      `frame-src 'self' ${TURNSTILE_ORIGIN}`,
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; "));

    if (req.headers.host !== origin.host) return fail(res, 403, "Unexpected Agent server host");
    const rawPath = req.url ?? "";
    if (!rawPath.startsWith("/") || rawPath.startsWith("//")) return fail(res, 400, "Invalid request path");
    const pathname = rawPath.split("?", 1)[0];
    if (pathname === "/__octopus" || pathname.startsWith("/__octopus/")) {
      if (req.headers.origin && req.headers.origin !== origin.origin) return fail(res, 403, "Unexpected request origin");
      const fetchSite = req.headers["sec-fetch-site"];
      if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return fail(res, 403, "Cross-origin requests are unavailable");
      if (req.method === "POST" && req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
        return fail(res, 415, "Agent server requests require JSON");
      }
      const route = routes.find(({ prefix }) => pathname === prefix
        || (ROUTE_GROUPS.has(prefix) && pathname.startsWith(`${prefix}/`)));
      if (!route) return fail(res, 404, "Unknown Agent server route");
      req.url = rawPath.slice(route.prefix.length);
      return route.handler(req, res, () => fail(res, 404, "Unknown Agent server operation"));
    }
    if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "WebUI assets require GET or HEAD");
    void serveAsset(req, res, distRoot, pathname).catch((error) => {
      if (res.headersSent) res.destroy(error);
      else fail(res, 500, "Could not read the WebUI asset");
    });
  });

  return {
    origin: origin.origin,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, LISTEN_HOST, () => {
          server.off("error", reject);
          resolve();
        });
      });
    },
    async close() {
      const stopped = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await Promise.all([stopped, api.close()]);
    },
  };
}

function webOrigin(value, port) {
  if (!value) return new URL(`http://${LISTEN_HOST}:${port}`);
  const origin = new URL(value);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("OCTOPUS_AGENT_PUBLIC_ORIGIN must be an HTTPS origin such as https://agent.example.com.");
  }
  return origin;
}

async function serveAsset(req, res, distRoot, pathname) {
  let relative;
  try { relative = pathname === "/" ? "/index.html" : decodeURIComponent(pathname); }
  catch { return fail(res, 400, "Invalid WebUI path"); }
  if (relative.includes("\\") || relative.split("/").some((segment) => segment.startsWith("."))) {
    return fail(res, 404, "WebUI asset not found");
  }
  const candidate = await fs.realpath(path.resolve(distRoot, `.${relative}`)).catch(() => null);
  if (!candidate || !candidate.startsWith(`${distRoot}${path.sep}`)) return fail(res, 404, "WebUI asset not found");
  const file = await fs.open(candidate, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return fail(res, 404, "WebUI asset not found");
    res.writeHead(200, {
      "content-type": MIME_TYPES[path.extname(candidate)] ?? "application/octet-stream",
      "content-length": stat.size,
      "cache-control": "no-cache",
    });
    if (req.method === "HEAD") res.end();
    else await pipeline(file.createReadStream({ autoClose: false }), res);
  } finally {
    await file.close();
  }
}

function fail(res, status, error) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error }));
}

module.exports = { createAgentServer, DEFAULT_PORT };
