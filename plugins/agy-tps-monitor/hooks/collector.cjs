'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  getSessionFile,
  readJsonSafe,
  isPidAlive,
  markToolRunningFast,
  syncSessionFromTranscript,
} = require('../lib/telemetry.cjs');

const mode = process.argv[2] || '';

function emitOutput(modeName) {
  if (modeName === 'pre_tool' || modeName === 'stop') {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
  } else {
    process.stdout.write('{}');
  }
}

/**
 * Resolves the persistent Language Server daemon PID from ANTIGRAVITY_LS_ADDRESS (localhost:<port>)
 * -> ~/.gemini/antigravity/daemon/hub_<port>.json so we can detect server restarts / window exits
 * deterministically without touching sockets or mistaking Windows `cmd /c` wrapper PIDs.
 */
function resolveOwnerDaemonInfo() {
  try {
    const home = process.env.AGY_TPS_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir();
    const lsAddr = String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
    const portMatch = /:(\d+)$/.exec(lsAddr);
    if (portMatch) {
      const port = portMatch[1];
      for (const surf of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
        const hubFile = path.join(home, '.gemini', surf, 'daemon', `hub_${port}.json`);
        if (fs.existsSync(hubFile)) {
          const st = fs.statSync(hubFile);
          const hub = readJsonSafe(hubFile, null);
          const pid = Number(hub && hub.pid ? hub.pid : 0);
          if (pid > 0 && isPidAlive(pid)) {
            return { ownerPid: pid, ownerPids: [pid], ownerHubFile: hubFile, ownerHubMtimeMs: Math.round(st.mtimeMs) };
          }
        }
      }
    }
    // Fallback when hook env omits ANTIGRAVITY_LS_ADDRESS: snapshot all active recent daemon PIDs
    const daemonDir = path.join(home, '.gemini', 'antigravity', 'daemon');
    if (fs.existsSync(daemonDir)) {
      const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
      const pids = [];
      for (const f of fs.readdirSync(daemonDir)) {
        if (!f.startsWith('hub_') || !f.endsWith('.json')) continue;
        const hp = path.join(daemonDir, f);
        try {
          const st = fs.statSync(hp);
          if (st.mtimeMs < cutoff) continue;
          const hub = readJsonSafe(hp, null);
          const pid = Number(hub && hub.pid ? hub.pid : 0);
          if (pid > 0 && isPidAlive(pid) && !pids.includes(pid)) pids.push(pid);
        } catch {}
      }
      if (pids.length > 0) {
        return { ownerPid: pids.length === 1 ? pids[0] : null, ownerPids: pids, ownerHubFile: '', ownerHubMtimeMs: 0 };
      }
    }
  } catch {}
  return { ownerPid: null, ownerPids: [], ownerHubFile: '', ownerHubMtimeMs: 0 };
}

try {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  const payload = raw && raw.trim() ? JSON.parse(raw) : {};
  const conversationId = payload.conversationId;
  const nowMs = Date.now();

  if (conversationId) {
    if (mode === 'pre_invocation') {
      const daemonInfo = resolveOwnerDaemonInfo();
      syncSessionFromTranscript(conversationId, {
        transcriptPath: payload.transcriptPath,
        cwd: payload.cwd,
        workspacePaths: payload.workspacePaths,
        modelName: payload.modelName,
        lastUserInput: payload.lastUserInput,
        status: 'generating',
        activeStartMs: nowMs,
        ownerPid: daemonInfo.ownerPid,
        ownerPids: daemonInfo.ownerPids,
        ownerHubFile: daemonInfo.ownerHubFile,
        ownerHubMtimeMs: daemonInfo.ownerHubMtimeMs,
        captureCancelBaseline: true,
        fromActiveHook: true,
      });
    } else if (mode === 'pre_tool') {
      markToolRunningFast(conversationId, {
        transcriptPath: payload.transcriptPath,
        cwd: payload.cwd,
        workspacePaths: payload.workspacePaths,
        modelName: payload.modelName,
        nowMs,
      });
    } else if (mode === 'post_invocation') {
      const existing = readJsonSafe(getSessionFile(conversationId), null);
      syncSessionFromTranscript(conversationId, {
        transcriptPath: payload.transcriptPath,
        cwd: payload.cwd,
        workspacePaths: payload.workspacePaths,
        modelName: payload.modelName,
        status: 'tool_running',
        llmStartMs: existing && existing.status === 'generating' ? existing.activeStartMs : null,
        llmEndMs: existing && existing.status === 'generating' ? nowMs : null,
        activeStartMs: null,
        fromActiveHook: true,
      });
    } else if (mode === 'stop') {
      const existing = readJsonSafe(getSessionFile(conversationId), null);
      const termReason = String(payload.terminationReason || 'NO_TOOL_CALL').toUpperCase();
      const isCanceledOrAborted =
        termReason === 'USER_CANCELED' ||
        termReason === 'TERMINAL_CUSTOM_HOOK' ||
        (termReason === 'ERROR' && Boolean(payload.error));

      if (isCanceledOrAborted) {
        const refStart = Number(
          (existing && (existing.activeStartMs || existing.currentInvocationStartMs || existing.turnOriginMs)) || 0
        );
        syncSessionFromTranscript(conversationId, {
          transcriptPath: payload.transcriptPath,
          cwd: payload.cwd,
          workspacePaths: payload.workspacePaths,
          modelName: payload.modelName,
          status: 'interrupted',
          interruptedAtMs: nowMs,
          interruptedElapsedMs: refStart > 0 ? Math.max(0, nowMs - refStart) : null,
          interruptedReason: termReason === 'USER_CANCELED' ? '用户手动中断' : '执行异常中断',
          activeStartMs: null,
          fromActiveHook: true,
        });
      } else {
        syncSessionFromTranscript(conversationId, {
          transcriptPath: payload.transcriptPath,
          cwd: payload.cwd,
          workspacePaths: payload.workspacePaths,
          modelName: payload.modelName,
          status: 'idle',
          llmStartMs: existing && existing.status === 'generating' ? existing.activeStartMs : null,
          llmEndMs: existing && existing.status === 'generating' ? nowMs : null,
          activeStartMs: null,
          fromActiveHook: true,
        });
      }
    }
  }
} catch {
  // Never fail or block agent execution
}

emitOutput(mode);
