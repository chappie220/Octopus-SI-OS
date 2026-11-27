const fs = require("node:fs");

const TARGETS = Object.freeze({
  "aarch64-apple-darwin": Object.freeze({ platform: "darwin", architecture: "arm64" }),
  "x86_64-apple-darwin": Object.freeze({ platform: "darwin", architecture: "x64" }),
  "aarch64-unknown-linux-gnu": Object.freeze({ platform: "linux", architecture: "arm64", libc: "gnu" }),
  "aarch64-unknown-linux-musl": Object.freeze({ platform: "linux", architecture: "arm64", libc: "musl" }),
  "x86_64-unknown-linux-gnu": Object.freeze({ platform: "linux", architecture: "x64", libc: "gnu" }),
  "x86_64-unknown-linux-musl": Object.freeze({ platform: "linux", architecture: "x64", libc: "musl" }),
});
const SUPPORTED_TARGETS = Object.freeze(Object.keys(TARGETS).sort());

const COMPONENTS = Object.freeze({
  darwin: Object.freeze({ client_filesystem: true, desktop_native: true, managed_codex: true, code_signing: true }),
  linux: Object.freeze({ client_filesystem: false, desktop_native: false, managed_codex: true, code_signing: false }),
});

function detectLinuxLibc() {
  try {
    const header = process.report?.getReport?.()?.header;
    if (header && typeof header.glibcVersionRuntime === "string" && header.glibcVersionRuntime.length > 0) {
      return "gnu";
    }
  } catch {
    // Fall through to filesystem probe when process.report is unavailable.
  }
  if (
    fs.existsSync("/etc/alpine-release")
    || fs.existsSync("/lib/ld-musl-aarch64.so.1")
    || fs.existsSync("/lib/ld-musl-x86_64.so.1")
  ) {
    return "musl";
  }
  return "gnu";
}

function hostTarget(platform = process.platform, architecture = process.arch, libc = undefined) {
  const resolvedLibc = platform === "linux"
    ? (libc ?? (platform === process.platform ? detectLinuxLibc() : "gnu"))
    : undefined;
  const found = SUPPORTED_TARGETS.find((triple) => {
    const entry = TARGETS[triple];
    if (entry.platform !== platform || entry.architecture !== architecture) return false;
    return platform === "linux" ? entry.libc === resolvedLibc : true;
  });
  if (!found) {
    const hostLabel = platform === "linux" && resolvedLibc ? `${platform}-${architecture}-${resolvedLibc}` : `${platform}-${architecture}`;
    throw new Error(`The Octopus CLI distribution is not built on ${hostLabel}; supported targets: ${SUPPORTED_TARGETS.join(", ")}`);
  }
  return found;
}

function resolveCliTarget({ platform = process.platform, architecture = process.arch, libc = undefined, target = null } = {}) {
  const host = hostTarget(platform, architecture, libc);
  if (target !== null && !Object.hasOwn(TARGETS, target)) {
    throw new Error(`Unknown CLI target '${target}'; supported targets: ${SUPPORTED_TARGETS.join(", ")}`);
  }
  if (target !== null && target !== host) {
    throw new Error(`CLI target ${target} cannot be built on ${host}: a distribution is built on the machine it targets`);
  }
  return Object.freeze({ triple: host, ...TARGETS[host], components: COMPONENTS[platform] });
}

function takeTargetArgument(argv) {
  let target = null;
  const rest = [];
  for (const argument of argv) {
    if (!argument.startsWith("--target")) { rest.push(argument); continue; }
    const value = argument.startsWith("--target=") ? argument.slice("--target=".length) : "";
    if (!value) throw new Error("--target requires a value, as --target=<triple>");
    if (target !== null) throw new Error("--target is given more than once");
    target = value;
  }
  return { target, rest };
}

module.exports = { SUPPORTED_TARGETS, detectLinuxLibc, hostTarget, resolveCliTarget, takeTargetArgument };
