#!/usr/bin/env node
// Drive one DeepSeek Harness task end to end over ACP and exit.
//
//   dsh-pilot.mjs --cwd <dir> --brief <file> [--model <id>] [--provider <id>]
//                 [--out <file>] [--timeout <seconds>] [--precheck <shell cmd>]
//                 [--no-require-commit] [--node <path to node >= 22>]
//                 [--permission-mode read-only|workspace-write|danger-full-access]
//
// Writes a transcript to --out (default: stdout is kept clean for the summary).
// Exits non-zero when the turn does not settle, so a caller can tell the
// difference between "the agent finished" and "the wait gave up" — every wrong
// call against these harnesses has come from an instrument that could not.
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const cwd = resolve(arg('cwd', process.cwd()));
const briefPath = arg('brief');
const model = arg('model', 'deepseek-ai/deepseek-v4-flash-0731');
const provider = arg('provider', 'atlascloud');
const outPath = arg('out');
const timeoutMs = Number(arg('timeout', '3600')) * 1000;
const repo = arg('repo', '/home/team/workspaces/deepseek-harness');
// Round 4 measured both of these failing silently: the coder left a dirty tree and the
// driver still exited 0, and a whole run spent itself in a worktree where `npm test`
// could not start. Both default on; a caller that genuinely wants neither opts out.
const requireCommit = !argv.includes('--no-require-commit');
const precheck = arg('precheck');
// `git commit` needs an escalation the default `workspace-write` preset cancels without
// ever asking the client, so a coder run under the default silently ends with a dirty tree
// and no commit. Measured: the same brief and model delivers a commit under
// danger-full-access and does not under workspace-write. Named here rather than defaulted,
// because it turns off approval prompts on a host with no isolation.
const permissionMode = arg('permission-mode', 'workspace-write');

// DSH needs Node >= 22 (`createZstdDecompress`, `Promise.withResolvers`). Spawning bare
// `node` inherits whatever is on PATH: on this host that is v20, and the harness then dies
// during plugin load while the driver sits out its whole timeout waiting for a reply that
// can never come. Resolve the binary here and refuse early rather than time out later.
function nodeMajor(bin) {
  try { return Number(execFileSync(bin, ['-v'], { encoding: 'utf8' }).trim().replace(/^v/, '').split('.')[0]); }
  catch { return 0; }
}
const pinnedNode = arg('node');
let nodeBin;
if (pinnedNode) {
  // An explicit --node is a pin, not a preference. Quietly running a different binary than
  // the one asked for is the silent substitution this project keeps being bitten by.
  if (nodeMajor(pinnedNode) < 22) {
    console.error(`dsh-pilot: --node ${pinnedNode} is v${nodeMajor(pinnedNode) || '?'}; DSH needs >= 22.`);
    process.exit(3);
  }
  nodeBin = pinnedNode;
} else {
  const candidates = [process.execPath, '/home/team/.local/node24/bin/node', 'node'];
  nodeBin = candidates.find(bin => nodeMajor(bin) >= 22);
  if (!nodeBin) {
    console.error('dsh-pilot: no Node >= 22 found. DSH will not load on older majors; pass --node <path>.');
    console.error('  tried: ' + candidates.map(b => `${b} (v${nodeMajor(b) || '?'})`).join(', '));
    process.exit(3);
  }
}

function gitOrNull(args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }
  catch { return null; }
}

if (!briefPath) { console.error('dsh-pilot: --brief is required'); process.exit(2); }
const brief = readFileSync(briefPath, 'utf8');

// The shipped acp bundle pins provider/model in plugin config; an overlay is the
// supported way to change them without editing a file an update would revert.
const patch = `/tmp/dsh-pilot-${process.pid}.patch.yml`;
writeFileSync(patch, `- id: acp\n  config:\n    provider: ${provider}\n    model: ${model}\n`);

// A coder that cannot run the test cannot tell you its fix is untested. Establish that
// the environment works before spending a run in it.
if (precheck) {
  try {
    execFileSync('bash', ['-lc', precheck], { cwd, stdio: 'pipe', timeout: 900_000 });
  } catch (err) {
    console.error(`dsh-pilot: precheck failed in ${cwd}: ${precheck}`);
    console.error(String(err.stdout ?? '').slice(-800) + String(err.stderr ?? '').slice(-800));
    process.exit(3);
  }
}

const headBefore = requireCommit ? gitOrNull(['rev-parse', 'HEAD']) : null;

const started = Date.now();
const log = (line) => { if (outPath) appendFileSync(outPath, line + '\n'); };
if (outPath) writeFileSync(outPath, '');

const child = spawn(nodeBin, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'acp', '--patch', patch],
  { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DSH_PERMISSION_MODE: permissionMode } });
let stderrTail = '';
child.stderr.on('data', d => {
  const s = d.toString();
  stderrTail = (stderrTail + s).slice(-2000);
  log('[stderr] ' + s.trimEnd());
});

// A child that has already exited will never settle. Saying so immediately is the whole
// difference between a diagnosable failure and a timeout that blames the wait.
child.on('exit', (code, signal) => {
  if (finished) return;
  console.error(`dsh-pilot: the harness exited before the turn settled (code=${code} signal=${signal}).`);
  if (stderrTail.trim()) console.error(stderrTail.trim().split('\n').slice(0, 12).join('\n'));
  process.exit(3);
});

let nextId = 1;
const pending = new Map();
let permissionsAnswered = 0;
let lastActivity = Date.now();
let lastStopReason = null;
let finished = false;

createInterface({ input: child.stdout }).on('line', line => {
  if (!line.trim()) return;
  let m; try { m = JSON.parse(line); } catch { return; }
  lastActivity = Date.now();
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'session/update') {
    // `session/prompt` does not reliably carry the stop reason: round 4's coder run
    // returned no such field at all. The update stream does, so keep the last one seen
    // and use it when the reply omits it.
    const u = m.params?.update ?? m.params;
    const seen = u?.stopReason ?? u?.stop_reason;
    if (typeof seen === 'string') lastStopReason = seen;
    log('[update] ' + JSON.stringify(m.params).slice(0, 600));
    return;
  }
  if (m.method === 'session/request_permission') {
    // Unanswered permission requests stall the turn with no error — the failure
    // mode that looks exactly like a hung agent.
    const opts = m.params?.options ?? [];
    const allow = opts.find(o => /allow/i.test(`${o.kind ?? ''}${o.name ?? ''}${o.optionId ?? ''}`)) ?? opts[0];
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id,
      result: { outcome: { outcome: 'selected', optionId: allow?.optionId } } }) + '\n');
    permissionsAnswered += 1;
    log(`[permission] answered ${allow?.optionId ?? '(none)'}`);
  }
});

const call = (method, params) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, m => m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error).slice(0, 300)}`)) : res(m.result));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

const deadline = setTimeout(() => {
  finished = true;
  const idle = Math.round((Date.now() - lastActivity) / 1000);
  console.error(`dsh-pilot: no settlement within ${timeoutMs / 1000}s (last activity ${idle}s ago)`);
  if (idle >= timeoutMs / 1000) console.error('dsh-pilot: nothing was ever received from the harness — suspect startup, not a slow turn.');
  child.kill('SIGTERM');
  process.exit(124);
}, timeoutMs);

try {
  await call('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const s = await call('session/new', { cwd, mcpServers: [] });
  const sid = s.sessionId ?? s.session_id;
  log(`[session] ${sid} cwd=${cwd} model=${provider}/${model} permission=${permissionMode}`);

  const r = await call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: brief }] });
  const seconds = Math.round((Date.now() - started) / 1000);
  const stopReason = r?.stopReason ?? r?.stop_reason ?? lastStopReason;
  const settled = stopReason === 'end_turn';

  // "It finished" and "it produced something" are different questions, and a driver that
  // answers only the first is the blind instrument this project keeps rebuilding.
  let delivered = true, why = '';
  if (requireCommit) {
    const headAfter = gitOrNull(['rev-parse', 'HEAD']);
    const dirty = gitOrNull(['status', '--porcelain']);
    if (headAfter && headBefore && headAfter === headBefore) {
      delivered = false;
      why = permissionMode === 'workspace-write'
        ? 'no commit was made — under --permission-mode workspace-write the escalation `git commit` needs is cancelled without reaching this client'
        : 'no commit was made';
    }
    else if (dirty) { delivered = false; why = `worktree left dirty:\n${dirty}`; }
  }

  console.log(`dsh-pilot: stopReason=${stopReason ?? 'absent'} settled=${settled} delivered=${delivered} seconds=${seconds} permissions=${permissionsAnswered} session=${sid}`);
  if (!delivered) console.error(`dsh-pilot: the turn ended but nothing landed — ${why}`);
  log(`[done] stopReason=${stopReason ?? 'absent'} settled=${settled} delivered=${delivered} seconds=${seconds}`);

  finished = true;
  await call('session/close', { sessionId: sid }).catch(() => {});
  clearTimeout(deadline);
  child.kill('SIGTERM');
  // 0 only when the turn settled AND the work landed. 1 otherwise, so a caller never
  // reads "the process exited cleanly" as "the task is done".
  process.exit(settled && delivered ? 0 : 1);
} catch (e) {
  console.error('dsh-pilot:', e.message);
  clearTimeout(deadline);
  child.kill('SIGTERM');
  process.exit(1);
}
