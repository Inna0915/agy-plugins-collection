'use strict';

const fs = require('fs');
const path = require('path');
const {
  TPS_ROOT,
  readJsonSafe,
  writeJsonAtomic,
  markSessionInterrupted,
  getPrefs,
  formatTokensByMode,
  getDurationTier,
  formatDurationSpan,
  formatStartClock,
  getSessionDetail,
  listRecentSessions,
  round1,
} = require('../lib/telemetry.cjs');

const CLI_STATE_DIR = path.join(TPS_ROOT, 'cli');

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

/**
 * Color duration strictly by threshold:
 * < 10s: green, 10s - 100s: yellow, > 100s: red, null/uncollected: dim "未采集"
 */
function colorMs(ms, prefix = '', suffix = '') {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms)) || Number(ms) < 0) {
    return `${ANSI.dim}${prefix}未采集${suffix}${ANSI.reset}`;
  }
  const tier = getDurationTier(ms);
  const c = tier === 'green' ? ANSI.green : tier === 'yellow' ? ANSI.yellow : ANSI.red;
  const sec = `${(Number(ms) / 1000).toFixed(1)}s`;
  return `${c}${ANSI.bold}${prefix}${sec}${suffix}${ANSI.reset}`;
}

function normDir(d) {
  return String(d || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function pickCliSession(payload) {
  const explicitId =
    payload.conversation_id ||
    payload.conversationId ||
    payload.session_id ||
    payload.sessionId ||
    '';

  if (explicitId) {
    const detail = getSessionDetail(explicitId, true);
    if (detail) return detail;
  }

  const sessions = listRecentSessions({ hydrate: true });
  if (!sessions.length) return null;

  const cwdNorm = normDir(payload?.workspace?.current_dir || payload?.cwd || '');

  if (cwdNorm) {
    const exactCli = sessions.find((s) => s.surface === 'CLI' && normDir(s.cwd) === cwdNorm);
    if (exactCli) return exactCli;
  }
  const anyCli = sessions.find((s) => s.surface === 'CLI');
  if (anyCli) return anyCli;

  if (cwdNorm) {
    const exactAny = sessions.find((s) => normDir(s.cwd) === cwdNorm);
    if (exactAny) return exactAny;
  }
  return sessions[0];
}

try {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  const payload = raw && raw.trim() ? JSON.parse(raw) : {};
  const nowMs = Date.now();
  const prefs = getPrefs();
  const tokMode = process.env.AGY_TOKEN_FORMAT === 'raw'
    ? 'raw'
    : process.env.AGY_TOKEN_FORMAT === 'M'
    ? 'M'
    : prefs.tokenFormat;

  const agentState = String(payload.agent_state || 'idle').toLowerCase();
  const isBusyState =
    agentState === 'running' ||
    agentState === 'thinking' ||
    agentState === 'working' ||
    agentState === 'generating';

  const ctxWin = payload.context_window || {};
  const totalInPayload = Number(ctxWin.total_input_tokens || payload.total_input_tokens || 0);
  const totalOutTokPayload = Number(ctxWin.total_output_tokens || payload.total_output_tokens || 0);
  const usedPct = ctxWin.used_percentage !== undefined ? round1(Number(ctxWin.used_percentage)) : null;

  const stateId = String(payload.conversation_id || payload.conversationId || payload.session_id || payload.sessionId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
  const CLI_STATE_FILE = path.join(CLI_STATE_DIR, stateId + '.json');
  const cliState = readJsonSafe(CLI_STATE_FILE, { busySinceMs: null }) || {};
  if (isBusyState && !cliState.busySinceMs) {
    cliState.busySinceMs = nowMs;
    writeJsonAtomic(CLI_STATE_FILE, cliState);
  } else if (!isBusyState && cliState.busySinceMs) {
    cliState.busySinceMs = null;
    writeJsonAtomic(CLI_STATE_FILE, cliState);
  }

  let session = pickCliSession(payload);
  const explicitConvId =
    payload.conversation_id || payload.conversationId || payload.session_id || payload.sessionId || '';
  if (
    agentState === 'idle' &&
    explicitConvId &&
    session &&
    session.conversationId === explicitConvId &&
    session.status === 'generating'
  ) {
    markSessionInterrupted(explicitConvId, 'CLI 手动中断');
    session = getSessionDetail(explicitConvId, true);
  }

  const lastTps = (session && session.lastTps) || 0;
  const avgTps = (session && session.avgTps) || 0;
  const cacheRate = session ? session.cacheHitRate : 0;

  const firstRespMs = session
    ? (session.turnFirstResponseMs !== undefined ? session.turnFirstResponseMs : session.turnFirstTextStepMs)
    : null;
  const firstTextStepMs = session ? session.turnFirstTextStepMs : null;
  const lastStepDurMs = session ? session.lastDurationMs : null;

  const totalTokens =
    (session && session.totalTokens > 0 ? session.totalTokens : 0) ||
    (totalInPayload + totalOutTokPayload);

  const startedAtMs = session && session.sessionStartedAtMs ? session.sessionStartedAtMs : 0;
  const sessionSpanMs = session && typeof session.sessionSpanMs === 'number'
    ? session.sessionSpanMs
    : (startedAtMs > 0 ? Math.max(0, nowMs - startedAtMs) : 0);

  const isGenerating = isBusyState || Boolean(session && session.status === 'generating');
  const isToolRunning = agentState === 'tool' || Boolean(session && session.status === 'tool_running');
  const waitingFirstResp = session
    ? Boolean(session.waitingFirstResponse)
    : (isBusyState && !isToolRunning && firstRespMs === null);

  const modelLabel =
    payload?.model?.display_name ||
    payload?.model?.id ||
    (session && session.modelName) ||
    '';

  const parts = [];

  if (session && session.healthState === 'interrupted' && !isBusyState) {
    const intDur = session.interruptedElapsedMs !== null ? ` (${colorMs(session.interruptedElapsedMs, '中断前 ')})` : '';
    parts.push(`${ANSI.yellow}${ANSI.bold}⏹ ${session.interruptedReason || '已中断'}${ANSI.reset}${intDur}`);
    if (lastTps > 0) {
      parts.push(`${ANSI.cyan}${lastTps} tok/s${ANSI.reset}`);
    }
  } else if (session && session.healthState === 'retrying') {
    parts.push(ANSI.red + ANSI.bold + '↻ 重试中 · 已失败 ' + session.activeRetryCount + ' 次' + ANSI.reset);
    parts.push(colorMs(session.activeStepElapsedMs, '逻辑步骤 '));
    parts.push(colorMs(session.activeRetryWaitMs, '失败等待 ≥'));
  } else if (session && session.healthState === 'stalled') {
    parts.push(ANSI.red + '⚠ 长时间未记录到进展（状态待确认）' + ANSI.reset);
    parts.push(colorMs(session.activeStepElapsedMs ?? session.noProgressMs, '已等待 '));
  } else if (session && session.healthState === 'error') {
    parts.push(ANSI.red + '⚠ 本轮请求失败 / 已停止' + ANSI.reset);
  } else if (waitingFirstResp) {
    const waitElapsed =
      (session && session.waitingFirstResponseElapsedMs !== null && session.waitingFirstResponseElapsedMs !== undefined
        ? session.waitingFirstResponseElapsedMs
        : cliState.busySinceMs ? Math.max(0, nowMs - cliState.busySinceMs) : 0);
    parts.push(colorMs(waitElapsed, '⏳ 等待首响 '));
  } else if (isGenerating) {
    const stepElapsed =
      (session && session.activeStepElapsedMs !== null
        ? session.activeStepElapsedMs
        : cliState.busySinceMs ? Math.max(0, nowMs - cliState.busySinceMs) : 0);
    const seq = (session && session.currentTurnStepSeq) || 2;
    parts.push(colorMs(stepElapsed, `⟳ 第${seq}步推理 `));
    if (firstRespMs !== null) {
      parts.push(colorMs(firstRespMs, '首响 '));
    }
  } else if (isToolRunning) {
    const tpsStr = lastTps > 0 ? `${ANSI.cyan}${ANSI.bold}${lastTps} tok/s${ANSI.reset}` : '--';
    parts.push(`${ANSI.cyan}⚙ 工具执行${ANSI.reset} · ${tpsStr}`);
    if (firstRespMs !== null) {
      parts.push(colorMs(firstRespMs, '首响 '));
    }
    if (lastStepDurMs !== null) {
      parts.push(colorMs(lastStepDurMs, '成功尝试 '));
    }
  } else {
    if (lastTps > 0) {
      parts.push(`${ANSI.cyan}${ANSI.bold}⚡ ${lastTps} tok/s${ANSI.reset} ${ANSI.dim}(均 ${avgTps}${session && session.tpsMode === 'e2e' ? ' · 端到端' : ''})${ANSI.reset}`);
    } else {
      parts.push(`${ANSI.cyan}⚡ TPS 就绪${ANSI.reset}`);
    }
    if (firstRespMs !== null) {
      parts.push(colorMs(firstRespMs, '首响 '));
    }
    if (firstTextStepMs !== null && firstRespMs !== null && firstTextStepMs > firstRespMs + 500) {
      parts.push(colorMs(firstTextStepMs, '首正文 '));
    }
    if (lastStepDurMs !== null) {
      parts.push(colorMs(lastStepDurMs, '成功尝试 '));
    }
  }

  if (session && session.turnRetryCount > 0) {
    parts.push('本轮失败 ' + session.turnRetryCount + ' 次 · ' + colorMs(session.turnRetryWaitMs, '重试损耗 ' + (session.turnRetryWaitIsLowerBound ? '≥' : '')));
  }
  if (session && session.lastRetryCount > 0) {
    parts.push(colorMs(session.lastLogicalDurationMs, '上步含重试 ' + (session.lastLogicalDurationIsLowerBound ? '≥' : '')));
    parts.push(colorMs(lastStepDurMs, '成功尝试 '));
  }

  if (totalTokens > 0) {
    parts.push(`消耗 ${ANSI.bold}${formatTokensByMode(totalTokens, tokMode)}${ANSI.reset}`);
  }

  if (startedAtMs > 0) {
    parts.push(`${ANSI.dim}始 ${formatStartClock(startedAtMs)} (${formatDurationSpan(sessionSpanMs)})${ANSI.reset}`);
  }

  if (cacheRate > 0) {
    parts.push(`${ANSI.magenta}缓存 ${cacheRate}%${ANSI.reset}`);
  }

  if (usedPct !== null && Number.isFinite(usedPct)) {
    parts.push(`Ctx ${usedPct}%`);
  }

  if (modelLabel) {
    parts.push(`${ANSI.blue}${modelLabel}${ANSI.reset}`);
  }

  process.stdout.write(parts.join(` ${ANSI.dim}|${ANSI.reset} `));
} catch {
  process.stdout.write('⚡ TPS Monitor Ready');
}
