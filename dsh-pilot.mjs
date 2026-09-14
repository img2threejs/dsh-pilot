#!/usr/bin/env node
// Drive one DeepSeek Harness task end to end over ACP and exit.
//
//   dsh-pilot.mjs --cwd <dir> --brief <file> [--model <id>] [--provider <id>]
//                 [--out <file>] [--timeout <seconds>]
//
// Writes a transcript to --out (default: stdout is kept clean for the summary).
// Exits non-zero when the turn does not settle, so a caller can tell the
// difference between "the agent finished" and "the wait gave up" — every wrong
// call against these harnesses has come from an instrument that could not.
import { spawn } from 'node:child_process';
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
const model = arg('model', 'deepseek-ai/deepseek-v4-flash');
const provider = arg('provider', 'atlascloud');
const outPath = arg('out');
const timeoutMs = Number(arg('timeout', '3600')) * 1000;
const repo = arg('repo', '/home/team/workspaces/deepseek-harness');

if (!briefPath) { console.error('dsh-pilot: --brief is required'); process.exit(2); }
const brief = readFileSync(briefPath, 'utf8');

// The shipped acp bundle pins provider/model in plugin config; an overlay is the
// supported way to change them without editing a file an update would revert.
const patch = `/tmp/dsh-pilot-${process.pid}.patch.yml`;
writeFileSync(patch, `- id: acp\n  config:\n    provider: ${provider}\n    model: ${model}\n`);

const started = Date.now();
const log = (line) => { if (outPath) appendFileSync(outPath, line + '\n'); };
if (outPath) writeFileSync(outPath, '');

const child = spawn('node', ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'acp', '--patch', patch],
  { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', d => log('[stderr] ' + d.toString().trimEnd()));

let nextId = 1;
const pending = new Map();
let permissionsAnswered = 0;
let lastActivity = Date.now();

createInterface({ input: child.stdout }).on('line', line => {
  if (!line.trim()) return;
  let m; try { m = JSON.parse(line); } catch { return; }
  lastActivity = Date.now();
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'session/update') { log('[update] ' + JSON.stringify(m.params).slice(0, 600)); return; }
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
  console.error(`dsh-pilot: no settlement within ${timeoutMs / 1000}s (last activity ${Math.round((Date.now() - lastActivity) / 1000)}s ago)`);
  child.kill('SIGTERM');
  process.exit(124);
}, timeoutMs);

try {
  await call('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const s = await call('session/new', { cwd, mcpServers: [] });
  const sid = s.sessionId ?? s.session_id;
  log(`[session] ${sid} cwd=${cwd} model=${provider}/${model}`);

  const r = await call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: brief }] });
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`dsh-pilot: stopReason=${r?.stopReason ?? 'unknown'} seconds=${seconds} permissions=${permissionsAnswered} session=${sid}`);
  log(`[done] stopReason=${r?.stopReason} seconds=${seconds}`);

  await call('session/close', { sessionId: sid }).catch(() => {});
  clearTimeout(deadline);
  child.kill('SIGTERM');
  process.exit(r?.stopReason === 'end_turn' ? 0 : 1);
} catch (e) {
  console.error('dsh-pilot:', e.message);
  clearTimeout(deadline);
  child.kill('SIGTERM');
  process.exit(1);
}
