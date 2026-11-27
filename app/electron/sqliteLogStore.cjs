const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_LOG_BYTES = 300 * 1024 * 1024; // 300 MiB strict hard cap
const MAX_SINGLE_ENTRY_BYTES = 64 * 1024;
const PRUNE_CHECK_INTERVAL = 64;

const openLogStores = new Map();

function loadDatabaseSync() {
  try {
    return require("node:sqlite").DatabaseSync;
  } catch {
    return null;
  }
}

function logStorePath(home) {
  return path.join(home, "client", "logs", "octopus-logs.sqlite");
}

function fileSizeOrZero(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function totalSqliteDiskBytes(dbPath) {
  return fileSizeOrZero(dbPath)
    + fileSizeOrZero(`${dbPath}-wal`)
    + fileSizeOrZero(`${dbPath}-shm`);
}

function openSqliteLogStore(home, options = {}) {
  const dbPath = typeof options.dbPath === "string" && options.dbPath
    ? path.resolve(options.dbPath)
    : logStorePath(path.resolve(home));
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes >= 256 * 1024
    ? options.maxBytes
    : DEFAULT_MAX_LOG_BYTES;
  const cacheKey = `${dbPath}\0${maxBytes}`;
  const existing = openLogStores.get(cacheKey);
  if (existing) return existing;

  const DatabaseSync = loadDatabaseSync();
  if (!DatabaseSync) {
    throw new Error("Node.js built-in node:sqlite is required for SQLite log storage.");
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  const walLimit = Math.min(8 * 1024 * 1024, Math.max(32 * 1024, Math.floor(maxBytes / 16)));
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA auto_vacuum = INCREMENTAL;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -1024;
    PRAGMA journal_size_limit = ${walLimit};
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_ms INTEGER NOT NULL,
      source TEXT NOT NULL,
      level TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_logs_source_id ON logs(source, id);
  `);
  try { fs.chmodSync(dbPath, 0o600); } catch {}

  const insertStmt = db.prepare(
    "INSERT INTO logs(ts_ms, source, level, bytes, message) VALUES (?, ?, ?, ?, ?)",
  );
  const sumBytesStmt = db.prepare("SELECT COALESCE(SUM(bytes), 0) AS total, COUNT(*) AS count FROM logs");
  const deleteOldestStmt = db.prepare(
    "DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY id ASC LIMIT ?)",
  );
  const tailAllStmt = db.prepare(
    "SELECT id, ts_ms, source, level, message FROM logs ORDER BY id DESC LIMIT ?",
  );
  const tailBySourceStmt = db.prepare(
    "SELECT id, ts_ms, source, level, message FROM logs WHERE source = ? ORDER BY id DESC LIMIT ?",
  );

  // Reserve space for SQLite B-tree overhead + WAL so on-disk footprint stays strictly <= maxBytes.
  const payloadSoftLimit = Math.floor(maxBytes * 0.65);
  const payloadTarget = Math.floor(maxBytes * 0.45);
  const checkByteInterval = Math.min(1024 * 1024, Math.max(8 * 1024, Math.floor(maxBytes / 16)));
  let trackedBytes = Number(sumBytesStmt.get()?.total ?? 0);
  let writesSinceCheck = 0;
  let bytesSinceCheck = 0;

  function enforceSizeCap(force = false) {
    const diskBytes = totalSqliteDiskBytes(dbPath);
    if (!force && trackedBytes <= payloadSoftLimit && diskBytes <= Math.floor(maxBytes * 0.9)) {
      return;
    }
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch {}
    for (let round = 0; round < 16; round++) {
      const stats = sumBytesStmt.get();
      trackedBytes = Number(stats?.total ?? 0);
      const count = Number(stats?.count ?? 0);
      const currentDisk = totalSqliteDiskBytes(dbPath);
      if (count <= 1 || (trackedBytes <= payloadTarget && currentDisk <= Math.floor(maxBytes * 0.85))) {
        break;
      }
      const deleteCount = Math.max(1, Math.min(count - 1, Math.ceil(count * 0.35)));
      deleteOldestStmt.run(deleteCount);
      try {
        db.exec("PRAGMA incremental_vacuum;");
        db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {}
    }
    if (totalSqliteDiskBytes(dbPath) > maxBytes) {
      try {
        db.exec("VACUUM;");
        db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {}
    }
    trackedBytes = Number(sumBytesStmt.get()?.total ?? 0);
  }

  function append(source, level, message) {
    const text = String(message ?? "");
    if (!text) return;
    const src = String(source || "runtime").slice(0, 64);
    const lvl = String(level || "info").slice(0, 32);
    let payload = text;
    let byteLen = Buffer.byteLength(payload, "utf8");
    if (byteLen > MAX_SINGLE_ENTRY_BYTES) {
      payload = `${Buffer.from(payload, "utf8").subarray(0, MAX_SINGLE_ENTRY_BYTES - 16).toString("utf8")}...[truncated]`;
      byteLen = Buffer.byteLength(payload, "utf8");
    }
    const rowBytes = byteLen + Buffer.byteLength(src, "utf8") + Buffer.byteLength(lvl, "utf8") + 64;
    insertStmt.run(Date.now(), src, lvl, rowBytes, payload);
    trackedBytes += rowBytes;
    writesSinceCheck += 1;
    bytesSinceCheck += rowBytes;
    if (writesSinceCheck >= PRUNE_CHECK_INTERVAL || bytesSinceCheck >= checkByteInterval || trackedBytes > payloadSoftLimit) {
      writesSinceCheck = 0;
      bytesSinceCheck = 0;
      enforceSizeCap(false);
    }
  }

  function appendLines(source, level, chunk) {
    const lines = String(chunk ?? "").split(/\r?\n/);
    for (const line of lines) {
      if (line.length > 0) append(source, level, line);
    }
  }

  function readTail(limit = 200, source = null) {
    const bounded = Math.max(1, Math.min(5_000, Number(limit) || 200));
    const rows = source
      ? tailBySourceStmt.all(String(source), bounded)
      : tailAllStmt.all(bounded);
    return rows.reverse();
  }

  function diskUsageBytes() {
    return totalSqliteDiskBytes(dbPath);
  }

  function close() {
    if (openLogStores.get(cacheKey) === handle) openLogStores.delete(cacheKey);
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch {}
    try { db.close(); } catch {}
  }

  const handle = {
    dbPath,
    maxBytes,
    append,
    appendLines,
    enforceSizeCap,
    readTail,
    diskUsageBytes,
    close,
  };
  openLogStores.set(cacheKey, handle);
  return handle;
}

function closeAllSqliteLogStores() {
  for (const handle of [...openLogStores.values()]) handle.close();
}

module.exports = {
  DEFAULT_MAX_LOG_BYTES,
  closeAllSqliteLogStores,
  logStorePath,
  openSqliteLogStore,
};
