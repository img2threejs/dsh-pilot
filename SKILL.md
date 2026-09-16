---
name: dsh-pilot
description: Hand a task to DeepSeek Harness on this host and judge what comes back. Use whenever work should be done by DSH rather than in-session, and whenever you need to know whether a DSH run is still alive.
---

# Drive DSH

DSH does the work. You write the brief, verify the result, and decide. **Never trust the
transcript as evidence** — it reports what the agent believes it did, and that is the same failure
mode every author has.

DSH reads the workspace's `AGENTS.md`, so the project's own standard reaches the agent without
being restated. Measured, with a string that appears nowhere else: an `AGENTS.md` saying *"the
secret handshake is PINEAPPLE-7734"* and a prompt asking for it back, with no file reads allowed,
returns `PINEAPPLE-7734`. The loader is `packages/context/agent-instructions`, mounted by the base
bundle at `packages/bundle/base/cordis.patch.yml:274`.

## Never drive DSH by hand

`pilot.py` runs one task end to end and exits, so a caller can treat DSH like any other job.
Use it. Every wrong call recorded below came from an instrument improvised at the prompt, and the
improvised instrument always failed towards *nothing is running*.

```sh
ATLASCLOUD_API_KEY=… python3 ~/.claude/skills/dsh-pilot/pilot.py \
  --cwd <worktree> --brief <file> \
  [--model <id>] [--provider <id>] [--out <transcript>] [--timeout <seconds>] \
  [--permission-mode danger-full-access] [--precheck 'npm test'] \
  [--node /path/to/node22+] [--no-require-commit] [--repo <deepseek-harness checkout>]
```

It writes the config overlay itself from `--model`/`--provider`, answers permission requests as
they arrive, keeps stdout to one summary line, and sends the transcript to `--out`.

The exit code separates the things every wrong call in this project has confused:

| code | meaning |
| --- | --- |
| `0` | the turn settled **and** the work landed as a commit |
| `1` | it ended without settling, or nothing landed |
| `2` | the invocation itself was wrong |
| `3` | refused before starting — no Node ≥ 22, `--precheck` failed, or the harness died at startup |
| `124` | no settlement inside the timeout |

"The agent is done", "it produced nothing", and "I stopped waiting" are three different answers,
and a caller that cannot tell them apart will start a second run over work already in flight.

## The failure modes, measured

Each is a fact about DSH or about the instrument, not a style preference.

**Node is probably too old.** DSH needs `^22.19.0 || >=24` — it uses `createZstdDecompress` and
`Promise.withResolvers`. Spawned as bare `node` it inherits whatever is on PATH; on v20 it dies
during plugin load, and a driver that only watches for a reply sits out its entire timeout blaming
the wait for a startup failure. One run burned 600 seconds that way. `~/.local/node24` carries
24.20.0 here. The driver resolves a suitable binary, treats an explicit `--node` as a pin rather
than a preference, and fails within seconds when the child exits — printing the harness's own
stderr, which says exactly what happened.

**`git commit` is cancelled unless the permission preset is raised.** A commit needs an escalation
to `danger-full-access`, and under the default `workspace-write` preset that escalation is
**cancelled without ever reaching the client** — no `session/request_permission` arrives, so there
is nothing to answer. The turn ends normally and the worktree is quietly dirty. Measured on one
brief and one model, changing only the preset:

```
--permission-mode workspace-write      → settled=false delivered=false, no commit
--permission-mode danger-full-access   → settled=true  delivered=true,  commit landed
```

Pass it whenever a run is expected to produce commits. It is not the default because it turns
approval prompts off on a host with no isolation.

**`session/prompt` does not reliably return a stop reason.** It returned `end_turn` on a read-only
turn and nothing at all on a turn that used tools. The driver also reads the `session/update`
stream and reports `absent` rather than inventing one.

**The shipped ACP bundle hard-codes the model route.** `packages/bundle/acp-app/cordis.patch.yml`
sets `provider: deepseek-official` and `model: deepseek-v4-flash`. That route takes its key from
the credentials service, not from `settings.yaml`, so a correctly configured custom provider still
fails the first prompt with *"no API key for provider route deepseek-official"*. Do not edit the
bundle — an upstream update takes the edit back. The driver writes an overlay and passes
`--patch`.

**`session/new` can return an empty option list.** The README describes
`session/set_config_option` for choosing `model` and `reasoning_effort`; on this composition the
returned `configOptions` is empty, so the model cannot be switched per session. It is pinned in
plugin config, which means **one model per server process**. To compare models, start one server
per model rather than reconfiguring a session.

**A prompt stalls unless permission requests are answered.** The server calls
`session/request_permission` back at the client mid-turn. A controller that only sends and never
answers sits until its timeout with no error at all.

## Starting the server by hand

Only when DSH itself is the thing under investigation:

```sh
ATLASCLOUD_API_KEY=… pnpm dsh --profile acp --patch ~/.dsh/atlascloud.patch.yml
```

Run from a `deepseek-harness` checkout. `--profile acp` serves the Agent Client Protocol over
stdio and exits when the client disconnects. **Stdout carries protocol traffic only** — anything a
plugin writes there corrupts the stream, so keep logging on stderr.

ndJSON, one JSON object per line, both directions:

| call | what it gives you |
| --- | --- |
| `initialize` | protocol version; send first |
| `session/new` | a session id, an absolute `cwd`, and the config-option state |
| `session/prompt` | one prompt at a time per session; settles on agent idle |
| `session/close` | closes one session without touching its siblings |
| `session/list` | resumable sessions, newest first, optional `cwd` filter |
| `session/resume` | a persisted session, log restored without replaying updates |
| `session/cancel` | cancels the in-flight prompt |

Server → client: `session/update` carries assistant text, thoughts and tool lifecycle;
`session/request_permission` must be answered. Unsupported, and they reject rather than degrade:
`session/load`, delete, fork, additional directories, SSE or ACP-transport MCP, modes, commands,
plans, terminals, elicitation.

## Configuration

`$DSH_HOME` defaults to `~/.dsh`. Providers go in `settings.yaml`; adapters re-read on the next
request, so nothing needs a restart:

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

`apiKeyEnv` rather than an inline key: this file is hand-edited and gets copied around. Mode 600
on it and on any overlay.

Model ids are the gateway's exact strings from `GET /v1/models` — the `deepseek-ai/` prefix is
part of the id. A model entered by hand is treated as text-only until `input: [text, image]` says
otherwise, and attaching an image to one is refused before it is sent.

## The brief

DSH is not in your conversation. Everything it needs is in the brief or in files it can read —
and `AGENTS.md` is one of those, so describe *the task* and let the repository carry *the rules*.

- Point at files, do not summarise them — say where they are.
- State what must be demonstrated, and that a probe is derived from the defect rather than from
  the fix.
- Name what it must not touch.
- Ask what it could not do. An honest gap is worth more than a quiet one.

## After DSH returns

**Verify before you believe.** Run the build, run the tests, and reproduce at least one claim by
hand. The driver's `delivered=true` proves a commit exists, not that the commit is right.

Give a second run a fresh session — never the one that produced the work, which would hand it its
own conclusions as context.

## Before believing a negative

Every wrong call made against these harnesses came from an instrument that failed towards
*nothing is running*.

- A prompt that returns nothing may be an unanswered permission request, not a dead agent.
- An empty `configOptions` is a real answer, not a transport failure.
- A session missing from `session/list` is not proof the work did not happen — a cleanly closed
  session is gone from the list and its effects are on disk.

Prove the instrument can report a positive before trusting it to report a negative.

## What is good here, and what is not established

Measured on this host: `initialize` → protocol version 1; `session/new` → a session id; a prompt
answered in seconds through `atlascloud/deepseek-ai/deepseek-v4-flash-0731`; `session/close`
clean; `AGENTS.md` reaching the model; a commit landing under a raised permission preset. The
overlay is what makes the prompt work — without it the same setup fails on the hard-coded route.

**Not established:** `session/list` / `session/resume` across a server restart, cancellation, MCP
mounting, image input. Those are claims from the README, not from a run, and this skill says so
rather than repeating them as fact.

## Cost

DSH is billed by the provider the overlay names. Through AtlasCloud, a full day of coder work
measured **$0.33**. `max_tokens` is a ceiling and not a spend, so declare the model's real one in
the provider config — a model added by hand otherwise inherits a default far below its capability,
and a run that hits it ends with `stopReason: "length"` having produced nothing.
