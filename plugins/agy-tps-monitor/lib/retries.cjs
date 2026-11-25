'use strict';

const NO_PROGRESS_MS = 6 * 60 * 1000;

function parseFailure(entry) {
  if (entry.type !== 'ERROR_MESSAGE') return null;
  const message = String(entry.error || entry.content || '');
  if (!/API error|request failed|stream idle timeout/i.test(message)) return null;
  const atMs = Date.parse(entry.created_at || '');
  if (!Number.isFinite(atMs)) return null;
  const attempt = /attempt\s+(\d+)/i.exec(message);
  const timeout = /stream idle timeout\s*\((?:(\d+)m)?([\d.]+)s\)/i.exec(message);
  return {
    stepIndex: entry.step_index,
    atMs,
    attempt: attempt ? Number(attempt[1]) : null,
    timeoutMs: timeout ? (Number(timeout[1] || 0) * 60 + Number(timeout[2])) * 1000 : null,
    reason: /stream idle timeout/i.test(message) ? '流式闲置超时' : '模型请求失败',
  };
}

// Derive retry intervals from this conversation only. Never infer retries from a
// global language-server log, which may contain unrelated concurrent requests.
function analyzeRetries(entries, session, steps) {
  const byIndex = new Map(steps.map((step) => [String(step.stepIndex), step]));
  const groups = [];
  let failures = [];
  let turnIndex = 0;
  let boundaryMs = 0;
  let lastEventMs = Number(session.lastHookAtMs || 0);
  const seen = new Set();

  function makeGroup(step, stopped = false) {
    const saved = step ? session.stepTimings[String(step.stepIndex)] || {} : {};
    const attemptStartMs = step ? step.t1Ms : null;
    const hookStart = Number(saved.logicalStartMs || (!step ? session.activeStartMs || session.currentInvocationStartMs : 0) || 0);
    let startMs = hookStart && (!failures.length || hookStart <= failures[0].atMs) ? hookStart : 0;
    let lowerBound = false;
    if (!startMs) {
      if (failures.length) {
        const first = failures[0];
        startMs = Math.max(boundaryMs, first.atMs - (first.timeoutMs || 0));
        lowerBound = true;
      } else {
        startMs = attemptStartMs || 0;
        lowerBound = Boolean(step && !step.precise);
      }
    }
    const stopRef = session.interruptedAtMs || session.stoppedAtMs || null;
    const endMs = step ? step.t4EndMs : (stopped ? stopRef : null);
    const waitEndMs = step ? attemptStartMs : failures.at(-1)?.atMs;
    const retryWaitMs = failures.length && startMs && waitEndMs
      ? Math.max(0, waitEndMs - startMs) : 0;
    return {
      turnIndex,
      stepIndex: step ? step.stepIndex : null,
      logicalStartMs: startMs || null,
      logicalDurationMs: startMs && endMs ? Math.max(0, endMs - startMs) : null,
      logicalDurationIsLowerBound: lowerBound,
      attemptDurationMs: step ? step.durationMs : null,
      retryCount: failures.length,
      retryWaitMs,
      retryWaitIsLowerBound: failures.length > 0 && (lowerBound || !step),
      attempts: failures.map((failure, index) => ({ ...failure, attempt: failure.attempt || index + 1 })),
      lastFailureAtMs: failures.at(-1)?.atMs || null,
      failureReason: failures.at(-1)?.reason || '',
    };
  }

  for (const entry of entries) {
    const atMs = Date.parse(entry.created_at || '') || 0;
    lastEventMs = Math.max(lastEventMs, atMs);
    if (entry.type === 'USER_INPUT') {
      if (failures.length) groups.push(makeGroup(null));
      failures = [];
      turnIndex += 1;
      boundaryMs = atMs;
      continue;
    }
    const failure = parseFailure(entry);
    if (failure) {
      const key = String(failure.stepIndex) + ':' + failure.atMs;
      if (!seen.has(key)) {
        failures.push(failure);
        seen.add(key);
      }
      continue;
    }
    if (entry.type === 'PLANNER_RESPONSE') {
      const step = byIndex.get(String(entry.step_index));
      if (step) {
        const group = makeGroup(step);
        Object.assign(step, group);
        if (group.retryCount > 0) step.precise = false;
        step.effectiveTps = group.logicalDurationMs > 0
          ? Math.round(step.outputTokens * 10000 / group.logicalDurationMs) / 10 : 0;
        groups.push(group);
        boundaryMs = Math.max(boundaryMs, step.t4EndMs || atMs);
        lastEventMs = Math.max(lastEventMs, step.t4EndMs || 0);
      }
      failures = [];
    } else if (entry.type === 'GENERIC') {
      const completed = /Completed At:\s*([^\r\n]+)/.exec(entry.content || '');
      if (completed) {
        const completedMs = Date.parse(completed[1]) || 0;
        boundaryMs = Math.max(boundaryMs, completedMs);
        lastEventMs = Math.max(lastEventMs, completedMs);
      }
    }
  }

  const isStopped = session.status === 'idle' || session.status === 'interrupted';
  const pending = failures.length ? makeGroup(null, isStopped) : null;
  if (pending) groups.push(pending);
  const turnGroups = groups.filter((group) => group.turnIndex === turnIndex);
  const lastStep = steps.at(-1);
  session.retryState = pending;
  session.lastProgressAtMs = lastEventMs;
  session.totalRetryCount = groups.reduce((sum, group) => sum + group.retryCount, 0);
  session.totalRetryWaitMs = groups.reduce((sum, group) => sum + group.retryWaitMs, 0);
  session.retryWaitIsLowerBound = groups.some((group) => group.retryWaitIsLowerBound);
  session.turnRetryCount = turnGroups.reduce((sum, group) => sum + group.retryCount, 0);
  session.turnRetryWaitMs = turnGroups.reduce((sum, group) => sum + group.retryWaitMs, 0);
  session.turnRetryWaitIsLowerBound = turnGroups.some((group) => group.retryWaitIsLowerBound);
  session.totalRequestMs = groups.reduce((sum, group) => sum + (group.logicalDurationMs || group.retryWaitMs), 0);
  session.totalRequestIsLowerBound = groups.some((group) => group.logicalDurationIsLowerBound || group.logicalDurationMs === null);
  session.lastLogicalDurationMs = lastStep?.logicalDurationMs ?? null;
  session.lastLogicalDurationIsLowerBound = lastStep?.logicalDurationIsLowerBound || false;
  session.lastRetryCount = lastStep?.retryCount || 0;
  session.lastRetryWaitMs = lastStep?.retryWaitMs || 0;
  session.lastRetryWaitIsLowerBound = lastStep?.retryWaitIsLowerBound || false;
  session.recentFailures = groups.flatMap((group) => group.attempts).slice(-12);
}

function retrySummary(session, nowMs) {
  const isInterrupted = session.status === 'interrupted';
  const isGenerating = session.status === 'generating';
  const isActive = isGenerating || session.status === 'tool_running';
  const pending = session.retryState;
  const activeRetryCount = isGenerating && pending ? pending.retryCount : 0;
  const noProgressMs = isActive && session.lastProgressAtMs
    ? Math.max(0, nowMs - session.lastProgressAtMs) : 0;
  const longWait = isActive && noProgressMs >= NO_PROGRESS_MS;
  const healthState = isInterrupted ? 'interrupted'
    : isGenerating && activeRetryCount ? 'retrying'
    : longWait ? 'stalled'
    : !isActive && pending ? 'error'
    : isActive ? 'active' : 'idle';
  return {
    healthState,
    interruptedAtMs: isInterrupted ? (session.interruptedAtMs || session.stoppedAtMs || null) : null,
    interruptedElapsedMs: isInterrupted ? (session.interruptedElapsedMs ?? null) : null,
    interruptedReason: isInterrupted ? (session.interruptedReason || '会话已中断') : '',
    noProgressMs,
    longWait,
    lastProgressAtMs: session.lastProgressAtMs || null,
    activeRetryCount,
    activeAttemptNumber: activeRetryCount ? (pending.attempts.at(-1)?.attempt || activeRetryCount) + 1 : 1,
    activeRetryWaitMs: activeRetryCount ? pending.retryWaitMs : 0,
    activeRetryWaitIsLowerBound: activeRetryCount > 0,
    activeSinceFailureMs: activeRetryCount ? Math.max(0, nowMs - pending.lastFailureAtMs) : null,
    lastFailureReason: pending?.failureReason || '',
    totalRetryCount: session.totalRetryCount || 0,
    totalRetryWaitMs: session.totalRetryWaitMs || 0,
    retryWaitIsLowerBound: Boolean(session.retryWaitIsLowerBound),
    turnRetryCount: session.turnRetryCount || 0,
    turnRetryWaitMs: session.turnRetryWaitMs || 0,
    turnRetryWaitIsLowerBound: Boolean(session.turnRetryWaitIsLowerBound),
    totalRequestMs: session.totalRequestMs || 0,
    totalRequestIsLowerBound: Boolean(session.totalRequestIsLowerBound),
    lastLogicalDurationMs: session.lastLogicalDurationMs ?? null,
    lastLogicalDurationIsLowerBound: Boolean(session.lastLogicalDurationIsLowerBound),
    lastRetryCount: session.lastRetryCount || 0,
    lastRetryWaitMs: session.lastRetryWaitMs || 0,
    lastRetryWaitIsLowerBound: Boolean(session.lastRetryWaitIsLowerBound),
    recentFailures: session.recentFailures || [],
  };
}

module.exports = { analyzeRetries, retrySummary, parseFailure, NO_PROGRESS_MS };
