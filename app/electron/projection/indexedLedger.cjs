module.exports = { indexedLedgerProjection };

const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { artifactMovementCoordinates, compareArtifactMovementNewest, indexedUnsignedInteger, movementBaseKind, movementKindText, movementRunId, normalizeIndexedProjectionMovement, openValidatedLedgerIndex, projectMovementRows } = require("./movementRows.cjs");
const { descriptorRows, eeInstanceRows, formatMarkRows, formatProjectionSnapshot, preserveProjectionEvidenceError, runRows } = require("./registryRows.cjs");
const { arrayValue, dedupeRows, isAdmittedInterfaceArtifactMovement, ledgerArtifactId, ledgerArtifactLabel, numberValue, objectOrEmpty, rowTimeMs, stringValue, timestampOf } = require("./values.cjs");

const INDEXED_MOVEMENT_COLUMNS = `
  seq, lamport, recorded_at_unix_ms, trace, kind, mark,
  from_kind, from_id, to_kind, to_id,
  artifact_id, artifact_content,
  runtime_run, runtime_checkpoint, runtime_interface`;

const DEFAULT_INDEXED_ENVELOPES_LIMIT = 5_000;

function indexedLedgerProjection(store) {
  function cachedIndexedResult(projection, key, build) {
    if (!projection.indexedLedgerCache) projection.indexedLedgerCache = new Map();
    const generation = store.projectionGeneration;
    const cached = projection.indexedLedgerCache.get(key);
    if (cached && cached.generation === generation) return cached.promise;
    for (const [existingKey, existing] of projection.indexedLedgerCache) {
      if (existing.generation !== generation) projection.indexedLedgerCache.delete(existingKey);
    }
    const promise = Promise.resolve().then(build);
    projection.indexedLedgerCache.set(key, { generation, promise });
    promise.catch(() => {
      if (projection.indexedLedgerCache?.get(key)?.promise === promise) {
        projection.indexedLedgerCache.delete(key);
      }
    });
    return promise;
  }

  async function streamLedgerTail(ledgerPath, startOffset, expectedSeq, onMovement, options = {}) {
    let stat;
    try {
      stat = await fs.stat(ledgerPath);
    } catch (error) {
      if (error?.code === "ENOENT" && startOffset === 0) return { nextSeq: expectedSeq, tailCount: 0, invalidRows: [] };
      throw error;
    }
    if (stat.size < startOffset) return null;
    if (stat.size === startOffset) return { nextSeq: expectedSeq, tailCount: 0, invalidRows: [] };
    const strictSeq = options.strictSeq !== false;
    const collectInvalid = options.collectInvalid === true;
    const invalidRows = [];
    let tailCount = 0;
    let lineNumber = expectedSeq;
    let pending = [];
    let pendingLength = 0;
    for await (const chunk of fsSync.createReadStream(ledgerPath, { start: startOffset, end: stat.size - 1 })) {
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, start);
        if (newline < 0) break;
        const fragment = chunk.subarray(start, newline);
        const raw = pendingLength
          ? Buffer.concat([...pending, fragment], pendingLength + fragment.length)
          : fragment;
        start = newline + 1;
        pending = [];
        pendingLength = 0;
        const end = raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.length - 1 : raw.length;
        const trimmed = end === raw.length ? raw : raw.subarray(0, end);
        lineNumber += 1;
        if (!trimmed.length) continue;
        let movement;
        try {
          movement = store.parseCanonicalMovement(trimmed, ledgerPath, lineNumber);
        } catch (error) {
          if (!collectInvalid) throw error;
          invalidRows.push({ source_path: ledgerPath, source_line: lineNumber, error: String(error?.message ?? error) });
          continue;
        }
        const seq = indexedUnsignedInteger(movement?.seq);
        if (strictSeq && (seq === null || seq !== expectedSeq)) return null;
        if (seq !== null) expectedSeq = Math.max(expectedSeq, seq + 1);
        tailCount += 1;
        const projected = {
          ...movement,
          kind: movementKindText(movement.kind),
          envelope_id: stringValue(movement.envelope_id ?? movement.id) || `movements:${lineNumber}`,
          source_file: ledgerPath,
          source_line: lineNumber,
        };
        onMovement(projected);
      }
      if (start < chunk.length) {
        const remainder = chunk.subarray(start);
        pending.push(remainder);
        pendingLength += remainder.length;
      }
    }
    return { nextSeq: expectedSeq, tailCount, invalidRows };
  }

  function looseDistinctColumnValues(database, column, watermark) {
    return database.prepare(`
      WITH RECURSIVE distinct_values(value) AS (
        SELECT MIN(${column}) FROM movements WHERE ${column} IS NOT NULL AND seq < ?
        UNION ALL
        SELECT (
          SELECT MIN(${column}) FROM movements
          WHERE ${column} > distinct_values.value AND ${column} IS NOT NULL AND seq < ?
        )
        FROM distinct_values WHERE distinct_values.value IS NOT NULL
      )
      SELECT value FROM distinct_values WHERE value IS NOT NULL
    `).all(watermark, watermark).map((row) => stringValue(row.value)).filter(Boolean);
  }

  async function readIndexedRawMovementsByOffsets(ledgerPath, offsetRows) {
    if (offsetRows.length === 0) return [];
    const results = [];
    const handle = await fs.open(ledgerPath, "r");
    try {
      for (const row of offsetRows) {
        const startOffset = indexedUnsignedInteger(row.start_offset);
        const endOffset = indexedUnsignedInteger(row.end_offset);
        if (startOffset === null || endOffset === null || endOffset <= startOffset) continue;
        const length = endOffset - startOffset;
        if (length > 16 * 1024 * 1024) continue;
        const buffer = Buffer.allocUnsafe(length);
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await handle.read(buffer, filled, length - filled, startOffset + filled);
          if (!bytesRead) break;
          filled += bytesRead;
        }
        if (filled !== length) continue;
        const trimmed = buffer.toString("utf8").trim();
        if (!trimmed) continue;
        try {
          results.push(JSON.parse(trimmed));
        } catch {}
      }
    } finally {
      await handle.close();
    }
    return results;
  }

  function accumulateArtifactRow(ledgerArtifacts, row) {
    const artifactId = ledgerArtifactId(row);
    if (!artifactId) return;
    const coordinates = artifactMovementCoordinates(row);
    const previewRank = isAdmittedInterfaceArtifactMovement(row)
      ? (coordinates.runId && coordinates.interfaceId ? 2 : 1)
      : 0;
    const current = ledgerArtifacts.get(artifactId);
    if (
      !current
      || previewRank > current.previewRank
      || (previewRank === current.previewRank && compareArtifactMovementNewest(row, current.row) < 0)
    ) {
      ledgerArtifacts.set(artifactId, { coordinates, previewRank, row });
    }
  }

  function finalizeLedgerArtifacts(ledgerArtifacts) {
    return [...ledgerArtifacts.entries()].map(([artifactId, entry]) => {
      const runtime = objectOrEmpty(objectOrEmpty(entry.row.invocation_metadata).runtime);
      return {
        artifact_id: artifactId,
        label: ledgerArtifactLabel(entry.row),
        route_label: "",
        run_id: entry.coordinates.runId,
        interface_id: entry.coordinates.interfaceId,
        ee_id: stringValue(runtime.ee),
        worker: stringValue(runtime.worker),
        status: "recorded",
        created_at: timestampOf(entry.row),
        seq: numberValue(entry.row.seq, null),
        movement_kind: stringValue(entry.row.kind),
        previewable: entry.previewRank === 2,
        source: "ledger",
        raw: entry.row,
      };
    }).sort((left, right) => (
      compareArtifactMovementNewest(left.raw, right.raw)
      || stringValue(left.artifact_id).localeCompare(stringValue(right.artifact_id))
    ));
  }

  async function readIndexedMarkRows(projection) {
    return cachedIndexedResult(projection, "markRows", async () => {
      const index = await openValidatedLedgerIndex(projection);
      if (index) {
        try {
          const rows = index.database.prepare(
            `SELECT ${INDEXED_MOVEMENT_COLUMNS}
             FROM movements
             WHERE kind = 'MarkOutcomeAdmitted' AND seq < ?
             ORDER BY seq ASC`,
          ).all(index.watermark).map((row) => normalizeIndexedProjectionMovement(row, index.ledgerPath));
          const tail = await streamLedgerTail(
            index.ledgerPath,
            index.durableEndOffset,
            index.watermark,
            (movement) => {
              if (movementBaseKind(movement) === "MarkOutcomeAdmitted") rows.push(movement);
            },
          );
          if (tail !== null) return formatMarkRows(projection, rows);
        } catch (error) {
          preserveProjectionEvidenceError(error);
        } finally {
          index.database.close();
        }
      }
      // Streaming fallback: never retain unrelated (e.g. DeliveryRefused) rows in heap
      const ledgerPath = path.join(projection.durableRoot, "movements.jsonl");
      const matched = [];
      await streamLedgerTail(
        ledgerPath,
        0,
        0,
        (movement) => {
          if (movementBaseKind(movement) === "MarkOutcomeAdmitted") matched.push(movement);
        },
        { strictSeq: false, collectInvalid: true },
      );
      return formatMarkRows(projection, matched);
    });
  }

  async function readIndexedLedgerArtifactRows(projection) {
    return cachedIndexedResult(projection, "ledgerArtifactRows", async () => {
      const index = await openValidatedLedgerIndex(projection);
      if (index) {
        try {
          const ledgerArtifacts = new Map();
          const kinds = looseDistinctColumnValues(index.database, "kind", index.watermark)
            .filter((kind) => kind !== "DeliveryRefused");
          if (kinds.length > 0) {
            const placeholders = kinds.map(() => "?").join(", ");
            const rows = index.database.prepare(
              `SELECT ${INDEXED_MOVEMENT_COLUMNS}
               FROM movements
               WHERE kind IN (${placeholders}) AND seq < ? AND artifact_id IS NOT NULL`,
            ).all(...kinds, index.watermark);
            for (const row of rows) {
              accumulateArtifactRow(ledgerArtifacts, normalizeIndexedProjectionMovement(row, index.ledgerPath));
            }
          }
          const distinctArtifactIds = looseDistinctColumnValues(index.database, "artifact_id", index.watermark);
          const latestByArtifactStmt = index.database.prepare(
            `SELECT ${INDEXED_MOVEMENT_COLUMNS}
             FROM movements
             WHERE artifact_id = ? AND seq < ?
             ORDER BY seq DESC
             LIMIT 1`,
          );
          for (const artifactId of distinctArtifactIds) {
            if (ledgerArtifacts.has(artifactId)) continue;
            const row = latestByArtifactStmt.get(artifactId, index.watermark);
            if (row) accumulateArtifactRow(ledgerArtifacts, normalizeIndexedProjectionMovement(row, index.ledgerPath));
          }
          const tail = await streamLedgerTail(
            index.ledgerPath,
            index.durableEndOffset,
            index.watermark,
            (movement) => accumulateArtifactRow(ledgerArtifacts, movement),
          );
          if (tail !== null) return finalizeLedgerArtifacts(ledgerArtifacts);
        } catch (error) {
          preserveProjectionEvidenceError(error);
        } finally {
          index.database.close();
        }
      }
      // Streaming deduplicating fallback: O(distinct artifacts) heap even without SQLite index
      const ledgerPath = path.join(projection.durableRoot, "movements.jsonl");
      const ledgerArtifacts = new Map();
      await streamLedgerTail(
        ledgerPath,
        0,
        0,
        (movement) => accumulateArtifactRow(ledgerArtifacts, movement),
        { strictSeq: false, collectInvalid: true },
      );
      return finalizeLedgerArtifacts(ledgerArtifacts);
    });
  }

  async function readIndexedArtifactRows(projection) {
    const registryArtifacts = descriptorRows(projection, "artifact").map((row) => ({
      ...row,
      artifact_id: stringValue(row.id) || stringValue(row.name),
      label: stringValue(row.label) || stringValue(row.id) || stringValue(row.name),
      status: "registered",
      route_label: stringValue(row.route_label),
      created_at: stringValue(row.created_at),
    }));
    const ledgerArtifacts = await readIndexedLedgerArtifactRows(projection);
    return dedupeRows([...registryArtifacts, ...ledgerArtifacts], "artifact_id");
  }

  async function readIndexedArtifactLabelRows(projection) {
    return cachedIndexedResult(projection, "artifactLabelRows", async () => {
      const byLabel = new Map();
      for (const artifact of descriptorRows(projection, "artifact")) {
        const label = stringValue(artifact.label) || stringValue(artifact.id) || stringValue(artifact.name);
        if (!label || byLabel.has(label)) continue;
        byLabel.set(label, {
          label,
          lifecycle: stringValue(artifact.lifecycle) || "registered",
          allowed_writers: arrayValue(artifact.allowed_writers),
          finalize_recommended: Boolean(artifact.finalize_recommended),
          source: stringValue(artifact.source) || "projection.artifacts",
        });
      }
      const addLedgerLabel = (label) => {
        if (!label || byLabel.has(label)) return;
        byLabel.set(label, {
          label,
          lifecycle: "recorded",
          allowed_writers: [],
          finalize_recommended: false,
          source: "ledger",
        });
      };
      const index = await openValidatedLedgerIndex(projection);
      if (index) {
        try {
          for (const label of looseDistinctColumnValues(index.database, "artifact_label", index.watermark)) {
            addLedgerLabel(label);
          }
          const tail = await streamLedgerTail(
            index.ledgerPath,
            index.durableEndOffset,
            index.watermark,
            (movement) => addLedgerLabel(ledgerArtifactLabel(movement)),
          );
          if (tail !== null) {
            return Array.from(byLabel.values()).sort((a, b) => a.label.localeCompare(b.label));
          }
        } catch (error) {
          preserveProjectionEvidenceError(error);
        } finally {
          index.database.close();
        }
      }
      // Streaming fallback
      const ledgerPath = path.join(projection.durableRoot, "movements.jsonl");
      await streamLedgerTail(
        ledgerPath,
        0,
        0,
        (movement) => addLedgerLabel(ledgerArtifactLabel(movement)),
        { strictSeq: false, collectInvalid: true },
      );
      return Array.from(byLabel.values()).sort((a, b) => a.label.localeCompare(b.label));
    });
  }

  async function readIndexedProjectionSnapshot(projection) {
    return cachedIndexedResult(projection, "projectionSnapshot", async () => {
      const index = await openValidatedLedgerIndex(projection);
      if (!index) return null;
      try {
        const latestIndexed = index.watermark > 0
          ? index.database.prepare(
            "SELECT seq, recorded_at_unix_ms FROM movements WHERE seq < ? ORDER BY seq DESC LIMIT 1",
          ).get(index.watermark)
          : null;
        let latest = latestIndexed
          ? {
            seq: numberValue(latestIndexed.seq, 0),
            recorded_at_unix_ms: numberValue(latestIndexed.recorded_at_unix_ms, 0),
          }
          : null;
        const tail = await streamLedgerTail(
          index.ledgerPath,
          index.durableEndOffset,
          index.watermark,
          (movement) => {
            const at = numberValue(movement.recorded_at_unix_ms ?? movement.wall_clock_unix_ms, 0);
            const seq = numberValue(movement.seq, 0);
            if (!latest || at > latest.recorded_at_unix_ms || (at === latest.recorded_at_unix_ms && seq > latest.seq)) {
              latest = { seq, recorded_at_unix_ms: at };
            }
          },
          { collectInvalid: true },
        );
        if (tail === null) return null;
        return formatProjectionSnapshot(projection, {
          ledgerLoaded: true,
          ledgerRowCount: index.watermark + tail.tailCount,
          latestMovement: latest,
          invalidLedgerRows: tail.invalidRows,
        });
      } catch (error) {
        preserveProjectionEvidenceError(error);
        return null;
      } finally {
        index.database.close();
      }
    });
  }

  async function readIndexedOutcomeIndex(projection) {
    return cachedIndexedResult(projection, "outcomeIndex", async () => {
      const index = await openValidatedLedgerIndex(projection);
      if (!index) return null;
      try {
        const outcomes = new Map();
        const admitted = index.database.prepare(
          "SELECT runtime_run, mark FROM movements WHERE kind = 'MarkOutcomeAdmitted' AND seq < ? AND runtime_run IS NOT NULL AND mark IS NOT NULL",
        ).all(index.watermark);
        for (const row of admitted) {
          const runId = stringValue(row.runtime_run);
          const markId = stringValue(row.mark);
          if (runId && markId) outcomes.set(`${runId}\u0000${markId}`, "closed");
        }
        const failedOffsets = index.database.prepare(
          "SELECT start_offset, end_offset FROM movements WHERE kind = 'VerificationFailed' AND seq < ?",
        ).all(index.watermark);
        const failedMovements = await readIndexedRawMovementsByOffsets(index.ledgerPath, failedOffsets);
        for (const row of failedMovements) {
          const runId = movementRunId(row);
          const markId = stringValue(objectOrEmpty(objectOrEmpty(row.invocation_metadata).verification_failure).mark);
          if (!runId || !markId) continue;
          const key = `${runId}\u0000${markId}`;
          if (outcomes.get(key) !== "closed") outcomes.set(key, "failed");
        }
        const tail = await streamLedgerTail(
          index.ledgerPath,
          index.durableEndOffset,
          index.watermark,
          (row) => {
            const runId = movementRunId(row);
            if (!runId) return;
            const match = /^MarkOutcomeAdmitted\((.+)\)$/.exec(stringValue(row.kind));
            if (match?.[1]) {
              outcomes.set(`${runId}\u0000${match[1]}`, "closed");
              return;
            }
            if (row.kind !== "VerificationFailed") return;
            const markId = stringValue(objectOrEmpty(objectOrEmpty(row.invocation_metadata).verification_failure).mark);
            if (!markId) return;
            const key = `${runId}\u0000${markId}`;
            if (outcomes.get(key) !== "closed") outcomes.set(key, "failed");
          },
        );
        if (tail === null) return null;
        return outcomes;
      } catch (error) {
        preserveProjectionEvidenceError(error);
        return null;
      } finally {
        index.database.close();
      }
    });
  }

  async function readIndexedRunRows(projection) {
    return cachedIndexedResult(projection, "runRows", async () => {
      const index = await openValidatedLedgerIndex(projection);
      if (!index) return null;
      try {
        const byRun = new Map(runRows(projection, false).map((row) => [row.run_id, row]));
        const distinctRuns = looseDistinctColumnValues(index.database, "runtime_run", index.watermark);
        const missingRuns = distinctRuns.filter((runId) => byRun.get(runId)?.source !== "run_record");
        if (missingRuns.length > 0) {
          const firstRowStmt = index.database.prepare(
            "SELECT start_offset, end_offset FROM movements WHERE runtime_run = ? AND seq < ? ORDER BY seq DESC LIMIT 1",
          );
          const offsetRows = [];
          for (const runId of missingRuns) {
            const match = firstRowStmt.get(runId, index.watermark);
            if (match) offsetRows.push(match);
          }
          const rawMovements = await readIndexedRawMovementsByOffsets(index.ledgerPath, offsetRows);
          for (const row of rawMovements) {
            const runtime = objectOrEmpty(objectOrEmpty(row.invocation_metadata).runtime);
            const runId = stringValue(runtime.run);
            const eeId = stringValue(runtime.ee);
            const worker = stringValue(runtime.worker);
            if (!runId || !eeId || !worker || byRun.get(runId)?.source === "run_record") continue;
            byRun.set(runId, {
              run_id: runId,
              status: "recorded",
              worker,
              ee_id: eeId,
              created_at: timestampOf(row),
              meta: {},
              source: "ledger",
            });
          }
        }
        const tail = await streamLedgerTail(
          index.ledgerPath,
          index.durableEndOffset,
          index.watermark,
          (row) => {
            const runtime = objectOrEmpty(objectOrEmpty(row.invocation_metadata).runtime);
            const runId = stringValue(runtime.run);
            const eeId = stringValue(runtime.ee);
            const worker = stringValue(runtime.worker);
            if (!runId || !eeId || !worker || byRun.get(runId)?.source === "run_record") return;
            const current = byRun.get(runId) || {
              run_id: runId,
              status: "recorded",
              worker,
              ee_id: eeId,
              created_at: timestampOf(row),
              meta: {},
              source: "ledger",
            };
            current.worker = worker;
            current.ee_id = eeId;
            byRun.set(runId, current);
          },
        );
        if (tail === null) return null;
        return Array.from(byRun.values());
      } catch (error) {
        preserveProjectionEvidenceError(error);
        return null;
      } finally {
        index.database.close();
      }
    });
  }

  async function readIndexedEeInstanceRows(projection) {
    const runs = await readIndexedRunRows(projection);
    if (!runs) return null;
    const base = eeInstanceRows(projection, false);
    const byEe = new Map(base.map((row) => [row.ee_id, { ...row }]));
    const recordedRunIds = new Set(runRows(projection, false).map((row) => row.run_id));
    for (const run of runs) {
      if (recordedRunIds.has(run.run_id)) continue;
      const eeId = stringValue(run.ee_id);
      if (!eeId) continue;
      const current = byEe.get(eeId) ?? {
        ee_id: eeId,
        template_name: "",
        status: "projected",
        goal_id: "",
        goal: "",
        parent_ee_id: "",
        created_at: stringValue(run.created_at),
        projection_kind: "run.ee_reference",
        runtime_state: "projected_from_run_evidence",
        run_count: 0,
        source: "run_evidence",
      };
      current.run_count += 1;
      if (!current.created_at) current.created_at = stringValue(run.created_at);
      byEe.set(eeId, current);
    }
    return Array.from(byEe.values());
  }

  async function readIndexedRunCheckpointRows(projection, runId) {
    const index = await openValidatedLedgerIndex(projection);
    if (!index) return null;
    try {
      const rows = index.database.prepare(
        `SELECT ${INDEXED_MOVEMENT_COLUMNS}
         FROM movements
         WHERE runtime_run = ? AND seq < ? AND runtime_checkpoint IS NOT NULL AND kind != 'DeliveryRefused'
         ORDER BY seq ASC`,
      ).all(runId, index.watermark).map((row) => normalizeIndexedProjectionMovement(row, index.ledgerPath));
      const tail = await streamLedgerTail(
        index.ledgerPath,
        index.durableEndOffset,
        index.watermark,
        (movement) => {
          if (movementRunId(movement) === runId && movementBaseKind(movement) !== "DeliveryRefused") {
            rows.push(movement);
          }
        },
      );
      if (tail === null) return null;
      rows.sort((a, b) => rowTimeMs(a) - rowTimeMs(b));
      const checkpoints = new Map();
      for (const row of rows) {
        const runtime = objectOrEmpty(objectOrEmpty(row.invocation_metadata).runtime);
        if (stringValue(runtime.run) !== runId) continue;
        const checkpointId = stringValue(runtime.checkpoint);
        if (!checkpointId) continue;
        const current = checkpoints.get(checkpointId) ?? {
          checkpoint_id: checkpointId,
          label: checkpointId,
          status: "made",
          interface: "",
          out_interfaces: [],
          artifact_label: "",
          artifact_bindings: 0,
          interface_bindings: 0,
          recorded_at_unix_ms: rowTimeMs(row),
        };
        current.artifact_bindings += row.artifact ? 1 : 0;
        if (movementBaseKind(row) === "InterfaceArrival") {
          const interfaceId = stringValue(row.from?.Interface);
          current.interface = interfaceId || current.interface;
          current.artifact_label = ledgerArtifactLabel(row) || current.artifact_label;
        }
        if (movementBaseKind(row) === "InterfaceOutbound") {
          const interfaceId = stringValue(row.to?.Interface);
          if (interfaceId && !current.out_interfaces.includes(interfaceId)) current.out_interfaces.push(interfaceId);
        }
        current.interface_bindings = (current.interface ? 1 : 0) + current.out_interfaces.length;
        checkpoints.set(checkpointId, current);
      }
      return Array.from(checkpoints.values());
    } catch (error) {
      preserveProjectionEvidenceError(error);
      return null;
    } finally {
      index.database.close();
    }
  }

  async function readIndexedWorkerEnvironmentRows(projection) {
    const rows = arrayValue(projection.workerEnvironments);
    if (rows.length === 0) return rows;
    const index = await openValidatedLedgerIndex(projection);
    if (!index) return null;
    try {
      const wanted = [...new Set(
        rows.flatMap((row) => [row.opened_at_movement_seq, row.last_activity_movement_seq])
          .filter(Number.isSafeInteger),
      )];
      const recordedAt = new Map();
      if (wanted.length > 0) {
        const stmt = index.database.prepare("SELECT seq, recorded_at_unix_ms FROM movements WHERE seq = ? AND seq < ?");
        for (const seq of wanted) {
          const found = stmt.get(seq, index.watermark);
          if (found) recordedAt.set(seq, numberValue(found.recorded_at_unix_ms, 0) || null);
        }
      }
      const wantedSet = new Set(wanted);
      const tail = await streamLedgerTail(
        index.ledgerPath,
        index.durableEndOffset,
        index.watermark,
        (movement) => {
          const seq = movement?.seq;
          if (wantedSet.has(seq)) {
            recordedAt.set(seq, numberValue(movement.recorded_at_unix_ms ?? movement.wall_clock_unix_ms, 0) || null);
          }
        },
      );
      if (tail === null) return null;
      return rows.map((row) => ({
        ...row,
        opened_at_unix_ms: recordedAt.get(row.opened_at_movement_seq) ?? null,
        last_activity_at_unix_ms: recordedAt.get(row.last_activity_movement_seq) ?? null,
      }));
    } catch (error) {
      preserveProjectionEvidenceError(error);
      return null;
    } finally {
      index.database.close();
    }
  }

  async function readIndexedRecentMovementRows(projection, limit = 1_000) {
    const index = await openValidatedLedgerIndex(projection);
    if (!index) return null;
    try {
      const count = Math.max(1, numberValue(limit, 1_000));
      const indexedRows = index.database.prepare(
        `SELECT ${INDEXED_MOVEMENT_COLUMNS}
         FROM movements
         WHERE seq < ?
         ORDER BY seq DESC
         LIMIT ?`,
      ).all(index.watermark, count).map((row) => normalizeIndexedProjectionMovement(row, index.ledgerPath));
      const tailRows = [];
      const tail = await streamLedgerTail(
        index.ledgerPath,
        index.durableEndOffset,
        index.watermark,
        (movement) => {
          tailRows.push(movement);
          if (tailRows.length > count * 2) tailRows.splice(0, tailRows.length - count);
        },
      );
      if (tail === null) return null;
      const movements = projectMovementRows(projection, [...indexedRows, ...tailRows.slice(-count)]).slice(0, count);
      return { movements, total: index.watermark + tail.tailCount };
    } catch (error) {
      preserveProjectionEvidenceError(error);
      return null;
    } finally {
      index.database.close();
    }
  }

  async function readIndexedEnvelopes(projection, params = {}) {
    const index = await openValidatedLedgerIndex(projection);
    if (!index) return null;
    try {
      const requestedLimit = numberValue(params?.limit, 0);
      const limit = requestedLimit > 0 ? Math.min(50_000, requestedLimit) : DEFAULT_INDEXED_ENVELOPES_LIMIT;
      const kindFilter = stringValue(params?.kind);
      const runFilter = stringValue(params?.run_id);
      const predicates = ["seq < ?"];
      const values = [index.watermark];
      if (runFilter) {
        predicates.push("runtime_run = ?");
        values.push(runFilter);
      }
      if (kindFilter) {
        const markMatch = /^MarkOutcomeAdmitted\((.+)\)$/.exec(kindFilter);
        if (markMatch) {
          predicates.push("kind = 'MarkOutcomeAdmitted' AND mark = ?");
          values.push(markMatch[1]);
        } else {
          predicates.push("kind = ?");
          values.push(kindFilter);
        }
      }
      const rows = index.database.prepare(
        `SELECT ${INDEXED_MOVEMENT_COLUMNS}
         FROM movements
         WHERE ${predicates.join(" AND ")}
         ORDER BY seq ASC
         LIMIT ?`,
      ).all(...values, limit).map((row) => {
        const normalized = normalizeIndexedProjectionMovement(row, index.ledgerPath);
        return { ...normalized, ts: timestampOf(normalized) };
      });
      if (rows.length < limit) {
        const tail = await streamLedgerTail(
          index.ledgerPath,
          index.durableEndOffset,
          index.watermark,
          (movement) => {
            if (rows.length >= limit) return;
            if (runFilter && movementRunId(movement) !== runFilter) return;
            if (kindFilter && stringValue(movement.kind) !== kindFilter) return;
            rows.push({ ...movement, ts: timestampOf(movement) });
          },
        );
        if (tail === null) return null;
      }
      return rows;
    } catch (error) {
      preserveProjectionEvidenceError(error);
      return null;
    } finally {
      index.database.close();
    }
  }

  async function readIndexedEnvelopesForRuns(projection, runIds, perRunLimit = 80) {
    const index = await openValidatedLedgerIndex(projection);
    if (!index) return null;
    try {
      const envelopesByRun = new Map();
      const stmt = index.database.prepare(
        `SELECT ${INDEXED_MOVEMENT_COLUMNS}
         FROM movements
         WHERE runtime_run = ? AND seq < ?
         ORDER BY seq ASC
         LIMIT ?`,
      );
      const neededRuns = new Set();
      for (const runId of runIds) {
        const rows = stmt.all(runId, index.watermark, perRunLimit).map((row) => {
          const normalized = normalizeIndexedProjectionMovement(row, index.ledgerPath);
          return { ...normalized, ts: timestampOf(normalized) };
        });
        envelopesByRun.set(runId, rows);
        if (rows.length < perRunLimit) neededRuns.add(runId);
      }
      if (neededRuns.size > 0) {
        const tail = await streamLedgerTail(
          index.ledgerPath,
          index.durableEndOffset,
          index.watermark,
          (movement) => {
            const runId = movementRunId(movement);
            if (!neededRuns.has(runId)) return;
            const list = envelopesByRun.get(runId);
            if (list && list.length < perRunLimit) {
              list.push({ ...movement, ts: timestampOf(movement) });
            }
          },
        );
        if (tail === null) return null;
      }
      return envelopesByRun;
    } catch (error) {
      preserveProjectionEvidenceError(error);
      return null;
    } finally {
      index.database.close();
    }
  }

  async function readIndexedPendingArtifacts(projection) {
    const index = await openValidatedLedgerIndex(projection);
    if (!index) return null;
    try {
      // Canonical indexed movements never carry a pending/open/in_flight status field.
      const pending = [];
      const tail = await streamLedgerTail(
        index.ledgerPath,
        index.durableEndOffset,
        index.watermark,
        (row) => {
          if (["pending", "open", "in_flight"].includes(stringValue(row.status).toLowerCase())) {
            pending.push({
              pending_id: stringValue(row.pending_id ?? row.envelope_id),
              template_name: stringValue(row.interface_id ?? row.template_name ?? row.source_endpoint),
              artifact_id: stringValue(row.artifact_id ?? row.artifact?.artifact_id ?? row.payload?.artifact_id),
              trace_id: stringValue(row.trace_id),
              created_at: timestampOf(row),
              raw: row,
            });
          }
        },
      );
      if (tail === null) return null;
      return pending;
    } catch (error) {
      preserveProjectionEvidenceError(error);
      return null;
    } finally {
      index.database.close();
    }
  }

  return {
    readIndexedArtifactLabelRows,
    readIndexedArtifactRows,
    readIndexedEeInstanceRows,
    readIndexedEnvelopes,
    readIndexedEnvelopesForRuns,
    readIndexedLedgerArtifactRows,
    readIndexedMarkRows,
    readIndexedOutcomeIndex,
    readIndexedPendingArtifacts,
    readIndexedProjectionSnapshot,
    readIndexedRecentMovementRows,
    readIndexedRunCheckpointRows,
    readIndexedRunRows,
    readIndexedWorkerEnvironmentRows,
  };
}
