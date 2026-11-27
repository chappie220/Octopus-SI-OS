module.exports = { operatorChatIndexProjection };

const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { setImmediate: yieldToClient } = require("node:timers/promises");
const { isHomeVoiceInput } = require("./operatorChatVoiceInput.cjs");
const { indexedMovementRunId, indexedUnsignedInteger, ledgerRowsForRun, movementBoundaryInterface, movementKindText, movementRunId, normalizeIndexedProjectionMovement, openValidatedLedgerIndex } = require("./movementRows.cjs");
const { operatorChatEventIdentity } = require("./operatorChatEvents.cjs");
const { isOperatorChatProviderFailureRow, preserveProjectionEvidenceError } = require("./registryRows.cjs");
const { arrayValue, ledgerArtifactLabel, numberValue, objectOrEmpty, stringValue } = require("./values.cjs");

const MAX_CACHED_CHAT_RUNS = 128;
const MAX_CACHED_CHAT_ROWS_PER_RUN = 4_096;

function operatorChatIndexProjection(store) {
  let chatLedgerState = null;
  let chatLedgerTail = Promise.resolve();

  function closeOperatorChatIndexProjection() {
    chatLedgerState = null;
  }

  function operatorChatIncrementalEventKey(payload, eventKind) {
    if (![
      "commentary_delta",
      "reasoning_delta",
      "plan_delta",
      "tool_output_delta",
      "terminal_interaction",
      "file_change_delta",
      "mcp_progress",
    ].includes(eventKind)) return "";
    const identity = operatorChatEventIdentity(payload, eventKind);
    if (!identity.turn_id || !identity.item_id) return "";
    const summaryIndex = eventKind === "reasoning_delta"
      ? indexedUnsignedInteger(payload?.summary_index ?? payload?.summaryIndex)
      : null;
    const contentIndex = eventKind === "reasoning_delta"
      ? indexedUnsignedInteger(payload?.content_index ?? payload?.contentIndex)
      : null;
    const discriminator = summaryIndex !== null
      ? `:summary:${summaryIndex}`
      : contentIndex !== null
        ? `:content:${contentIndex}`
        : "";
    return `${identity.turn_id}:${identity.item_id}:${eventKind}${discriminator}`;
  }

  async function operatorChatRunIndex(projection) {
    const cached = projection.operatorChatRunIndexCache;
    if (cached && cached.generation === store.projectionGeneration) return cached.promise;
    const promise = buildOperatorChatRunIndex(projection);
    projection.operatorChatRunIndexCache = {
      generation: store.projectionGeneration,
      promise,
    };
    promise.catch(() => {
      if (projection.operatorChatRunIndexCache?.promise === promise) {
        projection.operatorChatRunIndexCache = null;
      }
    });
    return promise;
  }

  async function buildOperatorChatRunIndex(projection) {
    const protocol = objectOrEmpty(projection.operatorChatProtocol);
    const inboundLabels = new Set([
      protocol.inputLabel,
      protocol.approvalResponseLabel,
      protocol.elicitationResponseLabel,
      protocol.userInputResponseLabel,
    ].filter(Boolean));
    const scope = store.operatorOsScope(projection);
    const recordsByRun = new Map(arrayValue(projection.runRecords).map((record) => [
      stringValue(record.run_id),
      record,
    ]).filter(([runId]) => runId));
    const byRun = new Map(arrayValue(scope.client_runs).map((row) => {
      const runId = stringValue(row.run_id);
      return [runId, {
        runId,
        record: recordsByRun.get(runId) ?? null,
        writable: true,
        chatInterfaceId: stringValue(row.interface_id),
        surfaceRole: stringValue(row.surface_role),
        osRootEeId: stringValue(scope.root_ee_id),
        providerChoiceInterfaceId: stringValue(row.provider_choice_interface),
        workerChoiceInterfaceId: stringValue(row.worker_choice_interface),
        doorHostSlots: objectOrEmpty(row.authoring_profile?.door_host_slots),
        externalInputs: arrayValue(row.authoring_profile?.external_inputs),
        inbound: [],
        outbound: [],
        activity: [],
      }];
    }).filter(([runId, entry]) => runId && entry.chatInterfaceId));
    for (const row of arrayValue(scope.read_only_runs)) {
      const runId = stringValue(row.run_id);
      if (!runId || byRun.has(runId)) continue;
      byRun.set(runId, {
        runId,
        record: recordsByRun.get(runId) ?? null,
        writable: false,
        chatInterfaceId: stringValue(row.interface_id),
        surfaceRole: stringValue(row.surface_role) || "task",
        osRootEeId: stringValue(scope.root_ee_id),
        providerChoiceInterfaceId: stringValue(row.provider_choice_interface),
        workerChoiceInterfaceId: stringValue(row.worker_choice_interface),
        doorHostSlots: objectOrEmpty(row.authoring_profile?.door_host_slots),
        externalInputs: arrayValue(row.authoring_profile?.external_inputs),
        inbound: [],
        outbound: [],
        activity: [],
      });
    }
    const visibleLabels = new Set([
      protocol.terminalOutputLabel,
      protocol.errorOutputLabel,
      "turn.stream",
      ...arrayValue(protocol.streamOutputLabels),
    ]);
    const indexedRows = await operatorChatLedgerRows(projection, new Set(byRun.keys()));
    for (const [runId, entry] of byRun) {
      for (const row of indexedRows.get(runId) ?? []) {
        if (row.kind === "InterfaceArrival") {
          entry.activity.push(row);
          if (!entry.writable || isHomeVoiceInput(entry, row) || (
            inboundLabels.has(ledgerArtifactLabel(row))
            && movementBoundaryInterface(row, "from") === entry.chatInterfaceId
          )) {
            entry.inbound.push(row);
          }
        } else if (row.kind === "InterfaceOutbound") {
          entry.activity.push(row);
          const label = ledgerArtifactLabel(row);
          if (!entry.writable || (
            movementBoundaryInterface(row, "to") === entry.chatInterfaceId
            && (visibleLabels.has(label) || isOperatorChatProviderFailureRow(entry, row))
          )) {
            entry.outbound.push(row);
          }
        }
      }
    }
    return Array.from(byRun.values());
  }

  async function operatorChatLedgerRows(projection, runIds) {
    const indexed = await readIndexedOperatorChatLedgerRows(projection, runIds);
    if (indexed) {
      projection.operatorChatStatusCursor = Math.max(
        projection.operatorChatStatusCursor,
        indexed.nextMovementSeq,
      );
      return indexed.rowsByRun;
    }
    await store.refreshLedgerProjection(projection);
    projection.operatorChatStatusCursor = projection.ledgerRows.reduce(
      (latest, row) => Math.max(latest, numberValue(row.seq, -1)),
      projection.operatorChatStatusCursor,
    );
    return new Map([...runIds].map((runId) => [
      runId,
      ledgerRowsForRun(projection, runId),
    ]));
  }

  function appendBoundedChatRow(map, runId, row, maxRuns) {
    if (!runId) return;
    let list = map.get(runId);
    if (!list) {
      list = [];
      map.set(runId, list);
      if (maxRuns > 0 && map.size > maxRuns) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined && oldest !== runId) map.delete(oldest);
      }
    } else {
      map.delete(runId);
      map.set(runId, list);
    }
    list.push(row);
    if (list.length > MAX_CACHED_CHAT_ROWS_PER_RUN) {
      list.splice(0, list.length - MAX_CACHED_CHAT_ROWS_PER_RUN);
    }
  }

  function recordTailChatRow(state, row) {
    const runId = movementRunId(row);
    if (!runId) return;
    if (state.hydratedRuns.has(runId)) {
      appendBoundedChatRow(state.rowsByRun, runId, row, 0);
    } else {
      appendBoundedChatRow(state.unhydratedTailByRun, runId, row, MAX_CACHED_CHAT_RUNS);
    }
  }

  function evictOldestHydratedRuns(state, protectedRunIds) {
    while (state.rowsByRun.size > MAX_CACHED_CHAT_RUNS) {
      let evicted = false;
      for (const candidate of state.rowsByRun.keys()) {
        if (protectedRunIds && protectedRunIds.has(candidate)) continue;
        state.rowsByRun.delete(candidate);
        state.hydratedRuns.delete(candidate);
        evicted = true;
        break;
      }
      if (!evicted) break;
    }
  }

  async function hydrateChatRunsFromIndex(index, state, missingRunIds, protectedRunIds) {
    if (missingRunIds.length === 0) return;
    const statement = index.database.prepare(
      `SELECT
        seq, lamport, recorded_at_unix_ms, trace, kind,
        from_kind, from_id, to_kind, to_id,
        artifact_id, artifact_content,
        runtime_run, runtime_checkpoint, runtime_interface
      FROM movements
      WHERE runtime_run = ?
        AND seq < ?
        AND kind IN ('InterfaceArrival', 'InterfaceOutbound')
      ORDER BY seq DESC
      LIMIT ?`,
    );
    const queryWatermark = Math.min(index.watermark, state.nextSeq);
    for (const runId of missingRunIds) {
      const descRows = statement.all(runId, queryWatermark, MAX_CACHED_CHAT_ROWS_PER_RUN);
      const rows = [];
      for (let i = descRows.length - 1; i >= 0; i--) {
        const row = descRows[i];
        if (indexedMovementRunId(row) !== runId) continue;
        rows.push(normalizeIndexedProjectionMovement(row, index.ledgerPath));
      }
      const tailRows = state.unhydratedTailByRun.get(runId);
      if (tailRows && tailRows.length > 0) {
        for (const tailRow of tailRows) {
          if (numberValue(tailRow.seq, -1) >= queryWatermark) rows.push(tailRow);
        }
        state.unhydratedTailByRun.delete(runId);
      }
      if (rows.length > MAX_CACHED_CHAT_ROWS_PER_RUN) {
        rows.splice(0, rows.length - MAX_CACHED_CHAT_ROWS_PER_RUN);
      }
      state.rowsByRun.delete(runId);
      state.rowsByRun.set(runId, rows);
      state.hydratedRuns.add(runId);
      await yieldToClient();
    }
    evictOldestHydratedRuns(state, protectedRunIds);
  }

  async function streamChatLedgerTail(ledgerPath, startOffset, expectedSeq, onRow) {
    const stat = await fs.stat(ledgerPath);
    if (stat.size < startOffset) return null;
    if (stat.size === startOffset) {
      return { consumedOffset: startOffset, nextSeq: expectedSeq, nextMovementSeq: expectedSeq - 1, stat };
    }
    let consumedOffset = startOffset;
    let pending = Buffer.alloc(0);
    for await (const chunk of fsSync.createReadStream(ledgerPath, { start: startOffset, end: stat.size - 1 })) {
      const bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let recordStart = 0;
      for (;;) {
        const newline = bytes.indexOf(0x0a, recordStart);
        if (newline < 0) break;
        const end = newline > recordStart && bytes[newline - 1] === 0x0d ? newline - 1 : newline;
        const raw = bytes.subarray(recordStart, end);
        consumedOffset += (newline - recordStart) + 1;
        recordStart = newline + 1;
        if (!raw.length) continue;
        const movement = store.parseCanonicalMovement(raw, ledgerPath, expectedSeq + 1);
        const seq = indexedUnsignedInteger(movement?.seq);
        if (seq === null || seq !== expectedSeq) return null;
        expectedSeq += 1;
        const kind = movementKindText(movement?.kind);
        if (kind !== "InterfaceArrival" && kind !== "InterfaceOutbound") continue;
        const projected = {
          ...movement,
          kind,
          envelope_id: stringValue(movement.envelope_id ?? movement.id) || `movements:${seq + 1}`,
          source_file: ledgerPath,
          source_line: seq + 1,
        };
        onRow(projected);
      }
      pending = bytes.subarray(recordStart);
    }
    return {
      consumedOffset,
      nextSeq: expectedSeq,
      nextMovementSeq: expectedSeq - 1,
      stat,
    };
  }

  function ensureChatLedgerState(projection, requestedRunIds) {
    const read = chatLedgerTail.then(() => ensureChatLedgerStateUnlocked(projection, requestedRunIds));
    chatLedgerTail = read.then(() => undefined, () => undefined);
    return read;
  }

  async function ensureChatLedgerStateUnlocked(projection, requestedRunIds) {
    const durableRoot = projection.durableRoot;
    const ledgerPath = path.join(durableRoot, "movements.jsonl");
    let stat;
    try {
      stat = await fs.stat(ledgerPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        chatLedgerState = null;
        return null;
      }
      throw error;
    }

    const current = chatLedgerState;
    if (
      current
      && current.durableRoot === durableRoot
      && current.dev === stat.dev
      && current.ino === stat.ino
      && stat.size >= current.durableOffset
    ) {
      let advanced = true;
      if (stat.size > current.durableOffset) {
        const tail = await streamChatLedgerTail(
          ledgerPath,
          current.durableOffset,
          current.nextSeq,
          (row) => recordTailChatRow(current, row),
        );
        if (tail !== null) {
          current.durableOffset = tail.consumedOffset;
          current.nextSeq = tail.nextSeq;
          current.nextMovementSeq = tail.nextMovementSeq;
        } else {
          advanced = false;
        }
      }
      if (advanced) {
        const missing = [];
        for (const runId of requestedRunIds) {
          if (current.hydratedRuns.has(runId)) {
            const cached = current.rowsByRun.get(runId);
            if (cached) {
              current.rowsByRun.delete(runId);
              current.rowsByRun.set(runId, cached);
            }
          } else {
            missing.push(runId);
          }
        }
        if (missing.length === 0) return current;
        const index = await openValidatedLedgerIndex(projection);
        if (index) {
          try {
            await hydrateChatRunsFromIndex(index, current, missing, requestedRunIds);
            return current;
          } catch (error) {
            preserveProjectionEvidenceError(error);
            return null;
          } finally {
            index.database.close();
          }
        }
        return null;
      }
    }

    const index = await openValidatedLedgerIndex(projection);
    if (!index) return null;
    try {
      const nextState = {
        durableRoot,
        ledgerPath: index.ledgerPath,
        dev: stat.dev,
        ino: stat.ino,
        indexWatermark: index.watermark,
        durableOffset: index.durableEndOffset,
        nextSeq: index.watermark,
        nextMovementSeq: index.watermark - 1,
        rowsByRun: new Map(),
        hydratedRuns: new Set(),
        unhydratedTailByRun: new Map(),
      };
      await hydrateChatRunsFromIndex(index, nextState, [...requestedRunIds], requestedRunIds);
      const tail = await streamChatLedgerTail(
        index.ledgerPath,
        index.durableEndOffset,
        index.watermark,
        (row) => recordTailChatRow(nextState, row),
      );
      if (tail === null) return null;
      nextState.dev = tail.stat.dev;
      nextState.ino = tail.stat.ino;
      nextState.durableOffset = tail.consumedOffset;
      nextState.nextSeq = tail.nextSeq;
      nextState.nextMovementSeq = tail.nextMovementSeq;
      chatLedgerState = nextState;
      return nextState;
    } catch (error) {
      preserveProjectionEvidenceError(error);
      return null;
    } finally {
      index.database.close();
    }
  }

  async function readIndexedOperatorChatLedgerRows(projection, runIds) {
    if (runIds.size === 0) return { rowsByRun: new Map(), nextMovementSeq: -1 };
    const state = await ensureChatLedgerState(projection, runIds);
    if (!state) return null;
    const rowsByRun = new Map([...runIds].map((runId) => [
      runId,
      [...(state.rowsByRun.get(runId) ?? [])],
    ]));
    return {
      rowsByRun,
      nextMovementSeq: state.nextMovementSeq,
    };
  }

  async function readIndexedLedgerTail(ledgerPath, startOffset, expectedSeq, runIds) {
    const rowsByRun = new Map([...runIds].map((runId) => [runId, []]));
    const tail = await streamChatLedgerTail(
      ledgerPath,
      startOffset,
      expectedSeq,
      (projected) => {
        const runId = movementRunId(projected);
        if (runIds.has(runId)) rowsByRun.get(runId).push(projected);
      },
    );
    if (tail === null) return null;
    return {
      rowsByRun,
      nextMovementSeq: tail.nextMovementSeq,
    };
  }

  async function operatorChatLedgerDelta(projection, runIds, afterSeq) {
    const indexed = await readIndexedOperatorChatLedgerDelta(projection, runIds, afterSeq);
    if (indexed) return indexed;
    await store.refreshLedgerProjection(projection);
    const rowsByRun = new Map([...runIds].map((runId) => [runId, []]));
    let nextMovementSeq = afterSeq;
    for (const row of projection.ledgerRows) {
      const seq = numberValue(row.seq, -1);
      nextMovementSeq = Math.max(nextMovementSeq, seq);
      if (seq <= afterSeq || (row.kind !== "InterfaceArrival" && row.kind !== "InterfaceOutbound")) continue;
      const runId = movementRunId(row);
      if (runIds.has(runId)) rowsByRun.get(runId).push(row);
    }
    return { rowsByRun, nextMovementSeq };
  }

  async function readIndexedOperatorChatLedgerDelta(projection, runIds, afterSeq) {
    const state = await ensureChatLedgerState(projection, runIds);
    if (!state) return null;
    const rowsByRun = new Map();
    for (const runId of runIds) {
      const rows = state.rowsByRun.get(runId);
      if (!rows || rows.length === 0 || numberValue(rows[rows.length - 1].seq, -1) <= afterSeq) {
        rowsByRun.set(runId, []);
      } else {
        rowsByRun.set(runId, rows.filter((row) => numberValue(row.seq, -1) > afterSeq));
      }
    }
    return {
      rowsByRun,
      nextMovementSeq: Math.max(afterSeq, state.nextMovementSeq),
    };
  }

  return { buildOperatorChatRunIndex, closeOperatorChatIndexProjection, operatorChatIncrementalEventKey, operatorChatLedgerDelta, operatorChatLedgerRows, operatorChatRunIndex, readIndexedLedgerTail, readIndexedOperatorChatLedgerDelta, readIndexedOperatorChatLedgerRows };
}
