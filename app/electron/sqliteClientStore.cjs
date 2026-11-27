const fs = require("node:fs");
const path = require("node:path");

const PREVIEW_MAX_ROWS = 2_048;
const TURN_MAX_ROWS = 1_024;
const FILE_DIGEST_MAX_ROWS = 32_768;

const openStores = new Map();

function loadDatabaseSync() {
  try {
    return require("node:sqlite").DatabaseSync;
  } catch {
    return null;
  }
}

function storeFilePath(home) {
  return path.join(home, "client", "client-store.sqlite");
}

function openClientStore(home) {
  if (typeof home !== "string" || !home) return null;
  const resolvedHome = path.resolve(home);
  const existing = openStores.get(resolvedHome);
  if (existing) return existing;
  const DatabaseSync = loadDatabaseSync();
  if (!DatabaseSync) return null;
  const dbPath = storeFilePath(resolvedHome);
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -2048;
      PRAGMA journal_size_limit = 8388608;
      PRAGMA auto_vacuum = INCREMENTAL;
      CREATE TABLE IF NOT EXISTS chat_previews (
        cache_key TEXT PRIMARY KEY,
        basis TEXT NOT NULL,
        files_json TEXT NOT NULL,
        text TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_previews_updated ON chat_previews(updated_at);
      CREATE TABLE IF NOT EXISTS chat_turns (
        cache_key TEXT PRIMARY KEY,
        basis TEXT NOT NULL,
        count INTEGER NOT NULL,
        rows_digest TEXT NOT NULL,
        files_json TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_turns_updated ON chat_turns(updated_at);
      CREATE TABLE IF NOT EXISTS file_digests (
        file_path TEXT PRIMARY KEY,
        stamp TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_file_digests_updated ON file_digests(updated_at);
    `);
    try { fs.chmodSync(dbPath, 0o600); } catch {}
    const stmts = {
      getPreview: db.prepare("SELECT basis, files_json, text FROM chat_previews WHERE cache_key = ?"),
      putPreview: db.prepare(
        "INSERT OR REPLACE INTO chat_previews(cache_key, basis, files_json, text, updated_at) VALUES (?, ?, ?, ?, ?)",
      ),
      countPreviews: db.prepare("SELECT COUNT(*) AS count FROM chat_previews"),
      prunePreviews: db.prepare(
        "DELETE FROM chat_previews WHERE cache_key IN (SELECT cache_key FROM chat_previews ORDER BY updated_at ASC LIMIT ?)",
      ),
      getTurn: db.prepare("SELECT basis, count, rows_digest, files_json, state_json FROM chat_turns WHERE cache_key = ?"),
      putTurn: db.prepare(
        "INSERT OR REPLACE INTO chat_turns(cache_key, basis, count, rows_digest, files_json, state_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ),
      countTurns: db.prepare("SELECT COUNT(*) AS count FROM chat_turns"),
      pruneTurns: db.prepare(
        "DELETE FROM chat_turns WHERE cache_key IN (SELECT cache_key FROM chat_turns ORDER BY updated_at ASC LIMIT ?)",
      ),
      getDigest: db.prepare("SELECT stamp, sha256, size FROM file_digests WHERE file_path = ?"),
      putDigest: db.prepare(
        "INSERT OR REPLACE INTO file_digests(file_path, stamp, sha256, size, updated_at) VALUES (?, ?, ?, ?, ?)",
      ),
      countDigests: db.prepare("SELECT COUNT(*) AS count FROM file_digests"),
      pruneDigests: db.prepare(
        "DELETE FROM file_digests WHERE file_path IN (SELECT file_path FROM file_digests ORDER BY updated_at ASC LIMIT ?)",
      ),
    };
    let previewWrites = 0;
    let turnWrites = 0;
    let digestWrites = 0;
    const handle = {
      dbPath,
      getChatPreview(cacheKey) {
        try {
          const row = stmts.getPreview.get(cacheKey);
          if (!row) return null;
          return { basis: row.basis, files: JSON.parse(row.files_json), text: row.text };
        } catch {
          return null;
        }
      },
      setChatPreview(cacheKey, { basis, files, text }) {
        try {
          stmts.putPreview.run(cacheKey, basis, JSON.stringify(files ?? []), text, Date.now());
          if (++previewWrites % 128 === 0) {
            const count = Number(stmts.countPreviews.get()?.count ?? 0);
            if (count > PREVIEW_MAX_ROWS) {
              stmts.prunePreviews.run(count - Math.floor(PREVIEW_MAX_ROWS * 0.8));
            }
          }
        } catch {}
      },
      getChatTurn(cacheKey) {
        try {
          const row = stmts.getTurn.get(cacheKey);
          if (!row) return null;
          return {
            basis: row.basis,
            count: Number(row.count),
            rowsDigest: row.rows_digest,
            files: JSON.parse(row.files_json),
            state: JSON.parse(row.state_json),
          };
        } catch {
          return null;
        }
      },
      setChatTurn(cacheKey, { basis, count, rowsDigest, files, state }) {
        try {
          stmts.putTurn.run(
            cacheKey,
            basis,
            count,
            rowsDigest,
            JSON.stringify(files ?? []),
            JSON.stringify(state),
            Date.now(),
          );
          if (++turnWrites % 64 === 0) {
            const total = Number(stmts.countTurns.get()?.count ?? 0);
            if (total > TURN_MAX_ROWS) {
              stmts.pruneTurns.run(total - Math.floor(TURN_MAX_ROWS * 0.8));
            }
          }
        } catch {}
      },
      getFileDigest(filePath, stamp) {
        try {
          const row = stmts.getDigest.get(filePath);
          if (!row || row.stamp !== stamp) return null;
          return { sha256: row.sha256, size: Number(row.size) };
        } catch {
          return null;
        }
      },
      setFileDigest(filePath, stamp, sha256, size) {
        try {
          stmts.putDigest.run(filePath, stamp, sha256, size, Date.now());
          if (++digestWrites % 256 === 0) {
            const total = Number(stmts.countDigests.get()?.count ?? 0);
            if (total > FILE_DIGEST_MAX_ROWS) {
              stmts.pruneDigests.run(total - Math.floor(FILE_DIGEST_MAX_ROWS * 0.8));
            }
          }
        } catch {}
      },
      close() {
        if (openStores.get(resolvedHome) === handle) openStores.delete(resolvedHome);
        try { db.close(); } catch {}
      },
    };
    openStores.set(resolvedHome, handle);
    return handle;
  } catch {
    return null;
  }
}

function closeClientStore(home) {
  if (typeof home !== "string" || !home) return;
  const resolvedHome = path.resolve(home);
  const existing = openStores.get(resolvedHome);
  if (existing) existing.close();
}

function closeAllClientStores() {
  for (const handle of [...openStores.values()]) handle.close();
}

module.exports = {
  closeAllClientStores,
  closeClientStore,
  openClientStore,
  storeFilePath,
};
