import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import signal
import socket
import sqlite3
import subprocess
import tempfile
import time


ROW_COUNT = 896_035
STARTUP_TIMEOUT = 120
MAX_RUNTIME_RSS_MIB = 256


def write_ledger(path):
    path.parent.mkdir()
    interface = "system_interface_authoring_fixture"
    worker = "system_worker_fixture"
    row = {
        "recorded_at_unix_ms": 1,
        "trace": "trace:run_writer_fixture:cp_authoring_fixture",
        "kind": "DeliveryRefused",
        "from": {"Interface": interface},
        "to": {"Interface": worker},
        "artifact": {"id": "tool.call:" + "ab" * 32, "content": [171] * 32},
        "invocation_metadata": {
            "delivery_scope_seq": 0,
            "delivery_verdict": {"refused": {
                "reason": "checkpoint_spent",
                "detail": {"message": (
                    "interface artifact checkpoint already fired: run 'run_writer_fixture' "
                    "checkpoint 'cp_authoring_fixture' already closed its required verified "
                    "artifact set in the durable movement log; interface JSON must author "
                    "a new checkpoint generation before another artifact can enter"
                )},
            }},
            "runtime": {
                "run": "run_writer_fixture",
                "checkpoint": "cp_authoring_fixture",
                "epoch": 0,
                "ee": "ee_existence",
                "worker": worker,
                "interface": interface,
                "run_record_hash": "cd" * 32,
            },
        },
    }
    suffix = json.dumps(row, separators=(",", ":"))[1:].encode() + b"\n"
    scope = {
        **row,
        "seq": 0,
        "lamport": 1,
        "kind": "ArtifactMoved",
        "to": row["from"],
        "invocation_metadata": {
            "arrival_fanout": {
                "identity": "test-refusal-fanout",
                "targets": [row["invocation_metadata"]["runtime"]],
            },
        },
    }
    with path.open("wb", buffering=1 << 20) as ledger:
        ledger.write(json.dumps(scope, separators=(",", ":")).encode() + b"\n")
        for seq in range(1, ROW_COUNT):
            ledger.write(f'{{"seq":{seq},"lamport":{seq + 1},'.encode() + suffix)


def ledger_digest(path):
    with path.open("rb") as ledger:
        return hashlib.file_digest(ledger, "sha256").hexdigest()


def runtime_phase(endpoint, pid):
    try:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(0.5)
            connection.connect(str(endpoint))
            connection.sendall(b'{"request":"status"}\n')
            with connection.makefile("rb") as reader:
                status = json.loads(reader.readline())
    except (OSError, ValueError):
        return None
    if status.get("outcome") == "status" and status.get("pid") == pid:
        return status["phase"]
    return None


def exercise_runtime(runtime, home, name, target_phase):
    endpoint = home / "state/runtime-instance/control.sock"
    log_path = home / f"{name}.log"
    env = {key: value for key, value in os.environ.items() if not key.startswith("OCTOPUS_")}
    env.update(OCTOPUS_HOME=str(home), OCTOPUS_INSTALLATION_ROOT=str(runtime))
    started = time.monotonic()
    phase = None
    try:
        with log_path.open("wb") as log:
            process = subprocess.Popen(
                [str(runtime / "bin/octopus"), "up"], cwd=home,
                env=env, stdout=log, stderr=subprocess.STDOUT,
            )
            try:
                while process.poll() is None and time.monotonic() - started < STARTUP_TIMEOUT:
                    phase = runtime_phase(endpoint, process.pid) or phase
                    if phase == target_phase:
                        break
                    time.sleep(0.025)
                else:
                    raise RuntimeError(f"{name}: expected {target_phase}, last phase {phase}")
                elapsed = time.monotonic() - started
            finally:
                if process.poll() is None:
                    process.send_signal(signal.SIGTERM)
                try:
                    code = process.wait(timeout=STARTUP_TIMEOUT)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                    raise
        assert code == 0, f"{name}: exit {code}"
        output = log_path.read_text()
        assert f"SIGTERM from pid {os.getpid()} (uid {os.getuid()})" in output, output
        if target_phase == "ready":
            assert f"{ROW_COUNT} movements indexed" in output, output
            assert f"1 replay rows · {ROW_COUNT - 1} linked refusals streamed" in output, output
            assert "1 durable run(s)" in output, output
            assert "discovering descriptor-owned life processes" in output, output
        else:
            assert "cancelled before interface discovery" in output, output
            assert "discovering descriptor-owned life processes" not in output, output
            assert "checking durable outbound tail" not in output, output
        peak_mib = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1024
        assert peak_mib <= MAX_RUNTIME_RSS_MIB, (
            f"{name}: runtime peak RSS {peak_mib:.1f} MiB exceeded {MAX_RUNTIME_RSS_MIB} MiB"
        )
        print(f"{name}: reached {target_phase} in {elapsed:.2f}s, "
              f"runtime peak RSS across boots so far {peak_mib:.1f} MiB", flush=True)
    except Exception:
        print(log_path.read_text(), flush=True)
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-root", type=Path, required=True)
    runtime = parser.parse_args().runtime_root.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="octopus-boot-", dir="/tmp") as scratch:
        home = Path(scratch)
        ledger = home / "ledger/movements.jsonl"
        write_ledger(ledger)
        original = ledger_digest(ledger)
        exercise_runtime(runtime, home, "cold-index", "ready")
        with sqlite3.connect((ledger.parent / "ledger-index.sqlite").as_uri() + "?mode=ro", uri=True) as index:
            assert index.execute("""
                SELECT COUNT(*) FROM movements
                WHERE kind = 'DeliveryRefused' AND runtime_run = 'run_writer_fixture'
            """).fetchone()[0] == ROW_COUNT - 1
        exercise_runtime(runtime, home, "warm-index", "ready")
        exercise_runtime(runtime, home, "cancel-during-replay", "restoring_runtime")
        assert ledger_digest(ledger) == original
        print(f"Ledger preserved byte-for-byte across three boots ({ROW_COUNT:,} rows).")


if __name__ == "__main__":
    main()
