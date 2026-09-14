---
name: dsh-pilot
description: Drive DeepSeek Harness agents over the Agent Client Protocol — start the automation server, run a session end to end, and know whether a session is alive or resumable. Use when work should be done by DSH rather than in-session.
---

# Drive DSH

DeepSeek Harness is **not** shaped like PI, and the difference decides how you drive it.

| | PI | DSH |
|---|---|---|
| shape | one process, reads a brief, exits | a **server** holding persistent sessions |
| wire | argv in, JSONL on stdout | JSON-RPC both ways, ndJSON over stdio |
| state | none | sessions survive a process restart |
| "is it alive?" | pid + kernel start time | **two questions**: is the server up, and is the session resumable |

A controller written for PI will not work here. `pilot.py` answers "is this run alive" from `/proc`; for DSH that answer is incomplete, because a dead server can still leave a session that `session/resume` will pick up.

## Drive it

`dsh-pilot.mjs` runs one task end to end and exits, so a caller can treat DSH like
any other job:

```sh
ATLASCLOUD_API_KEY=… node ~/.claude/skills/dsh-pilot/dsh-pilot.mjs \
  --cwd <worktree> --brief <file> [--model <id>] [--out <transcript>] [--timeout <seconds>]
```

It writes the overlay itself from `--model` / `--provider`, answers permission
requests as they arrive, and keeps stdout to a single summary line while the
transcript goes to `--out`.

The exit code separates the two things every wrong call in this project has
confused: **0** the turn settled on `end_turn`, **1** it ended some other way,
**124** no settlement inside the timeout. "The agent is done" and "I stopped
waiting" are different answers and the caller has to be able to tell them apart.

## Start it by hand

```sh
ATLASCLOUD_API_KEY=… pnpm dsh --profile acp --patch ~/.dsh/atlascloud.patch.yml
```

Run from a checkout of `deepseek-harness`. `--profile acp` serves the Agent Client Protocol over stdio and exits when the client disconnects.

**Stdout carries protocol traffic only.** Anything written there by a plugin corrupts the stream. Keep logging on stderr.

## The four things that cost time here

**Node is probably too old.** The harness requires `^22.19.0 || >=24`. A system Node of 20.x installs nothing and fails late with a message about the engine field. `~/.local/node24` carries 24.20.0 on this host, and `corepack prepare pnpm@11.7.0 --activate` supplies the package manager the lockfile pins.

**The shipped ACP bundle hard-codes the model route.** `packages/bundle/acp-app/cordis.patch.yml` sets `provider: deepseek-official` and `model: deepseek-v4-flash`. That route takes its key from the credentials service, not from `settings.yaml`, so a correctly configured custom provider still fails the first prompt with *"no API key for provider route deepseek-official"*.

Do not edit the bundle — an upstream update will take the edit back. Write an overlay and pass `--patch`:

```yaml
- id: acp
  config:
    provider: atlascloud
    model: deepseek-ai/deepseek-v4-flash-0731-0731
```

**`session/new` can return an empty option list.** The README describes `session/set_config_option` for choosing `model` and `reasoning_effort`, and on this composition the returned `configOptions` is empty — so the model cannot be switched per session that way. It must be pinned in plugin config, which means **one model per server process**. To compare models, start one server per model rather than reconfiguring a session.

**A prompt stalls unless permission requests are answered.** The server calls `session/request_permission` back at the client mid-turn. A controller that only sends and never answers will sit until its timeout with no error. Answer it, or the turn never settles.

## The protocol, minimally

ndJSON: one JSON object per line, both directions.

| call | what it gives you |
|---|---|
| `initialize` | protocol version; send first |
| `session/new` | a session id, an absolute `cwd`, and the config-option state |
| `session/prompt` | one prompt at a time per session; settles on agent idle |
| `session/close` | closes one session without touching its siblings |
| `session/list` | resumable sessions, newest first, optional `cwd` filter |
| `session/resume` | a persisted session, log restored without replaying updates |
| `session/cancel` | cancels the in-flight prompt |

Server → client: `session/update` carries assistant text, thoughts and tool lifecycle; `session/request_permission` must be answered.

Unsupported, and they reject rather than degrade: `session/load`, delete, fork, additional directories, SSE or ACP-transport MCP, modes, commands, plans, terminals, elicitation.

## Configuration

`$DSH_HOME` defaults to `~/.dsh`. Providers go in `settings.yaml`; adapters re-read on the next request, so nothing needs a restart:

```yaml
llm-pi-ai:
  providers:
    atlascloud:
      apiKeyEnv: ATLASCLOUD_API_KEY
      api: openai-completions
      baseURL: https://api.atlascloud.ai/v1
      models:
        - id: deepseek-ai/deepseek-v4-flash-0731
```

`apiKeyEnv` rather than an inline key: this file is hand-edited and gets copied around. Mode 600 on both it and any patch overlay.

Model ids are the gateway's exact strings from `GET /v1/models`. The `deepseek-ai/` prefix is part of the id.

A model entered by hand is treated as text-only until `input: [text, image]` says otherwise; attaching an image to one is refused before it is sent.

## Before believing a negative

Same rule as `pi-pilot`, for the same reason: every wrong call made against these harnesses came from an instrument that failed towards *nothing is running*.

- A prompt that returns nothing may be an unanswered permission request, not a dead agent.
- An empty `configOptions` is a real answer, not a transport failure — check it before concluding the server is misconfigured.
- Session absence from `session/list` is not proof the work did not happen; a session closed cleanly is gone from the list and its effects are on disk.

Prove the instrument can report a positive before trusting it to report a negative.

## What is verified here, and what is not

Measured on this host: `initialize` → protocol version 1; `session/new` → a session id; a prompt answered in 2 seconds through `atlascloud/deepseek-ai/deepseek-v4-flash`; `session/close` clean. The overlay is what made the prompt work; without it the same setup failed on the hard-coded route.

Not established: `session/list` / `session/resume` across a server restart, cancellation, MCP mounting, image input, or any run long enough to exercise permission prompts. Those are claims from the README, not from a run, and this skill says so rather than repeating them as fact.

## Measured against pi as a coder (round 4, one sample)

Same brief, same starting commit, two harnesses.

| | pi + MiniMax-M3 | dsh + deepseek-v4-flash |
| --- | --- | --- |
| wall clock | ~780s | **306s** |
| committed its work | yes, 3 commits | no — see the correction below |
| ran its own change | yes | no (worktree had no deps; it did not notice) |
| the finding that needed measuring, not reading | found it | missed it |

### The "dsh does not commit" finding was wrong

It was recorded here as a model or harness weakness. It is neither. `git commit` needs an
escalation to `danger-full-access`, and under the default `workspace-write` preset that
escalation is **cancelled without ever reaching the client** — no `session/request_permission`
arrives, so there is nothing to answer. The turn then ends normally and the tree is quietly
dirty.

Measured, same brief and same model, only the preset differing:

```
--permission-mode workspace-write      → stopReason=absent settled=false delivered=false, no commit
--permission-mode danger-full-access   → stopReason=end_turn settled=true  delivered=true, commit landed
```

The cause was a configuration the orchestrator never set. Two lessons, and the second is the
one that keeps recurring here:

- Pass `--permission-mode danger-full-access` whenever the run is expected to produce commits.
  It is not the default because it turns approval prompts off on a host with no isolation.
- **When an agent fails to do something, find the mechanism before you write down a verdict
  about the agent.** "It didn't commit" was true and the explanation attached to it was
  invented. It cost a wrong entry in this file and a wrong entry in the project's evidence.

### Driver defects found and fixed in the same pass

1. **`session/prompt` does not reliably return `stopReason`.** It returned `end_turn` on a
   read-only turn and nothing at all on a turn that used tools. The driver now also reads the
   `session/update` stream and reports `absent` rather than `unknown` when neither carries one.
2. **The driver reported success on a dirty tree.** It now compares HEAD before and after and
   checks `git status --porcelain`, exits 1 when nothing landed, and says which of the two.
   `--no-require-commit` opts out.
3. **It waited out a full timeout for a child that had already died.** DSH needs Node >= 22
   (`createZstdDecompress`, `Promise.withResolvers`); spawned as bare `node` it inherited v20
   from PATH, died during plugin load, and the driver sat for 600s before reporting "no
   settlement" — blaming the wait for a startup failure. It now resolves a Node >= 22 binary,
   treats an explicit `--node` as a pin rather than a preference, and fails within seconds when
   the child exits, printing the harness's own stderr.
4. **`--precheck <cmd>`** runs a command in the target directory first and exits 3 if it fails,
   so a run cannot be spent in a worktree where the test command cannot start.

One sample. This project has already seen a model ranking flip between two consecutive rounds.
