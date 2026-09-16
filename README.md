# dsh-pilot

Drive [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as a job: hand it a
brief, let it work, and get an exit code that distinguishes *the agent finished* from *the wait
gave up* — because every wrong call made against these harnesses came from an instrument that
could not tell those apart.

Used alongside [pi-pilot](https://github.com/kokorolx/pi-pilot). Both harnesses load the
workspace's `AGENTS.md`, so a brief describes the task and the repository carries the standard.

## What is here

| | |
| --- | --- |
| `SKILL.md` | the operating knowledge — what costs time, what a negative result does not prove |
| `dsh-pilot.mjs` | the driver: one task, start to finish, over ACP |

## Requirements

- **Node ≥ 22.** DSH uses `createZstdDecompress` and `Promise.withResolvers`. On Node 20 it dies
  during plugin load, and a driver that only watches for a reply will sit out its whole timeout
  waiting for a process that is already gone. The driver resolves a suitable binary itself and
  refuses early when it cannot.
- A DSH checkout (`--repo`, default `/home/team/workspaces/deepseek-harness`).
- Credentials for the provider the profile resolves — for AtlasCloud, `ATLASCLOUD_API_KEY`.

## Use

```sh
node dsh-pilot.mjs --cwd <worktree> --brief <file> [--out <log>] \
  [--model <id>] [--provider <id>] [--permission-mode danger-full-access] \
  [--precheck 'npm test'] [--node /path/to/node22+] [--timeout 3600]
```

Exit codes are the point:

| code | meaning |
| --- | --- |
| `0` | the turn settled **and** the work landed as a commit |
| `1` | it ended without settling, or nothing landed |
| `3` | refused before starting — no Node ≥ 22, precheck failed, or the harness died at startup |
| `124` | no settlement inside the timeout |

## Two things that will cost you a run if you do not know them

**`git commit` needs `--permission-mode danger-full-access`.** Under the default
`workspace-write` preset the escalation a commit requires is cancelled *without ever reaching the
client* — no permission request arrives, so there is nothing to approve. The turn then ends
normally and the worktree is quietly dirty. Measured on one brief and one model, changing only
the preset: `workspace-write` → no commit; `danger-full-access` → commit landed.

It is not the default here because it turns approval prompts off on a host with no isolation.

**`session/prompt` does not reliably return a stop reason.** It returned `end_turn` on a
read-only turn and nothing at all on a turn that used tools. The driver also reads the
`session/update` stream and reports `absent` rather than inventing one.

## Why the driver checks that a commit exists

"It finished" and "it produced something" are different questions, and a driver that answers only
the first is the blind instrument this whole skill exists to avoid. `--no-require-commit` opts
out when a run is genuinely read-only.
