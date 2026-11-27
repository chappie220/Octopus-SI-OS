const { openClientStore } = require("./sqliteClientStore.cjs");

const SETTLED_FILE_HASH_CACHE_MAX = 8_192;
const SETTLED_WINDOW_MS = 2_000;

const settledFileHashCache = new Map();
const settledInodeHashCache = new Map();
let persistentStoreHome = null;

function setSettledHashStoreHome(home) {
  persistentStoreHome = typeof home === "string" && home ? home : null;
}

function fileStamp(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mode}:${stat.mtimeMs}`;
}

function isSettledStat(stat, observedAtMs) {
  return Number.isFinite(stat.mtimeMs) && observedAtMs - stat.mtimeMs >= SETTLED_WINDOW_MS;
}

function touchLru(map, key, value, maxEntries) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function getSettledFileSha256(filePath, stat, observedAtMs = Date.now(), options = {}) {
  if (!options.allowUnsettled && !isSettledStat(stat, observedAtMs)) return null;
  const stamp = fileStamp(stat);
  const cached = settledFileHashCache.get(filePath);
  if (cached && cached.stamp === stamp) {
    touchLru(settledFileHashCache, filePath, cached, SETTLED_FILE_HASH_CACHE_MAX);
    return { sha256: cached.sha256, size: cached.size };
  }
  const byInode = settledInodeHashCache.get(stamp);
  if (byInode) {
    touchLru(settledInodeHashCache, stamp, byInode, SETTLED_FILE_HASH_CACHE_MAX);
    touchLru(settledFileHashCache, filePath, { stamp, sha256: byInode.sha256, size: byInode.size }, SETTLED_FILE_HASH_CACHE_MAX);
    return { sha256: byInode.sha256, size: byInode.size };
  }
  const home = options.home || persistentStoreHome;
  if (home) {
    const store = openClientStore(home);
    const persisted = store?.getFileDigest(filePath, stamp) ?? store?.getFileDigest(`inode:${stamp}`, stamp);
    if (persisted) {
      touchLru(settledFileHashCache, filePath, { stamp, ...persisted }, SETTLED_FILE_HASH_CACHE_MAX);
      touchLru(settledInodeHashCache, stamp, persisted, SETTLED_FILE_HASH_CACHE_MAX);
      return persisted;
    }
  }
  return null;
}

function setSettledFileSha256(filePath, stat, content, observedAtMs = Date.now(), options = {}) {
  if (!options.allowUnsettled && !isSettledStat(stat, observedAtMs)) return;
  const stamp = fileStamp(stat);
  const value = { sha256: content.sha256, size: content.size };
  touchLru(settledFileHashCache, filePath, { stamp, ...value }, SETTLED_FILE_HASH_CACHE_MAX);
  touchLru(settledInodeHashCache, stamp, value, SETTLED_FILE_HASH_CACHE_MAX);
  const home = options.home || persistentStoreHome;
  if (home) {
    const store = openClientStore(home);
    if (store) {
      store.setFileDigest(filePath, stamp, value.sha256, value.size);
      store.setFileDigest(`inode:${stamp}`, stamp, value.sha256, value.size);
    }
  }
}

module.exports = { getSettledFileSha256, setSettledFileSha256, setSettledHashStoreHome };
