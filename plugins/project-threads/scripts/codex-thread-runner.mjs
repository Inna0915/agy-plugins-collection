import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolveLsEndpoint } from '../lib/ls-client.mjs';
import {
  inspectWorktreeGit,
  loadRegistry,
  saveRegistry,
  syncCompletionToCoordinator,
} from '../lib/store.mjs';
import { syncCodexThreadRecord } from '../lib/codex-adapter.mjs';

function updateRunInRegistry(threadId, round, updater) {
  try {
    const reg = loadRegistry();
    const t = reg.threads[threadId];
    if (!t || !t.codex || !Array.isArray(t.codex.runs)) return null;
    const run = t.codex.runs.find((r) => r.round === round) || t.codex.runs[t.codex.runs.length - 1];
    if (!run) return null;
    updater(t, run);
    t.updatedAt = new Date().toISOString();
    saveRegistry(reg);
    return t;
  } catch {
    return null;
  }
}

function quoteWinArg(val) {
  const s = String(val ?? '').replace(/\r?\n/g, ' ');
  return `"${s.replace(/"/g, '\\"')}"`;
}

function buildPlatformSpawn(exe, args) {
  const isWinBatch = process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(exe);
  if (isWinBatch) {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${quoteWinArg(exe)} ${args.map(quoteWinArg).join(' ')}"`],
      extraOpts: { windowsVerbatimArguments: true },
    };
  }
  return { command: exe, args, extraOpts: {} };
}

async function main() {
  const reqPath = process.argv[2] || '';
  if (!reqPath || !existsSync(reqPath)) {
    process.exit(1);
  }

  let req;
  try {
    req = JSON.parse(readFileSync(reqPath, 'utf8'));
  } catch {
    process.exit(1);
  }

  const { threadId, round, pwshExe, invokeArgs } = req;
  resolveLsEndpoint();

  const spec = buildPlatformSpawn(pwshExe, invokeArgs);
  const child = spawn(spec.command, spec.args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
    ...spec.extraOpts,
  });

  updateRunInRegistry(threadId, round, (t, run) => {
    run.runnerPid = child.pid || 0;
    run.state = 'running';
    t.runState = 'RUN_STATE_RUNNING';
  });

  let stderrBuf = '';
  const handleStderrLine = (rawLine) => {
    const line = String(rawLine || '').trim();
    if (!line) return;

    if (line.startsWith('WORKER_STARTUP ')) {
      try {
        const info = JSON.parse(line.slice('WORKER_STARTUP '.length));
        updateRunInRegistry(threadId, round, (t, run) => {
          if (info.runId) run.runId = info.runId;
          if (info.runnerPid) run.runnerPid = info.runnerPid;
          if (info.statusFile) run.statusFile = info.statusFile;
          if (info.eventsFile) run.eventsFile = info.eventsFile;
          if (info.cwd && info.worktreeUsed) t.worktreePath = info.cwd;
          run.state = 'running';
        });
      } catch {
        // Ignore malformed startup line
      }
      return;
    }

    if (line.startsWith('CODEX_DESKTOP_URL=')) {
      const url = line.slice('CODEX_DESKTOP_URL='.length).trim();
      const uuidMatch = url.match(/codex:\/\/threads\/([0-9a-f-]{8,64})/i);
      updateRunInRegistry(threadId, round, (t) => {
        if (url) t.codex.desktopUrl = url;
        if (uuidMatch && uuidMatch[1]) t.codex.sessionId = uuidMatch[1];
      });
    }
  };

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk;
    let idx;
    while ((idx = stderrBuf.indexOf('\n')) !== -1) {
      const line = stderrBuf.slice(0, idx);
      stderrBuf = stderrBuf.slice(idx + 1);
      handleStderrLine(line);
    }
  });
  // Drain stdout so child process never blocks on full stdout pipe buffer
  child.stdout.resume();

  const exitCode = await new Promise((resolveExit) => {
    child.on('error', (err) => {
      updateRunInRegistry(threadId, round, (t, run) => {
        run.state = 'failed';
        run.errorKind = 'spawn_error';
        run.error = err?.message || 'Failed to spawn PowerShell Codex runner';
        run.finishedAt = new Date().toISOString();
        t.runState = 'RUN_STATE_IDLE';
      });
      resolveExit(1);
    });
    child.on('close', (code) => {
      if (stderrBuf.trim()) handleStderrLine(stderrBuf);
      resolveExit(typeof code === 'number' ? code : 1);
    });
  });

  // Final sync of status.json into registry
  try {
    const reg = loadRegistry();
    const t = reg.threads[threadId];
    if (t) {
      const run = t.codex?.runs?.find((r) => r.round === round) || t.codex?.runs?.[t.codex.runs.length - 1];
      if (run) {
        if (run.exitCode === null || run.exitCode === undefined) run.exitCode = exitCode;
        if (!run.finishedAt) run.finishedAt = new Date().toISOString();
        if (run.state === 'running' || run.state === 'starting') {
          run.state = exitCode === 0 ? 'finished' : exitCode === 124 ? 'timeout' : 'failed';
        }
      }
      await syncCodexThreadRecord(t, { inspectGitFn: inspectWorktreeGit });
      t.runState = 'RUN_STATE_IDLE';
      t.lastCompletedAt = t.lastCompletedAt || new Date().toISOString();
      t.updatedAt = new Date().toISOString();
      saveRegistry(reg);
    }
  } catch {
    // Non-fatal; Sidecar watcher can still reconcile
  }

  // Trigger near-instant callback push to Coordinator
  try {
    await syncCompletionToCoordinator({
      threadId,
      force: false,
      timeoutMs: 10000,
    });
  } catch {
    // Sidecar 10s watcher & PreInvocation fallback will retry automatically
  }

  try {
    unlinkSync(reqPath);
  } catch {
    // Ignore cleanup error
  }
}

main().catch(() => {
  process.exit(1);
});
