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
    model: deepseek-ai/deepseek-v4-flash
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
        - id: deepseek-ai/deepseek-v4-flash
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
