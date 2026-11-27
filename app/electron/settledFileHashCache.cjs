const SETTLED_FILE_HASH_CACHE_MAX = 8_192;
const SETTLED_WINDOW_MS = 2_000;

const settledFileHashCache = new Map();

function fileStamp(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mode}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function isSettledStat(stat, observedAtMs) {
  const newestMs = Math.max(stat.mtimeMs, stat.ctimeMs);
  return Number.isFinite(newestMs) && observedAtMs - newestMs >= SETTLED_WINDOW_MS;
}

function getSettledFileSha256(filePath, stat, observedAtMs = Date.now()) {
  if (!isSettledStat(stat, observedAtMs)) return null;
  const cached = settledFileHashCache.get(filePath);
  if (!cached || cached.stamp !== fileStamp(stat)) return null;
  settledFileHashCache.delete(filePath);
  settledFileHashCache.set(filePath, cached);
  return { sha256: cached.sha256, size: cached.size };
}

function setSettledFileSha256(filePath, stat, content, observedAtMs = Date.now()) {
  if (!isSettledStat(stat, observedAtMs)) return;
  if (settledFileHashCache.has(filePath)) settledFileHashCache.delete(filePath);
  settledFileHashCache.set(filePath, {
    stamp: fileStamp(stat),
    sha256: content.sha256,
    size: content.size,
  });
  while (settledFileHashCache.size > SETTLED_FILE_HASH_CACHE_MAX) {
    const oldest = settledFileHashCache.keys().next().value;
    if (oldest === undefined) break;
    settledFileHashCache.delete(oldest);
  }
}

module.exports = { getSettledFileSha256, setSettledFileSha256 };
