const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { createProjectionContext } = require("../electron/projection.cjs");

function createLedgerIndex(indexPath, ledgerRows, durableEndOffset) {
  const db = new DatabaseSync(indexPath);
  db.exec(`
    CREATE TABLE index_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE movements(
      seq INTEGER PRIMARY KEY,
      lamport INTEGER NOT NULL,
      recorded_at_unix_ms INTEGER NOT NULL,
      trace TEXT NOT NULL,
      kind TEXT NOT NULL,
      mark TEXT,
      from_kind TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_kind TEXT NOT NULL,
      to_id TEXT NOT NULL,
      artifact_id TEXT,
      artifact_label TEXT,
      artifact_content TEXT,
      runtime_run TEXT,
      runtime_checkpoint TEXT,
      runtime_interface TEXT,
      start_offset INTEGER,
      end_offset INTEGER
    );
    CREATE INDEX idx_mv_kind ON movements(kind, seq);
    CREATE INDEX idx_mv_mark ON movements(mark) WHERE mark IS NOT NULL;
    CREATE INDEX idx_mv_artifact ON movements(artifact_id) WHERE artifact_id IS NOT NULL;
    CREATE INDEX idx_mv_artifact_label ON movements(artifact_label, seq) WHERE artifact_label IS NOT NULL;
    CREATE INDEX idx_mv_runtime_run ON movements(runtime_run, seq) WHERE runtime_run IS NOT NULL;
  `);
  const insert = db.prepare(`
    INSERT INTO movements(
      seq, lamport, recorded_at_unix_ms, trace, kind, mark,
      from_kind, from_id, to_kind, to_id,
      artifact_id, artifact_label, artifact_content,
      runtime_run, runtime_checkpoint, runtime_interface,
      start_offset, end_offset
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const entry of ledgerRows) {
    const row = entry.row;
    const isMark = row.kind && typeof row.kind === "object" && typeof row.kind.MarkOutcomeAdmitted === "string";
    const kind = isMark ? "MarkOutcomeAdmitted" : String(row.kind);
    const mark = isMark ? row.kind.MarkOutcomeAdmitted : null;
    const artifactId = row.artifact?.id ?? null;
    const artifactLabel = artifactId ? artifactId.split(":")[0] : null;
    const artifactContent = row.artifact?.content ? Buffer.from(row.artifact.content).toString("hex") : null;
    const runtimeRun = isMark ? row.invocation_metadata?.run ?? null : row.invocation_metadata?.runtime?.run ?? null;
    const runtimeCheckpoint = row.invocation_metadata?.runtime?.checkpoint ?? null;
    const runtimeInterface = row.invocation_metadata?.runtime?.interface ?? null;
    insert.run(
      row.seq, row.lamport, row.recorded_at_unix_ms, row.trace, kind, mark,
      "interface", row.from.Interface, "interface", row.to.Interface,
      artifactId, artifactLabel, artifactContent,
      runtimeRun, runtimeCheckpoint, runtimeInterface,
      entry.startOffset, entry.endOffset,
    );
  }
  const meta = db.prepare("INSERT INTO index_meta(key, value) VALUES (?, ?)");
  meta.run("schema_version", "4");
  meta.run("watermark", String(ledgerRows.length));
  meta.run("durable_end_offset", String(durableEndOffset));
  db.close();
}

test("indexed ledger projection serves marks, artifacts, labels, snapshot, topology, and runs without full-ledger scan", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oct-indexed-ledger-")));
  for (const dir of ["ledger", "registry/interface/chat_iface", "registry/mark/check.passed", "state/runs", "state/ee_instances"]) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
  await fs.writeFile(path.join(root, "registry/interface/chat_iface/interface.json"), JSON.stringify({ id: "chat_iface", interface_type: "world", role: "client" }));
  await fs.writeFile(path.join(root, "registry/mark/check.passed/mark.json"), JSON.stringify({ name: "check.passed" }));
  await fs.writeFile(path.join(root, "state/runs/run-1.json"), JSON.stringify({
    id: "run-1", ee: "ee-1", worker: "worker-1", trace: "trace-1", status: "running", active_checkpoints: [],
    checkpoints: [{ id: "cp-1", run: "run-1", trace: "trace-1", epoch: 1, required_verified_artifacts: [{ mark: "check.passed", artifact_label: "tool.call", verifier: "v1", params: {} }] }],
  }));

  const hashA = Array(32).fill(0xaa);
  const hashB = Array(32).fill(0xbb);
  const hashC = Array(32).fill(0xcc);
  const baseRows = [
    {
      seq: 0, lamport: 1, recorded_at_unix_ms: 1000, trace: "trace-1",
      kind: "InterfaceArrival", from: { Interface: "chat_iface" }, to: { Interface: "worker-1" },
      artifact: { id: `operator.message:${"aa".repeat(32)}`, content: hashA },
      invocation_metadata: { runtime: { run: "run-1", ee: "ee-1", worker: "worker-1", checkpoint: "cp-1", interface: "chat_iface", epoch: 1 } },
    },
    {
      seq: 1, lamport: 2, recorded_at_unix_ms: 2000, trace: "trace-1",
      kind: { MarkOutcomeAdmitted: "check.passed" }, from: { Interface: "chat_iface" }, to: { Interface: "worker-1" },
      artifact: { id: `tool.call:${"bb".repeat(32)}`, content: hashB },
      invocation_metadata: { name: "check.passed", run: "run-1", run_epoch: 1, class: "success", evidence: { id: `tool.call:${"bb".repeat(32)}`, content: hashB }, subject: "cp-1", verifier: "v1", verifier_package: null, details: {} },
    },
    ...Array.from({ length: 50 }, (_, index) => ({
      seq: 2 + index, lamport: 3 + index, recorded_at_unix_ms: 3000 + index, trace: "trace-1",
      kind: "DeliveryRefused", from: { Interface: "chat_iface" }, to: { Interface: "worker-1" },
      artifact: { id: `tool.call:${"cc".repeat(32)}`, content: hashC },
      invocation_metadata: { runtime: { run: "run-1", ee: "ee-1", worker: "worker-1", checkpoint: "cp-1", interface: "chat_iface", epoch: 1 } },
    })),
  ];

  // Append one unindexed tail movement to verify index + tail composition
  const tailRow = {
    seq: 52, lamport: 53, recorded_at_unix_ms: 9000, trace: "trace-1",
    kind: { MarkOutcomeAdmitted: "tail.mark" }, from: { Interface: "chat_iface" }, to: { Interface: "worker-1" },
    artifact: { id: `tail.label:${"aa".repeat(32)}`, content: hashA },
    invocation_metadata: { name: "tail.mark", run: "run-1", run_epoch: 1, class: "success", evidence: { id: `tail.label:${"aa".repeat(32)}`, content: hashA }, subject: "cp-1", verifier: "v1", verifier_package: null, details: {} },
  };

  const ledgerPath = path.join(root, "ledger/movements.jsonl");
  let offset = 0;
  const indexedEntries = [];
  const lines = [];
  for (const row of baseRows) {
    const encoded = `${JSON.stringify(row)}\n`;
    const bytes = Buffer.byteLength(encoded, "utf8");
    indexedEntries.push({ row, startOffset: offset, endOffset: offset + bytes });
    offset += bytes;
    lines.push(encoded);
  }
  const durableEndOffset = offset;
  lines.push(`${JSON.stringify(tailRow)}\n`);
  await fs.writeFile(ledgerPath, lines.join(""), "utf8");
  createLedgerIndex(path.join(root, "ledger/ledger-index.sqlite"), indexedEntries, durableEndOffset);

  const store = createProjectionContext({
    resolveRepoRoot: () => root,
    octopusHome: () => root,
    sourceRegistry: () => path.join(root, "registry"),
    projectEePolicies: async () => ({ environments: [], issues: [] }),
  });
  let fullLedgerReads = 0;
  const originalReadLedger = store.readLedgerProjection;
  store.readLedgerProjection = (...args) => {
    fullLedgerReads += 1;
    return originalReadLedger(...args);
  };
  store.withFileProjectionPackages = async (projection) => projection;

  try {
    const marks = await store.readProjection({ contract_version: 1, method: "projection.marks.list", params: {} });
    assert.deepEqual(marks.marks.map((row) => row.mark_name), ["check.passed", "tail.mark"]);

    const artifacts = await store.readProjection({
      contract_version: 1,
      method: "projection.artifacts.list",
      params: { source: "ledger", limit: 100 },
    });
    assert.equal(artifacts.total, 4);
    assert.equal(artifacts.previewable_total, 1);

    const labels = await store.readProjection({
      contract_version: 1,
      method: "projection.descriptors.artifact_labels.list",
      params: { limit: 100 },
    });
    assert.deepEqual(labels.descriptors.map((row) => row.label), ["operator.message", "tail.label", "tool.call"]);

    const snapshot = await store.readProjection({
      contract_version: 1,
      method: "projection.runtime.snapshot",
      params: {},
    });
    assert.equal(snapshot.projection.ledger_loaded, true);
    assert.equal(snapshot.projection.ledger_rows, 53);
    assert.equal(snapshot.projection.latest_movement_seq, 52);

    const topology = await store.readProjection({
      contract_version: 1,
      method: "projection.runtime.topology",
      params: { include_ledger: true },
    });
    assert.equal(topology.marksRaw.marks.length, 2);
    assert.equal(topology.movementsRaw.total, 53);
    assert.equal(topology.runCheckpointsRaw.run_checkpoints[0].checkpoints[0].required_verified_artifacts[0].outcome, "closed");

    const runs = await store.readProjection({ contract_version: 1, method: "projection.runs.list", params: {} });
    assert.equal(runs.runs.length, 1);

    const envelopes = await store.readProjection({ contract_version: 1, method: "projection.envelopes.list", params: { limit: 10 } });
    assert.equal(envelopes.envelopes.length, 10);

    const pending = await store.readProjection({ contract_version: 1, method: "projection.interfaces.pending.list", params: {} });
    assert.deepEqual(pending.pending_artifacts, []);

    assert.equal(fullLedgerReads, 0, "indexed projection methods must never fall back to full movements.jsonl materialization");
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("incremental ledger, chat index, and required artifact caches reuse memory without reopening SQLite or blobs", async () => {
  const { blake3 } = require("@noble/hashes/blake3");
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oct-mem-reuse-")));
  for (const dir of ["ledger/blobs", "registry/interface/chat_iface", "state/runs", "state/ee_instances"]) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
  await fs.writeFile(path.join(root, "registry/interface/chat_iface/interface.json"), JSON.stringify({ id: "chat_iface", interface_type: "world", role: "client" }));
  await fs.writeFile(path.join(root, "state/runs/run-1.json"), JSON.stringify({
    id: "run-1", ee: "ee-1", worker: "worker-1", trace: "trace-1", status: "running", active_checkpoints: [], checkpoints: [],
  }));

  const writeBlob = async (value) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const hex = Buffer.from(blake3(bytes)).toString("hex");
    const file = path.join(root, "ledger/blobs", hex);
    await fs.writeFile(file, bytes);
    return { hex, file };
  };
  const payload = await writeBlob({ text: "cached-required-payload" });
  const manifest = await writeBlob({ label: "operator.message", payload_path: payload.file, payload_content_hash: payload.hex });
  const hashBytes = [...Buffer.from(manifest.hex, "hex")];

  const baseRow = {
    seq: 0, lamport: 1, recorded_at_unix_ms: 1000, trace: "trace-1",
    kind: "InterfaceArrival", from: { Interface: "chat_iface" }, to: { Interface: "worker-1" },
    artifact: { id: `operator.message:${manifest.hex}`, content: hashBytes },
    invocation_metadata: { runtime: { run: "run-1", ee: "ee-1", worker: "worker-1", checkpoint: "cp-1", interface: "chat_iface", epoch: 1 } },
  };
  const ledgerPath = path.join(root, "ledger/movements.jsonl");
  const indexPath = path.join(root, "ledger/ledger-index.sqlite");
  const firstLine = `${JSON.stringify(baseRow)}\n`;
  await fs.writeFile(ledgerPath, firstLine, "utf8");
  createLedgerIndex(indexPath, [{ row: baseRow, startOffset: 0, endOffset: Buffer.byteLength(firstLine, "utf8") }], Buffer.byteLength(firstLine, "utf8"));

  const store = createProjectionContext({
    resolveRepoRoot: () => root,
    octopusHome: () => root,
    sourceRegistry: () => path.join(root, "registry"),
    projectEePolicies: async () => ({ environments: [], issues: [] }),
  });
  store.withFileProjectionPackages = async (projection) => projection;

  try {
    // Round 1: cold load from SQLite + blob
    const snap1 = await store.readProjection({ contract_version: 1, method: "projection.runtime.snapshot", params: {} });
    assert.equal(snap1.projection.ledger_rows, 1);
    const chatRows1 = await store.readIndexedOperatorChatLedgerRows({ durableRoot: path.join(root, "ledger") }, new Set(["run-1"]));
    assert.equal(chatRows1.rowsByRun.get("run-1").length, 1);

    const artifactRow = chatRows1.rowsByRun.get("run-1")[0];
    const resolved1 = await store.resolveLedgerArtifactPayloads([artifactRow], true);
    assert.deepEqual(resolved1.get(artifactRow), { text: "cached-required-payload" });

    // Remove SQLite index and blob files from disk — subsequent reads and incremental appends MUST reuse memory!
    await fs.rm(indexPath);
    await fs.rm(payload.file);
    await fs.rm(manifest.file);

    // Bump generation and append a new movement to movements.jsonl
    const appendedRow = {
      seq: 1, lamport: 2, recorded_at_unix_ms: 2000, trace: "trace-1",
      kind: "InterfaceOutbound", from: { Interface: "worker-1" }, to: { Interface: "chat_iface" },
      artifact: { id: `operator.reply:${manifest.hex}`, content: hashBytes },
      invocation_metadata: { runtime: { run: "run-1", ee: "ee-1", worker: "worker-1", checkpoint: "cp-1", interface: "chat_iface", epoch: 1 } },
    };
    await fs.appendFile(ledgerPath, `${JSON.stringify(appendedRow)}\n`, "utf8");
    store.signalLedgerProjectionChange();

    const snap2 = await store.readProjection({ contract_version: 1, method: "projection.runtime.snapshot", params: {} });
    assert.equal(snap2.projection.ledger_rows, 2);
    assert.equal(snap2.projection.latest_movement_seq, 1);

    const chatRows2 = await store.readIndexedOperatorChatLedgerRows({ durableRoot: path.join(root, "ledger") }, new Set(["run-1"]));
    assert.equal(chatRows2.rowsByRun.get("run-1").length, 2);
    assert.equal(chatRows2.nextMovementSeq, 1);

    const delta = await store.readIndexedOperatorChatLedgerDelta({ durableRoot: path.join(root, "ledger") }, new Set(["run-1"]), 0);
    assert.equal(delta.rowsByRun.get("run-1").length, 1);
    assert.equal(delta.rowsByRun.get("run-1")[0].seq, 1);

    const resolved2 = await store.resolveLedgerArtifactPayloads([artifactRow], true);
    assert.deepEqual(resolved2.get(artifactRow), { text: "cached-required-payload" });
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("operatorChatIndex stays cached above 50,000 chat rows without reopening SQLite", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oct-chat-50k-")));
  for (const dir of ["ledger", "registry/interface/chat_iface", "state/runs", "state/ee_instances"]) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
  await fs.writeFile(path.join(root, "registry/interface/chat_iface/interface.json"), JSON.stringify({ id: "chat_iface", interface_type: "world", role: "client" }));

  const totalRows = 51_000;
  const ledgerPath = path.join(root, "ledger/movements.jsonl");
  const indexPath = path.join(root, "ledger/ledger-index.sqlite");
  const sampleLine = `${JSON.stringify({
    seq: 0, lamport: 1, recorded_at_unix_ms: 1000, trace: "t",
    kind: "InterfaceArrival", from: { Interface: "chat_iface" }, to: { Interface: "worker-1" },
    artifact: { id: `operator.message:${"aa".repeat(32)}`, content: Array(32).fill(0xaa) },
    invocation_metadata: { runtime: { run: "run-other", ee: "ee-1", worker: "worker-1", checkpoint: "cp-1", interface: "chat_iface", epoch: 1 } },
  })}\n`;
  const durableEndOffset = Buffer.byteLength(sampleLine, "utf8");
  await fs.writeFile(ledgerPath, sampleLine, "utf8");

  const db = new DatabaseSync(indexPath);
  db.exec(`
    CREATE TABLE index_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE movements(
      seq INTEGER PRIMARY KEY, lamport INTEGER NOT NULL, recorded_at_unix_ms INTEGER NOT NULL,
      trace TEXT NOT NULL, kind TEXT NOT NULL, mark TEXT,
      from_kind TEXT NOT NULL, from_id TEXT NOT NULL, to_kind TEXT NOT NULL, to_id TEXT NOT NULL,
      artifact_id TEXT, artifact_label TEXT, artifact_content TEXT,
      runtime_run TEXT, runtime_checkpoint TEXT, runtime_interface TEXT,
      start_offset INTEGER, end_offset INTEGER
    );
    CREATE INDEX idx_mv_kind ON movements(kind, seq);
    CREATE INDEX idx_mv_runtime_run ON movements(runtime_run, seq) WHERE runtime_run IS NOT NULL;
  `);
  db.exec("BEGIN");
  const insert = db.prepare(`
    INSERT INTO movements(
      seq, lamport, recorded_at_unix_ms, trace, kind, mark,
      from_kind, from_id, to_kind, to_id,
      artifact_id, artifact_label, artifact_content,
      runtime_run, runtime_checkpoint, runtime_interface,
      start_offset, end_offset
    ) VALUES (?, ?, ?, 't', ?, NULL, 'interface', 'chat_iface', 'interface', 'worker-1', ?, 'operator.message', ?, ?, 'cp-1', 'chat_iface', 0, ?)
  `);
  const hex = "aa".repeat(32);
  for (let seq = 0; seq < totalRows; seq += 1) {
    const kind = seq % 2 === 0 ? "InterfaceArrival" : "InterfaceOutbound";
    const runId = seq >= totalRows - 20 ? "run-active" : "run-other";
    insert.run(seq, seq + 1, 1000 + seq, kind, `operator.message:${hex}`, hex, runId, durableEndOffset);
  }
  const meta = db.prepare("INSERT INTO index_meta(key, value) VALUES (?, ?)");
  meta.run("schema_version", "4");
  meta.run("watermark", String(totalRows));
  meta.run("durable_end_offset", String(durableEndOffset));
  db.exec("COMMIT");
  db.close();

  const store = createProjectionContext({
    resolveRepoRoot: () => root,
    octopusHome: () => root,
    sourceRegistry: () => path.join(root, "registry"),
    projectEePolicies: async () => ({ environments: [], issues: [] }),
  });

  try {
    const first = await store.readIndexedOperatorChatLedgerRows({ durableRoot: path.join(root, "ledger") }, new Set(["run-active"]));
    assert.equal(first.rowsByRun.get("run-active").length, 20);
    assert.equal(first.nextMovementSeq, totalRows - 1);

    // Delete SQLite index — repeated polls & deltas MUST hit the in-memory bounded cache without reopening SQLite.
    await fs.rm(indexPath);

    const second = await store.readIndexedOperatorChatLedgerRows({ durableRoot: path.join(root, "ledger") }, new Set(["run-active"]));
    assert.equal(second.rowsByRun.get("run-active").length, 20);

    const delta = await store.readIndexedOperatorChatLedgerDelta({ durableRoot: path.join(root, "ledger") }, new Set(["run-active"]), totalRows - 5);
    assert.equal(delta.rowsByRun.get("run-active").length, 4);
    assert.equal(delta.nextMovementSeq, totalRows - 1);
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("sqliteClientStore and sqliteLogStore consolidate loose caches and enforce strict <= maxBytes log cap", async () => {
  const { closeClientStore, openClientStore } = require("../electron/sqliteClientStore.cjs");
  const { closeAllSqliteLogStores, openSqliteLogStore } = require("../electron/sqliteLogStore.cjs");
  const { getSettledFileSha256, setSettledFileSha256, setSettledHashStoreHome } = require("../electron/settledFileHashCache.cjs");

  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oct-sqlite-stores-")));
  try {
    const clientStore = openClientStore(root);
    clientStore.setChatPreview("run-1", { basis: "fp-1", files: [], text: "hello" });
    assert.deepEqual(clientStore.getChatPreview("run-1"), { basis: "fp-1", files: [], text: "hello" });
    clientStore.setChatTurn("run-1:turn-1", { basis: "fp-1", count: 2, rowsDigest: "abc", files: [], state: { text: "turn body" } });
    assert.deepEqual(clientStore.getChatTurn("run-1:turn-1").state, { text: "turn body" });

    const sampleFile = path.join(root, "settled.bin");
    const content = Buffer.from("immutable-asset-content");
    await fs.writeFile(sampleFile, content);
    const oldTime = new Date(Date.now() - 10_000);
    await fs.utimes(sampleFile, oldTime, oldTime);
    const sampleStat = await fs.stat(sampleFile);
    const expectedHash = "ab".repeat(32);

    setSettledHashStoreHome(root);
    setSettledFileSha256(sampleFile, sampleStat, { sha256: expectedHash, size: content.length });
    const hit1 = getSettledFileSha256(sampleFile, sampleStat);
    assert.deepEqual(hit1, { sha256: expectedHash, size: content.length });
    // Verify hardlink / alternate path to same inode gets instant persistent SQLite hit.
    if (process.platform !== "win32") {
      const linkedPath = path.join(root, "linked.bin");
      await fs.link(sampleFile, linkedPath);
      const linkedStat = await fs.stat(linkedPath);
      assert.deepEqual(getSettledFileSha256(linkedPath, linkedStat), { sha256: expectedHash, size: content.length });
    } else {
      assert.deepEqual(
        getSettledFileSha256(path.join(root, "alias-same-inode.bin"), sampleStat),
        { sha256: expectedHash, size: content.length },
      );
    }

    // Ensure zero loose cache files under client/projection-cache.
    await assert.rejects(() => fs.stat(path.join(root, "client/projection-cache")));

    // Strict bounded SQLite log store test (256 KiB cap, write > 1 MiB of messages).
    const capBytes = 256 * 1024;
    const logStore = openSqliteLogStore(root, { maxBytes: capBytes });
    const payload = "x".repeat(4096);
    for (let batch = 0; batch < 16; batch += 1) {
      const lines = [];
      for (let i = 0; i < 20; i += 1) {
        lines.push(`batch-${batch}-msg-${i}:${payload}`);
      }
      logStore.appendLines("runtime", "info", lines.join("\n"));
    }
    const usage = logStore.diskUsageBytes();
    assert.ok(usage <= capBytes, `expected log DB usage (${usage}) <= capBytes (${capBytes})`);
    const recent = logStore.readTail(5);
    assert.equal(recent.length, 5);
    assert.ok(recent[recent.length - 1].message.startsWith("batch-15-"), "newest log entries must be retained after pruning");
  } finally {
    setSettledHashStoreHome("");
    closeClientStore(root);
    closeAllSqliteLogStores();
    await fs.rm(root, { recursive: true, force: true });
  }
});
