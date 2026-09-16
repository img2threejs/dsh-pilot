#!/usr/bin/env python3
"""Drive one DeepSeek Harness task end to end and exit.

    pilot.py --cwd <worktree> --brief <file> [--out <transcript>] [--model <id>]
             [--provider <id>] [--timeout <seconds>] [--permission-mode <mode>]
             [--precheck '<shell cmd>'] [--node <path>] [--no-require-commit]
             [--repo <deepseek-harness checkout>]

The exit code is the point. Every wrong call made against these harnesses came from an
instrument that could not tell "the agent finished" from "I stopped waiting":

    0    the turn settled on end_turn AND the work landed as a commit
    1    it ended some other way, or nothing landed
    2    the invocation itself was wrong
    3    refused before starting — no Node >= 22, precheck failed, or the harness died
    124  no settlement inside the timeout
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

ARGV = sys.argv[1:]


def arg(name: str, fallback: str | None = None) -> str | None:
    flag = f"--{name}"
    if flag in ARGV:
        i = ARGV.index(flag)
        if i + 1 < len(ARGV):
            return ARGV[i + 1]
    return fallback


def die(code: int, *lines: str) -> None:
    for line in lines:
        print(f"pilot: {line}", file=sys.stderr)
    sys.exit(code)


CWD = Path(arg("cwd", os.getcwd())).resolve()
BRIEF_PATH = arg("brief")
MODEL = arg("model", "deepseek-ai/deepseek-v4-flash-0731")
PROVIDER = arg("provider", "atlascloud")
OUT_PATH = arg("out")
TIMEOUT = float(arg("timeout", "3600"))
REPO = Path(arg("repo", "/home/team/workspaces/deepseek-harness"))
REQUIRE_COMMIT = "--no-require-commit" not in ARGV
PRECHECK = arg("precheck")

# `git commit` needs an escalation the default `workspace-write` preset cancels without ever
# asking the client, so a coder run under the default ends with a dirty tree and no prompt to
# answer. Named rather than defaulted: it turns approval off on a host with no isolation.
PERMISSION_MODE = arg("permission-mode", "workspace-write")

if not BRIEF_PATH:
    die(2, "--brief is required")


def node_major(binary: str) -> int:
    """Major version of a node binary, or 0 when it cannot be run."""
    try:
        out = subprocess.run([binary, "-v"], capture_output=True, text=True, timeout=20)
        return int(out.stdout.strip().lstrip("v").split(".")[0])
    except Exception:
        return 0


# DSH needs Node >= 22 (`createZstdDecompress`, `Promise.withResolvers`). Spawned as bare
# `node` it inherits whatever is on PATH; on v20 it dies during plugin load, and a driver that
# only watches for a reply sits out its whole timeout blaming the wait for a startup failure.
PINNED_NODE = arg("node")
if PINNED_NODE:
    # An explicit --node is a pin, not a preference. Quietly running a different binary than
    # the one asked for is the silent substitution this project keeps being bitten by.
    if node_major(PINNED_NODE) < 22:
        die(3, f"--node {PINNED_NODE} is v{node_major(PINNED_NODE) or '?'}; DSH needs >= 22.")
    NODE = PINNED_NODE
else:
    candidates = ["node", "/home/team/.local/node24/bin/node"]
    NODE = next((c for c in candidates if c and node_major(c) >= 22), None)
    if NODE is None:
        die(3, "no Node >= 22 found. DSH will not load on older majors; pass --node <path>.",
            "  tried: " + ", ".join(f"{c} (v{node_major(c) or '?'})" for c in candidates if c))


def git(*args: str) -> str | None:
    try:
        return subprocess.run(["git", *args], cwd=CWD, capture_output=True,
                              text=True, check=True).stdout.strip()
    except Exception:
        return None


# A coder that cannot run the test cannot tell you its fix is untested. Establish that the
# environment works before spending a run in it.
if PRECHECK:
    done = subprocess.run(["bash", "-lc", PRECHECK], cwd=CWD, capture_output=True, text=True)
    if done.returncode != 0:
        die(3, f"precheck failed in {CWD}: {PRECHECK}",
            (done.stdout or "")[-800:] + (done.stderr or "")[-800:])

HEAD_BEFORE = git("rev-parse", "HEAD") if REQUIRE_COMMIT else None
BRIEF = Path(BRIEF_PATH).read_text()

# The shipped acp bundle pins provider/model in plugin config; an overlay is the supported way
# to change them without editing a file an update would revert.
PATCH = Path(f"/tmp/pilot-dsh-{os.getpid()}.patch.yml")
PATCH.write_text(f"- id: acp\n  config:\n    provider: {PROVIDER}\n    model: {MODEL}\n")

started = time.monotonic()
out_file = Path(OUT_PATH) if OUT_PATH else None
if out_file:
    out_file.write_text("")


def log(line: str) -> None:
    if out_file:
        with out_file.open("a") as fh:
            fh.write(line + "\n")


child = subprocess.Popen(
    [NODE, "--import", "tsx/esm", "apps/cli/src/bin.ts", "--profile", "acp", "--patch", str(PATCH)],
    cwd=REPO, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, bufsize=1, env={**os.environ, "DSH_PERMISSION_MODE": PERMISSION_MODE},
)

state = threading.Lock()
pending: dict[int, dict] = {}
answered = threading.Event()
next_id = [1]
permissions_answered = [0]
last_activity = [time.monotonic()]
last_stop_reason: list[str | None] = [None]
finished = threading.Event()
stderr_tail: list[str] = []


def send(payload: dict) -> None:
    with state:
        child.stdin.write(json.dumps(payload) + "\n")
        child.stdin.flush()


def read_stderr() -> None:
    for line in child.stderr:
        stderr_tail.append(line.rstrip())
        del stderr_tail[:-40]
        log("[stderr] " + line.rstrip())


def read_stdout() -> None:
    for line in child.stdout:
        if not line.strip():
            continue
        try:
            message = json.loads(line)
        except Exception:
            continue
        last_activity[0] = time.monotonic()

        mid = message.get("id")
        if mid is not None and mid in pending:
            pending[mid] = message
            answered.set()
            continue

        method = message.get("method")
        if method == "session/update":
            # `session/prompt` does not reliably carry the stop reason — a coder run returned
            # no such field at all. The update stream does, so keep the last one seen.
            params = message.get("params") or {}
            update = params.get("update") or params
            seen = update.get("stopReason") or update.get("stop_reason")
            if isinstance(seen, str):
                last_stop_reason[0] = seen
            log("[update] " + json.dumps(params)[:600])
        elif method == "session/request_permission":
            # Unanswered permission requests stall the turn with no error — the failure mode
            # that looks exactly like a hung agent.
            options = (message.get("params") or {}).get("options") or []
            allow = next(
                (o for o in options
                 if re.search(r"allow", f"{o.get('kind','')}{o.get('name','')}{o.get('optionId','')}", re.I)),
                options[0] if options else None,
            )
            send({"jsonrpc": "2.0", "id": message.get("id"),
                  "result": {"outcome": {"outcome": "selected",
                                         "optionId": (allow or {}).get("optionId")}}})
            permissions_answered[0] += 1
            log(f"[permission] answered {(allow or {}).get('optionId', '(none)')}")


def watch_child() -> None:
    # A child that has already exited will never settle. Saying so immediately is the whole
    # difference between a diagnosable failure and a timeout that blames the wait.
    code = child.wait()
    if finished.is_set():
        return
    print(f"pilot: the harness exited before the turn settled (code={code}).", file=sys.stderr)
    if stderr_tail:
        print("\n".join(stderr_tail[:12]), file=sys.stderr)
    os._exit(3)


for target in (read_stdout, read_stderr, watch_child):
    threading.Thread(target=target, daemon=True).start()


class RpcError(Exception):
    pass


def call(method: str, params: dict) -> dict:
    """One JSON-RPC round trip, bounded by the run's own deadline."""
    mid = next_id[0]
    next_id[0] += 1
    pending[mid] = {}
    send({"jsonrpc": "2.0", "id": mid, "method": method, "params": params})
    while True:
        if pending[mid]:
            message = pending.pop(mid)
            if message.get("error"):
                raise RpcError(f"{method}: {json.dumps(message['error'])[:300]}")
            return message.get("result") or {}
        if time.monotonic() - started > TIMEOUT:
            idle = round(time.monotonic() - last_activity[0])
            finished.set()
            print(f"pilot: no settlement within {TIMEOUT:.0f}s (last activity {idle}s ago)",
                  file=sys.stderr)
            if idle >= TIMEOUT:
                print("pilot: nothing was ever received from the harness — suspect startup, "
                      "not a slow turn.", file=sys.stderr)
            child.terminate()
            sys.exit(124)
        answered.wait(0.2)
        answered.clear()


try:
    call("initialize", {"protocolVersion": 1, "clientCapabilities": {}})
    session = call("session/new", {"cwd": str(CWD), "mcpServers": []})
    sid = session.get("sessionId") or session.get("session_id")
    log(f"[session] {sid} cwd={CWD} model={PROVIDER}/{MODEL} permission={PERMISSION_MODE}")

    reply = call("session/prompt", {"sessionId": sid,
                                    "prompt": [{"type": "text", "text": BRIEF}]})
    seconds = round(time.monotonic() - started)
    stop_reason = reply.get("stopReason") or reply.get("stop_reason") or last_stop_reason[0]
    settled = stop_reason == "end_turn"

    # "It finished" and "it produced something" are different questions, and a driver that
    # answers only the first is the blind instrument this project keeps rebuilding.
    delivered, why = True, ""
    if REQUIRE_COMMIT:
        head_after = git("rev-parse", "HEAD")
        dirty = git("status", "--porcelain")
        if head_after and HEAD_BEFORE and head_after == HEAD_BEFORE:
            delivered = False
            why = ("no commit was made — under --permission-mode workspace-write the escalation "
                   "`git commit` needs is cancelled without reaching this client"
                   if PERMISSION_MODE == "workspace-write" else "no commit was made")
        elif dirty:
            delivered, why = False, f"worktree left dirty:\n{dirty}"

    print(f"pilot: stopReason={stop_reason or 'absent'} settled={settled} "
          f"delivered={delivered} seconds={seconds} "
          f"permissions={permissions_answered[0]} session={sid}")
    if not delivered:
        print(f"pilot: the turn ended but nothing landed — {why}", file=sys.stderr)
    log(f"[done] stopReason={stop_reason or 'absent'} settled={settled} "
        f"delivered={delivered} seconds={seconds}")

    finished.set()
    try:
        call("session/close", {"sessionId": sid})
    except Exception:
        pass
    child.terminate()
    # 0 only when the turn settled AND the work landed, so a caller never reads "the process
    # exited cleanly" as "the task is done".
    sys.exit(0 if (settled and delivered) else 1)
except RpcError as error:
    finished.set()
    child.terminate()
    die(1, str(error))
