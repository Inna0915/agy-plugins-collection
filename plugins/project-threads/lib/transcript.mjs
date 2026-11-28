import { existsSync, openSync, readFileSync, readSync, closeSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isSameModelFamily } from './model-format.mjs';

export function getAppDataDir() {
  return process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), '.gemini', 'antigravity');
}

export function getTranscriptPath(conversationId) {
  if (!conversationId || !/^[a-zA-Z0-9_-]{8,128}$/.test(conversationId)) return '';
  return join(getAppDataDir(), 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');
}

export function getFullTranscriptPath(transcriptPath) {
  if (!transcriptPath) return '';
  return join(dirname(transcriptPath), 'transcript_full.jsonl');
}

const timelineCache = new Map(); // convId -> { stamp, parsed }
const activityCache = new Map(); // convId -> { stamp, activity }
const modelCache = new Map(); // convId -> { stamp, model }
const telemetryCache = new Map(); // cacheKey -> { stamp, telemetry }
const fullTranscriptCache = new Map(); // fullPath -> { stamp, byStepIndex, byLine }

function fileStamp(filePath) {
  try {
    const st = statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}

function combinedFileStamp(transcriptPath) {
  const mainStamp = transcriptPath ? fileStamp(transcriptPath) : '';
  if (!mainStamp) return '';
  const fullPath = getFullTranscriptPath(transcriptPath);
  const fullStamp = fullPath ? fileStamp(fullPath) : '';
  return fullStamp ? `${mainStamp}|full:${fullStamp}` : mainStamp;
}

function isStepTruncated(step) {
  if (!step || typeof step !== 'object') return false;
  if (Array.isArray(step.truncated_fields) && step.truncated_fields.length > 0) return true;
  if (typeof step.content === 'string' && step.content.includes('<truncated ')) return true;
  if (typeof step.thinking === 'string' && step.thinking.includes('<truncated ')) return true;
  return false;
}

function readFullTranscriptIndex(fullPath) {
  if (!fullPath || !existsSync(fullPath)) return null;
  const stamp = fileStamp(fullPath);
  if (!stamp) return null;

  const cached = fullTranscriptCache.get(fullPath);
  if (cached && cached.stamp === stamp) return cached;

  try {
    const rawLines = readFileSync(fullPath, 'utf8').split(/\r?\n/).filter(Boolean);
    const byStepIndex = new Map();
    const byLine = [];
    for (let i = 0; i < rawLines.length; i++) {
      try {
        const parsed = JSON.parse(rawLines[i]);
        byLine.push(parsed);
        if (Number.isInteger(parsed?.step_index)) {
          byStepIndex.set(parsed.step_index, parsed);
        }
      } catch {
        byLine.push(null);
      }
    }
    const entry = { stamp, byStepIndex, byLine };
    fullTranscriptCache.set(fullPath, entry);
    if (fullTranscriptCache.size > 16) {
      fullTranscriptCache.delete(fullTranscriptCache.keys().next().value);
    }
    return entry;
  } catch {
    return null;
  }
}

function loadTranscriptSteps({ conversationId = '', overrideTranscriptPath = '', tailBytes = 0 } = {}) {
  const path =
    overrideTranscriptPath && existsSync(overrideTranscriptPath)
      ? overrideTranscriptPath
      : getTranscriptPath(conversationId);
  const stamp = combinedFileStamp(path);
  if (!stamp) {
    return { stamp: '', steps: [] };
  }

  let rawText = '';
  let isFullRead = true;
  try {
    if (tailBytes > 0) {
      const st = statSync(path);
      const readLen = Math.min(st.size, tailBytes);
      isFullRead = st.size <= tailBytes;
      const fd = openSync(path, 'r');
      try {
        const buf = Buffer.alloc(readLen);
        readSync(fd, buf, 0, readLen, st.size - readLen);
        rawText = buf.toString('utf8');
      } finally {
        closeSync(fd);
      }
    } else {
      rawText = readFileSync(path, 'utf8');
      isFullRead = true;
    }
  } catch {
    return { stamp: '', steps: [] };
  }

  let steps = rawText
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });

  if (steps.length > 0 && steps.some(isStepTruncated)) {
    const fullIndex = readFullTranscriptIndex(getFullTranscriptPath(path));
    if (fullIndex) {
      steps = steps.map((step, idx) => {
        if (!isStepTruncated(step)) return step;
        if (Number.isInteger(step?.step_index) && fullIndex.byStepIndex.has(step.step_index)) {
          return fullIndex.byStepIndex.get(step.step_index);
        }
        if (isFullRead && idx < fullIndex.byLine.length && fullIndex.byLine[idx]) {
          return fullIndex.byLine[idx];
        }
        return step;
      });
    }
  }

  return { stamp, steps };
}

function unquoteArg(val) {
  if (typeof val !== 'string') return val;
  if (val.startsWith('"') && val.endsWith('"')) {
    try {
      return JSON.parse(val);
    } catch {
      return val.slice(1, -1);
    }
  }
  return val;
}

function parseMaybeJson(val) {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return val;
    }
  }
  return unquoteArg(val);
}

function lowerFirst(s) {
  const str = String(s || '');
  if (!str) return '';
  if (/^[A-Z][a-z]/.test(str)) {
    return str[0].toLowerCase() + str.slice(1);
  }
  return str;
}

function summarizeToolCall(call) {
  const name = call?.name || 'tool';
  const rawArgs = call?.args || {};
  const args = {};
  for (const [k, v] of Object.entries(rawArgs)) {
    args[k] = unquoteArg(v);
  }

  if (name === 'update_focus') {
    return { skip: true, name, label: String(args.focus || '') };
  }
  if (name === 'enter_plan_mode' || name === 'exit_plan_mode') {
    return { skip: true, name, label: '' };
  }
  if (name === 'update_steps') {
    const stepsRaw = parseMaybeJson(rawArgs.steps);
    if (Array.isArray(stepsRaw) && stepsRaw.length > 0) {
      const stepsList = stepsRaw
        .slice(0, 12)
        .map((s) => ({
          title: String(s?.title || '').trim(),
          status: String(s?.status || 'pending'),
        }))
        .filter((s) => s.title);
      const done = stepsRaw.filter((s) => s?.status === 'done' || s?.status === 'skipped').length;
      const active = stepsRaw.find((s) => s?.status === 'in_progress');
      return {
        skip: true,
        name,
        stepsList: stepsList.length > 0 ? stepsList : null,
        stepsProgress: {
          done,
          total: stepsRaw.length,
          currentTitle: active?.title ? String(active.title) : '',
        },
      };
    }
    return { skip: true, name, label: '' };
  }

  const filePath = args.Path || args.TargetFile || args.AbsolutePath || args.DirectoryPath || '';
  const normPath = filePath ? String(filePath).replace(/\\/g, '/') : '';
  const shortFile = normPath ? basename(normPath) : '';
  const baseUri = normPath
    ? (normPath.startsWith('file://')
        ? normPath
        : `file:///${normPath.replace(/^\/+/, '')}`)
    : '';

  if (/read_file|view_file/.test(name)) {
    const range = args.StartLine ? `:${args.StartLine}-${args.EndLine || ''}` : '';
    const lineRange = args.StartLine
      ? `#L${args.StartLine}${args.EndLine ? `-${args.EndLine}` : ''}`
      : '';
    const fileUri = baseUri
      ? `${baseUri}${args.StartLine ? `#L${args.StartLine}${args.EndLine ? `-L${args.EndLine}` : ''}` : ''}`
      : '';
    const target = `${shortFile || 'file'}${range}`;
    return {
      category: 'read',
      name,
      target,
      shortFile: shortFile || 'file',
      lineRange,
      fileUri,
      label: target,
      detail: String(filePath),
    };
  }
  if (/edit_file|write_file|replace/.test(name)) {
    const target = shortFile || 'file';
    return {
      category: 'edit',
      name,
      target,
      shortFile: shortFile || 'file',
      lineRange: '',
      fileUri: baseUri,
      label: target,
      detail: String(filePath),
    };
  }
  if (/run_command/.test(name)) {
    const target = String(args.toolSummary || args.CommandLine || 'command').slice(0, 88);
    return { category: 'cmd', name, target, label: target, detail: String(args.CommandLine || '') };
  }
  if (/grep|search|find/.test(name)) {
    const target = String(args.query || args.Query || args.Pattern || shortFile || name).slice(0, 68);
    return { category: 'search', name, target, label: target, detail: target };
  }
  if (name === 'call_mcp_tool') {
    const target = String(args.ToolName || args.ServerName || 'MCP');
    return { category: 'mcp', name, target, label: target, detail: JSON.stringify(args.Arguments || {}).slice(0, 200) };
  }
  return { category: 'other', name, target: shortFile || name, label: shortFile || name, detail: shortFile || JSON.stringify(args).slice(0, 160) };
}

function cleanUserContent(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw;

  // Extract <USER_REQUEST> if present
  const reqMatch = s.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (reqMatch) {
    return reqMatch[1].trim();
  }

  // Extract agentapi [Message] content=... if present
  const msgIdx = s.indexOf('[Message]');
  if (msgIdx !== -1 && s.includes('content=')) {
    let body = s.slice(s.indexOf('content=', msgIdx) + 'content='.length);
    body = body.replace(/<\/SYSTEM_MESSAGE>[\s\S]*$/i, '').trim();
    if (body) return body;
  }

  // Strip system wrappers if raw text
  s = s
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .replace(/The following is a <SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/g, '')
    .trim();
  return s;
}

function parseBackgroundTaskMessage(rawContent, cleaned, taskSummaryById) {
  const raw = String(rawContent || '');
  const senderMatch = raw.match(/\[Message\][^\r\n]*?\bsender=([^\s\r\n]+?\/task-\d+)\b/i);
  const bodyMatch = String(cleaned || '').match(/^Task id\s+"([^"]+)"\s+finished with result:\s*([\s\S]*)$/i);
  const stillRunningMatch = !bodyMatch
    ? String(cleaned || '').match(/^Task id\s+"([^"]+)"\s+(is still running[\s\S]*)$/i)
    : null;
  if (!senderMatch && !bodyMatch && !stillRunningMatch) return null;

  const taskId = (bodyMatch?.[1] || stillRunningMatch?.[1] || senderMatch?.[1] || '').trim();
  const rawResult = bodyMatch
    ? bodyMatch[2]
    : stillRunningMatch
      ? stillRunningMatch[2]
      : String(cleaned || '');
  const exitMatch = rawResult.match(/Command exited with code\s+(-?\d+)/i);
  const exitCode = exitMatch ? Number(exitMatch[1]) : 0;

  const output = rawResult
    .replace(/\r\n/g, '\n')
    .replace(/\n*Log:\s*file:\/\/\/[^\s\n]+\s*$/i, '')
    .trim()
    .slice(0, 3000);

  const summary = taskSummaryById.get(taskId) || taskId.split('/').pop() || 'Background task';
  const suffix = stillRunningMatch ? ' running' : ' finished';
  return {
    taskId,
    title: `${summary}${suffix}`,
    exitCode: Number.isFinite(exitCode) ? exitCode : 0,
    output,
  };
}

function splitWorkerAssignment(text) {
  if (!text.startsWith('# Worker Thread Assignment:')) return null;
  const taskHeader = '## Task Instructions';
  const completionHeader = '## Completion & Handback Protocol';
  const taskIdx = text.indexOf(taskHeader);
  if (taskIdx === -1) return null;

  const beforeTask = text.slice(0, taskIdx).trim();
  let taskBody = text.slice(taskIdx + taskHeader.length);
  const compIdx = taskBody.indexOf(completionHeader);
  if (compIdx !== -1) {
    taskBody = taskBody.slice(0, compIdx);
  }
  return {
    taskText: taskBody.trim(),
    contextText: beforeTask,
  };
}

function cleanToolOutput(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/^(Created At|Completed At):[^\r\n]*[\r\n]+/gm, '')
    .replace(/The following is a <SYSTEM_MESSAGE>[\s\S]*$/g, '')
    .trim()
    .slice(0, 900);
}

function extractStepEndIso(step) {
  if (step?.type === 'GENERIC' && typeof step.content === 'string') {
    const m = step.content.match(/^Completed At:\s*([^\r\n]+)/m);
    if (m) {
      const ms = Date.parse(m[1].trim());
      if (Number.isFinite(ms)) return new Date(ms).toISOString();
    }
  }
  return step?.created_at || '';
}

function computeSpanSeconds(startIso, endIso, minSec = 1, maxSec = 86400) {
  const s = Date.parse(startIso || '');
  const e = Date.parse(endIso || '');
  if (!Number.isFinite(s) || !Number.isFinite(e)) return minSec;
  const diff = Math.round((e - s) / 1000);
  if (diff <= 0) return minSec;
  return Math.min(maxSec, Math.max(minSec, diff));
}

export function scanPendingBackgroundTasks(steps, maxAgeMs = 45 * 60 * 1000) {
  if (!Array.isArray(steps) || steps.length === 0) return [];

  const pendingMap = new Map(); // taskId -> { taskId, startedAt, summary }
  const seenGenericStepIndices = new Set();

  const removeMatchingTask = (targetId) => {
    const id = String(targetId || '').trim();
    if (!id) return;
    pendingMap.delete(id);
    for (const existingKey of [...pendingMap.keys()]) {
      if (existingKey.endsWith(`/${id}`) || id.endsWith(`/${existingKey}`)) {
        pendingMap.delete(existingKey);
      }
    }
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== 'object') continue;

    if (step.type === 'PLANNER_RESPONSE') {
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      if (calls.length === 0) continue;

      const genericResults = [];
      let gIdx = i + 1;
      while (
        gIdx < steps.length &&
        steps[gIdx]?.type === 'GENERIC' &&
        genericResults.length < calls.length
      ) {
        genericResults.push(steps[gIdx]);
        gIdx++;
      }

      for (let c = 0; c < calls.length; c++) {
        const call = calls[c];
        if (call?.name === 'manage_task') {
          const action = String(unquoteArg(call?.args?.Action || '')).trim().toLowerCase();
          const killedId = String(unquoteArg(call?.args?.TaskId || '')).trim();
          if (action === 'kill' && killedId) {
            removeMatchingTask(killedId);
          }
        }

        const nextStep = genericResults[c];
        if (nextStep) {
          if (Number.isInteger(nextStep.step_index)) {
            seenGenericStepIndices.add(nextStep.step_index);
          }
          if (typeof nextStep.content === 'string') {
            const bgMatch = nextStep.content.match(
              /Tool is running as a background task with task id:\s*([^\r\n]+)/i,
            );
            if (bgMatch) {
              const taskId = bgMatch[1].trim();
              const info = summarizeToolCall(call);
              const summary = !info.skip && info.target ? String(info.target) : '';
              if (taskId) {
                pendingMap.set(taskId, {
                  taskId,
                  startedAt: nextStep.created_at || step.created_at || '',
                  summary,
                });
              }
            }
          }
        }
      }
      continue;
    }

    if (step.type === 'GENERIC' && typeof step.content === 'string') {
      if (Number.isInteger(step.step_index) && seenGenericStepIndices.has(step.step_index)) {
        continue;
      }
      const bgMatch = step.content.match(
        /Tool is running as a background task with task id:\s*([^\r\n]+)/i,
      );
      if (bgMatch) {
        const taskId = bgMatch[1].trim();
        if (taskId && !pendingMap.has(taskId)) {
          pendingMap.set(taskId, {
            taskId,
            startedAt: step.created_at || '',
            summary: '',
          });
        }
      }
      continue;
    }

    if (step.type === 'SYSTEM_MESSAGE' && typeof step.content === 'string') {
      if (!step.content.includes('[Message]')) continue;
      const cleaned = cleanUserContent(step.content);
      const finishedMatch = cleaned.match(/^Task id\s+"([^"]+)"\s+finished with result:/i);
      if (finishedMatch) {
        removeMatchingTask(finishedMatch[1]);
        continue;
      }
      if (!/\bis still running\b/i.test(cleaned)) {
        const senderMatch = step.content.match(/\[Message\][^\r\n]*?\bsender=([^\s\r\n]+?\/task-\d+)\b/i);
        if (senderMatch) {
          removeMatchingTask(senderMatch[1]);
        }
      }
    }
  }

  const nowMs = Date.now();
  const active = [];
  for (const entry of pendingMap.values()) {
    const startedMs = Date.parse(entry.startedAt || '');
    if (Number.isFinite(startedMs) && maxAgeMs > 0 && nowMs - startedMs > maxAgeMs) {
      continue;
    }
    active.push(entry);
  }
  return active;
}

export function parseThreadTranscript(conversationId, pendingUserMessages = []) {
  const path = getTranscriptPath(conversationId);
  const stamp = path ? combinedFileStamp(path) : '';

  let baseItems = [];
  let activeActivity = '';
  let stepCount = 0;

  if (stamp) {
    const cached = timelineCache.get(conversationId);
    if (cached && cached.stamp === stamp) {
      baseItems = cached.parsed.items;
      activeActivity = cached.parsed.activeActivity;
      stepCount = cached.parsed.stepCount;
    } else {
      const { steps: lines } = loadTranscriptSteps({ conversationId, tailBytes: 0 });
      stepCount = lines.length;
      const items = [];
      const taskSummaryById = new Map();
      const toolEntryByBgTaskId = new Map();
      const pendingBgTaskIds = new Set();

      let openTrace = null;
      let turnStepsCard = null;
      let turnStartIdx = 0;
      let lastStandaloneAssistantInTurn = null;
      let justSawTaskResult = false;
      let pendingStartAnchorIso = '';
      let prevStepIso = '';

      const ensureOpenTrace = (stepIndex, stepCreatedAt) => {
        if (!openTrace) {
          const startedAt = pendingStartAnchorIso || stepCreatedAt || '';
          pendingStartAnchorIso = '';
          openTrace = {
            id: `trace-${stepIndex}`,
            kind: 'trace',
            startedAt,
            endedAt: stepCreatedAt || startedAt,
            durationSec: 1,
            activeHeader: '',
            lastFocus: '',
            entries: [],
            calls: [],
            thinking: '',
            firstPostTaskNote: null,
            lastProgressNote: null,
            createdAt: startedAt || stepCreatedAt || '',
          };
        }
        return openTrace;
      };

      const flushTrace = (reason = 'other') => {
        if (!openTrace) return;
        const trace = openTrace;
        openTrace = null;

        // Determine if a milestone note should be promoted right above this trace
        let promotedNote = null;
        if (trace.firstPostTaskNote) {
          promotedNote = trace.firstPostTaskNote;
        } else if ((reason === 'tail' || reason === 'task_result') && trace.lastProgressNote) {
          promotedNote = trace.lastProgressNote;
        }

        if (promotedNote) {
          trace.entries = trace.entries.filter(
            (e) => !(e.kind === 'note' && e.stepId === promotedNote.id),
          );
          items.push({
            id: promotedNote.id,
            kind: 'assistant',
            text: promotedNote.text,
            isMilestone: true,
            isProgress: false,
            isFinalReply: false,
            showFooter: false,
            model: promotedNote.model || '',
            createdAt: promotedNote.createdAt || '',
          });
        }

        if (trace.entries.length > 0 || trace.calls.length > 0 || trace.thinking) {
          trace.durationSec = computeSpanSeconds(trace.startedAt, trace.endedAt, 1, 86400);
          if (!trace.activeHeader) {
            trace.activeHeader = trace.lastFocus || '';
          }
          delete trace.firstPostTaskNote;
          delete trace.lastProgressNote;
          items.push(trace);
        }
      };

      const finalizeUserTurn = (isEndOfTranscript = false) => {
        flushTrace(isEndOfTranscript ? 'tail' : 'user');
        if (turnStepsCard && Array.isArray(turnStepsCard.steps) && turnStepsCard.steps.length > 0) {
          const lastIdx = items.length - 1;
          if (
            lastIdx >= turnStartIdx &&
            ((items[lastIdx].kind === 'assistant' && !items[lastIdx].isMilestone) ||
              items[lastIdx].kind === 'trace')
          ) {
            items.splice(lastIdx, 0, turnStepsCard);
          } else {
            items.push(turnStepsCard);
          }
        }
        turnStepsCard = null;
        lastStandaloneAssistantInTurn = null;
        justSawTaskResult = false;
      };

      for (let i = 0; i < lines.length; i++) {
        const step = lines[i];
        if (!step || typeof step !== 'object') continue;
        const createdAt = step.created_at || '';

        if (
          step.type === 'USER_INPUT' ||
          (step.type === 'SYSTEM_MESSAGE' && String(step.content || '').includes('[Message]'))
        ) {
          if (/^Error: The stream was interrupted/i.test(step.content || '')) continue;
          const cleaned = cleanUserContent(step.content || '');
          if (
            !cleaned ||
            cleaned.startsWith('[Project Coordinator Standing Protocol') ||
            cleaned.startsWith('[Project Threads Update]')
          ) {
            continue;
          }

          if (cleaned.startsWith('[THREAD_COMPLETION_SYNC]')) {
            finalizeUserTurn(false);
            const tidMatch = cleaned.match(/`(thr-[a-z0-9_-]+)`/i);
            const titleMatch = cleaned.match(/\*\*(?:Task Title|任务标题)\*\*:\s*([^\r\n]+)/i);
            const bannerTitle =
              tidMatch && titleMatch
                ? `[${tidMatch[1]} Completed] ${titleMatch[1].trim()}`
                : tidMatch
                  ? `[${tidMatch[1]} Completed]`
                  : 'Thread completion synced';
            items.push({
              id: `step-${step.step_index}`,
              kind: 'task_result',
              taskId: tidMatch ? tidMatch[1] : '',
              title: bannerTitle,
              exitCode: 0,
              output: cleaned.slice(0, 3000),
              createdAt,
            });
            turnStartIdx = items.length;
            pendingStartAnchorIso = createdAt;
            prevStepIso = createdAt;
            activeActivity = '正在思考…';
            continue;
          }

          // Check if this SYSTEM_MESSAGE [Message] is an async background task completion/notification
          if (step.type === 'SYSTEM_MESSAGE') {
            const bgTask = parseBackgroundTaskMessage(step.content || '', cleaned, taskSummaryById);
            if (bgTask) {
              if (lastStandaloneAssistantInTurn) {
                lastStandaloneAssistantInTurn.showFooter = false;
                lastStandaloneAssistantInTurn.isFinalReply = false;
              }
              if (bgTask.taskId) {
                pendingBgTaskIds.delete(bgTask.taskId);
                const launchedEntry = toolEntryByBgTaskId.get(bgTask.taskId);
                if (launchedEntry) {
                  launchedEntry.running = false;
                  launchedEntry.done = true;
                }
              }
              flushTrace('task_result');
              items.push({
                id: `step-${step.step_index}`,
                kind: 'task_result',
                taskId: bgTask.taskId,
                title: bgTask.title,
                exitCode: bgTask.exitCode,
                output: bgTask.output,
                createdAt,
              });
              justSawTaskResult = true;
              pendingStartAnchorIso = createdAt;
              prevStepIso = createdAt;
              activeActivity = '正在思考…';
              continue;
            }
          }

          // Genuine human / coordinator message starts a new user turn
          finalizeUserTurn(false);

          if (items.length === 0) {
            const assignment = splitWorkerAssignment(cleaned);
            if (assignment) {
              items.push({
                id: `step-${step.step_index}`,
                kind: 'task_brief',
                taskText: assignment.taskText,
                contextText: assignment.contextText,
                createdAt,
              });
              turnStartIdx = items.length;
              pendingStartAnchorIso = createdAt;
              prevStepIso = createdAt;
              continue;
            }
          }

          items.push({
            id: `step-${step.step_index}`,
            kind: 'user',
            text: cleaned,
            createdAt,
          });
          turnStartIdx = items.length;
          pendingStartAnchorIso = createdAt;
          prevStepIso = createdAt;
          activeActivity = '正在思考…';
          continue;
        }

        if (step.type === 'PLANNER_RESPONSE') {
          if (lastStandaloneAssistantInTurn) {
            lastStandaloneAssistantInTurn.showFooter = false;
            lastStandaloneAssistantInTurn.isFinalReply = false;
          }

          const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
          const content = typeof step.content === 'string' ? step.content.trim() : '';
          const thinking = typeof step.thinking === 'string' ? step.thinking.trim() : '';

          if (calls.length > 0) {
            const trace = ensureOpenTrace(step.step_index, createdAt);
            if (createdAt) trace.endedAt = createdAt;

            // Collect consecutive GENERIC result steps immediately following this PLANNER_RESPONSE
            const genericResults = [];
            let gIdx = i + 1;
            while (
              gIdx < lines.length &&
              lines[gIdx]?.type === 'GENERIC' &&
              genericResults.length < calls.length
            ) {
              genericResults.push(lines[gIdx]);
              gIdx++;
            }
            const isAtTranscriptTail = gIdx >= lines.length;

            if (thinking) {
              const firstGenericIso = genericResults[0]?.created_at || '';
              const thoughtSec =
                firstGenericIso && Date.parse(firstGenericIso) > Date.parse(createdAt || '')
                  ? computeSpanSeconds(createdAt, firstGenericIso, 1, 180)
                  : computeSpanSeconds(prevStepIso || createdAt, createdAt, 1, 180);
              trace.entries.push({
                kind: 'thought',
                durationSec: thoughtSec,
                text: thinking.slice(0, 1200),
              });
              if (!trace.thinking) {
                trace.thinking = thinking.slice(0, 400);
              }
            }

            if (content) {
              const noteObj = {
                id: `step-${step.step_index}-note`,
                text: content,
                model: step.model || '',
                createdAt,
              };
              if (justSawTaskResult && !trace.firstPostTaskNote) {
                trace.firstPostTaskNote = noteObj;
              }
              trace.lastProgressNote = noteObj;
              trace.entries.push({
                kind: 'note',
                stepId: noteObj.id,
                text: content,
              });
            }
            justSawTaskResult = false;

            for (let c = 0; c < calls.length; c++) {
              const nextStep = genericResults[c] || null;
              if (nextStep) {
                const gEnd = extractStepEndIso(nextStep);
                if (gEnd) trace.endedAt = gEnd;
              }

              const info = summarizeToolCall(calls[c]);
              if (info.skip) {
                if (calls[c]?.name === 'update_focus' && info.label) {
                  trace.lastFocus = String(info.label);
                  trace.activeHeader = trace.lastFocus;
                  activeActivity = trace.lastFocus;
                } else if (calls[c]?.name === 'update_steps' && info.stepsList) {
                  turnStepsCard = {
                    id: `steps-${step.step_index}`,
                    kind: 'steps_card',
                    steps: info.stepsList,
                    createdAt,
                  };
                }
                continue;
              }

              let bgTaskId = '';
              if (nextStep && typeof nextStep.content === 'string') {
                const bgMatch = nextStep.content.match(
                  /Tool is running as a background task with task id:\s*([^\r\n]+)/i,
                );
                if (bgMatch) {
                  bgTaskId = bgMatch[1].trim();
                  if (bgTaskId && info.target) {
                    taskSummaryById.set(bgTaskId, info.target);
                  }
                  if (bgTaskId) {
                    pendingBgTaskIds.add(bgTaskId);
                  }
                }
              }

              const outputPreview = nextStep ? cleanToolOutput(nextStep.content) : '';
              const isRunning = bgTaskId
                ? true
                : !nextStep
                  ? isAtTranscriptTail
                  : nextStep.status === 'RUNNING' && isAtTranscriptTail;

              const toolEntry = {
                kind: 'tool',
                category: info.category,
                name: info.name,
                rawTarget: info.target,
                target: info.target,
                shortFile: info.shortFile || '',
                lineRange: info.lineRange || '',
                fileUri: info.fileUri || '',
                label: info.label,
                detail: info.detail,
                outputPreview,
                running: isRunning,
                done: !isRunning && Boolean(nextStep),
              };
              if (bgTaskId) {
                toolEntryByBgTaskId.set(bgTaskId, toolEntry);
              }
              trace.entries.push(toolEntry);
              trace.calls.push(toolEntry);

              trace.activeHeader =
                info.category === 'cmd'
                  ? `Running ${lowerFirst(info.target)}`
                  : trace.lastFocus || info.target;
              activeActivity = info.label;
            }

            prevStepIso = trace.endedAt || createdAt || prevStepIso;
          } else {
            // Standalone planner response without tool calls
            justSawTaskResult = false;
            if (thinking) {
              const trace = ensureOpenTrace(step.step_index, createdAt);
              const thoughtSec = computeSpanSeconds(prevStepIso || createdAt, createdAt, 1, 180);
              trace.entries.push({
                kind: 'thought',
                durationSec: thoughtSec,
                text: thinking.slice(0, 1200),
              });
              if (!trace.thinking) {
                trace.thinking = thinking.slice(0, 400);
              }
              if (createdAt) trace.endedAt = createdAt;
            }
            flushTrace('assistant');
            if (content) {
              const hasPendingBgTask = pendingBgTaskIds.size > 0;
              const assistantItem = {
                id: `step-${step.step_index}`,
                kind: 'assistant',
                text: content,
                isMilestone: false,
                isProgress: false,
                isFinalReply: !hasPendingBgTask,
                showFooter: !hasPendingBgTask,
                model: step.model || '',
                createdAt,
              };
              items.push(assistantItem);
              lastStandaloneAssistantInTurn = assistantItem;
              activeActivity = '';
            }
            prevStepIso = createdAt || prevStepIso;
          }
          continue;
        }

        if (step.type === 'GENERIC') {
          const gEnd = extractStepEndIso(step);
          if (openTrace && gEnd) {
            openTrace.endedAt = gEnd;
          }
          if (gEnd) prevStepIso = gEnd;
          continue;
        }

        if (step.type === 'ERROR_MESSAGE') {
          flushTrace('error');
          const errText = cleanToolOutput(step.content || '执行出错');
          if (errText) {
            items.push({
              id: `step-${step.step_index}`,
              kind: 'error',
              text: errText,
              createdAt,
            });
          }
          activeActivity = '';
          if (createdAt) prevStepIso = createdAt;
        }
      }

      finalizeUserTurn(true);

      const parsed = { items, activeActivity, stepCount };
      timelineCache.set(conversationId, { stamp, parsed });
      if (timelineCache.size > 40) {
        timelineCache.delete(timelineCache.keys().next().value);
      }
      baseItems = items;
    }
  }

  // Merge any optimistic pendingUserMessages not yet written into transcript.jsonl
  const merged = [...baseItems];
  if (Array.isArray(pendingUserMessages) && pendingUserMessages.length > 0) {
    const existingUserTexts = new Set(
      baseItems.filter((it) => it.kind === 'user').map((it) => it.text.trim()),
    );
    for (const pm of pendingUserMessages) {
      if (pm?.text && !existingUserTexts.has(pm.text.trim())) {
        merged.push({
          id: pm.id || `pending-${pm.createdAt}`,
          kind: 'user',
          text: pm.text,
          pending: true,
          createdAt: pm.createdAt || '',
        });
      }
    }
  }

  const effectiveStamp = `${stamp}|p:${(pendingUserMessages || []).length}`;
  return {
    stamp: effectiveStamp,
    stepCount,
    activeActivity,
    items: merged,
  };
}

const SUMMARY_SECTION_HEADING_RE =
  /(?:^|\n)(#{2,4}\s*(?:Thread Summary|线程总结|核心结论|排查结论|总结)[^\n]*)/gi;

export const DEFAULT_COORDINATOR_REPORT_MAX_CHARS = 6500;

const REPORT_FOLD_MARKER =
  '\n\n...(中间细节已折叠，如需核查完整末轮报告请调用 `get_thread_detail(threadId, includeFullReport: true)`，勿直接读取原始 `transcript_full.jsonl`；亦可在右侧侧边栏查看)...\n\n';

export function buildCardSummary(fullText) {
  const clean = String(fullText || '').trim();
  if (!clean) return '';
  const summaryMatch = clean.match(/#{2,4}\s*(?:Thread Summary|线程总结|核心结论|排查结论|总结)[^\n]*\n+([\s\S]+)/i);
  const body = summaryMatch ? summaryMatch[1].trim() : clean;
  return body
    .replace(/```[\s\S]*?```/g, '[代码/SQL片段]')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 320);
}

export function buildCoordinatorReport(fullText, maxChars = DEFAULT_COORDINATOR_REPORT_MAX_CHARS) {
  const clean = String(fullText || '').trim();
  if (!clean) return '';
  const limit = Math.max(800, Number(maxChars) || DEFAULT_COORDINATOR_REPORT_MAX_CHARS);
  if (clean.length <= limit) return clean;

  // Prefer keeping the closing `### Thread Summary` (or localized summary heading) section intact
  let lastSummaryStart = -1;
  SUMMARY_SECTION_HEADING_RE.lastIndex = 0;
  let match;
  while ((match = SUMMARY_SECTION_HEADING_RE.exec(clean)) !== null) {
    lastSummaryStart = match.index + (match[0].startsWith('\n') ? 1 : 0);
  }

  if (lastSummaryStart > 0) {
    const beforeSummary = clean.slice(0, lastSummaryStart).trim();
    const summaryBlock = clean.slice(lastSummaryStart).trim();
    if (beforeSummary && summaryBlock) {
      const availableForBefore = limit - REPORT_FOLD_MARKER.length - summaryBlock.length;
      if (availableForBefore >= 400) {
        return `${beforeSummary.slice(0, availableForBefore).trim()}${REPORT_FOLD_MARKER}${summaryBlock}`;
      }
      // Extremely large summary section: keep opening context + preserve as much of summary heading/head/tail as fits
      const beforeCap = Math.min(beforeSummary.length, Math.max(300, Math.floor(limit * 0.2)));
      const summaryBudget = Math.max(300, limit - REPORT_FOLD_MARKER.length - beforeCap);
      let keptSummary = summaryBlock;
      if (summaryBlock.length > summaryBudget) {
        const innerMarker = '\n\n...(总结中段已折叠)...\n\n';
        const sHead = Math.floor((summaryBudget - innerMarker.length) * 0.65);
        const sTail = Math.max(120, summaryBudget - innerMarker.length - sHead);
        keptSummary = `${summaryBlock.slice(0, sHead).trim()}${innerMarker}${summaryBlock.slice(-sTail).trim()}`;
      }
      return `${beforeSummary.slice(0, beforeCap).trim()}${REPORT_FOLD_MARKER}${keptSummary}`;
    }
  }

  const budget = Math.max(400, limit - REPORT_FOLD_MARKER.length);
  const headLen = Math.floor(budget * 0.5);
  const tailLen = Math.max(200, budget - headLen);
  return `${clean.slice(0, headLen).trim()}${REPORT_FOLD_MARKER}${clean.slice(-tailLen).trim()}`;
}

function findLatestStandaloneAssistant(steps) {
  for (let i = steps.length - 1; i >= 0; i--) {
    const entry = steps[i];
    if (entry?.type === 'PLANNER_RESPONSE') {
      const calls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
      const text = typeof entry.content === 'string' ? entry.content.trim() : '';
      if (text && calls.length === 0) {
        const fullReport = buildCoordinatorReport(text);
        return {
          stepIndex: Number.isInteger(entry.step_index) ? entry.step_index : 0,
          cardSummary: buildCardSummary(text),
          fullReport,
          rawFullText: text,
          rawFullTextLength: text.length,
          reportTruncated: text.length > fullReport.length,
        };
      }
    }
  }
  return null;
}

export function extractLatestAssistantText(conversationId, overrideTranscriptPath = '') {
  const { steps } = loadTranscriptSteps({
    conversationId,
    overrideTranscriptPath,
    tailBytes: 160 * 1024,
  });
  let found = findLatestStandaloneAssistant(steps);
  if (!found) {
    const path =
      overrideTranscriptPath && existsSync(overrideTranscriptPath)
        ? overrideTranscriptPath
        : getTranscriptPath(conversationId);
    try {
      if (path && statSync(path).size > 160 * 1024) {
        const full = loadTranscriptSteps({
          conversationId,
          overrideTranscriptPath,
          tailBytes: 0,
        });
        found = findLatestStandaloneAssistant(full.steps);
      }
    } catch {
      // Ignore stat/read errors
    }
  }
  if (found) return found;
  return {
    stepIndex: -1,
    cardSummary: '',
    fullReport: '',
    rawFullText: '',
    rawFullTextLength: 0,
    reportTruncated: false,
  };
}

export function extractThreadCompletion(conversationId, overrideTranscriptPath = '') {
  const { steps } = loadTranscriptSteps({
    conversationId,
    overrideTranscriptPath,
    tailBytes: 160 * 1024,
  });
  const pendingTasks = scanPendingBackgroundTasks(steps);
  if (pendingTasks.length > 0) {
    return {
      stepIndex: -1,
      cardSummary: '',
      fullReport: '',
      rawFullText: '',
      rawFullTextLength: 0,
      reportTruncated: false,
      waitingOnBackgroundTask: true,
      pendingTaskIds: pendingTasks.map((x) => x.taskId),
    };
  }

  const found = findLatestStandaloneAssistant(steps);
  if (found) {
    return {
      ...found,
      waitingOnBackgroundTask: false,
      pendingTaskIds: [],
    };
  }
  return {
    stepIndex: -1,
    cardSummary: '',
    fullReport: '',
    rawFullText: '',
    rawFullTextLength: 0,
    reportTruncated: false,
    waitingOnBackgroundTask: false,
    pendingTaskIds: [],
  };
}

export function peekLiveActivity(conversationId) {
  const path = getTranscriptPath(conversationId);
  const stamp = path ? combinedFileStamp(path) : '';
  if (!stamp) {
    return {
      activeTool: '',
      activeToolObj: null,
      stepsProgress: null,
      stepsList: null,
      toolStepCount: 0,
      hasPendingBgTask: false,
      pendingBgTaskSummary: '',
      needsUserAction: false,
      lastSummary: '',
      lastStepIndex: -1,
    };
  }

  const cached = activityCache.get(conversationId);
  if (cached && cached.stamp === stamp) return cached.activity;

  const { steps } = loadTranscriptSteps({
    conversationId,
    tailBytes: 160 * 1024,
  });
  if (!steps.length) {
    return {
      activeTool: '',
      activeToolObj: null,
      stepsProgress: null,
      stepsList: null,
      toolStepCount: 0,
      hasPendingBgTask: false,
      pendingBgTaskSummary: '',
      needsUserAction: false,
      lastSummary: '',
      lastStepIndex: -1,
    };
  }

  const pendingTasks = scanPendingBackgroundTasks(steps);
  const hasPendingBgTask = pendingTasks.length > 0;
  const pendingBgTaskSummary = hasPendingBgTask
    ? pendingTasks[pendingTasks.length - 1]?.summary || ''
    : '';

  let activeTool = '';
  let activeToolObj = null;
  let stepsProgress = null;
  let stepsList = null;
  let toolStepCount = 0;
  let needsUserAction = false;
  let lastSummary = '';
  let lastStepIndex = -1;
  let passedLatestUser = false;

  for (let i = steps.length - 1; i >= 0; i--) {
    const entry = steps[i];
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'USER_INPUT') {
      passedLatestUser = true;
      if (stepsProgress && (activeTool || lastSummary)) break;
      continue;
    }
    if (entry.type === 'PLANNER_RESPONSE') {
      const calls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
      if (calls.length > 0) {
        for (let c = calls.length - 1; c >= 0; c--) {
          const call = calls[c];
          if (call?.name === 'ask_question' && !passedLatestUser) {
            needsUserAction = true;
          }
          const info = summarizeToolCall(call);
          if (info.stepsProgress && !stepsProgress) {
            stepsProgress = info.stepsProgress;
            stepsList = info.stepsList || null;
          }
          if (!passedLatestUser && !info.skip) {
            toolStepCount++;
          }
          if (!activeTool) {
            if (call?.name === 'update_focus' && info.label) {
              activeTool = String(info.label);
              activeToolObj = { category: 'focus', target: activeTool };
            } else if (!info.skip) {
              activeTool = info.target || info.label;
              activeToolObj = { category: info.category, target: info.target || info.label };
            }
          }
        }
      }
      const text = typeof entry.content === 'string' ? entry.content.trim() : '';
      if (!lastSummary && text && calls.length === 0) {
        lastSummary = buildCardSummary(text);
        lastStepIndex = Number.isInteger(entry.step_index) ? entry.step_index : 0;
        const tailSlice = text.slice(-260);
        if (
          /[?？]\s*$/.test(tailSlice) ||
          /待确认|请确认|需要你确认|是否需要|waiting on you|please confirm|approve|would you like/i.test(tailSlice)
        ) {
          needsUserAction = true;
        }
      }
    }
  }

  if (hasPendingBgTask) {
    if (!activeTool) {
      activeTool = pendingBgTaskSummary
        ? `Running ${pendingBgTaskSummary}`
        : 'Waiting for background task…';
      activeToolObj = {
        category: 'cmd',
        target: pendingBgTaskSummary || 'background task',
      };
    } else if (pendingBgTaskSummary) {
      activeTool = pendingBgTaskSummary;
      activeToolObj = {
        category: 'cmd',
        target: pendingBgTaskSummary,
      };
    }
  }

  const activity = {
    activeTool,
    activeToolObj,
    stepsProgress,
    stepsList,
    toolStepCount,
    hasPendingBgTask,
    pendingBgTaskSummary,
    needsUserAction,
    lastSummary,
    lastStepIndex,
  };
  activityCache.set(conversationId, { stamp, activity });
  if (activityCache.size > 60) {
    activityCache.delete(activityCache.keys().next().value);
  }
  return activity;
}

/**
 * Extracts the latest model selection / planner response slug from parsed transcript steps.
 * Strips `<USER_REQUEST>` bodies before scanning `<USER_SETTINGS_CHANGE>` so quoted prompt text
 * cannot produce false model matches.
 */
export function extractModelFromSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { displayName: '', modelSlug: '' };
  }
  let settingsDisplayName = '';
  let settingsIdx = -1;
  let plannerSlug = '';
  let plannerIdx = -1;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== 'object') continue;
    if (step.type === 'USER_INPUT' && typeof step.content === 'string') {
      const stripped = step.content.replace(/<USER_REQUEST>[\s\S]*?<\/USER_REQUEST>/gi, '');
      const blocks = stripped.match(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi);
      if (blocks) {
        for (const block of blocks) {
          const m = block.match(
            /The user changed setting `Model Selection` from [^\r\n]+? to ([^\r\n]+?)\.(?=\s|$)/i,
          );
          const candidate = m?.[1]?.trim() || '';
          if (candidate && !/^(?:none|unspecified|auto|default)$/i.test(candidate)) {
            settingsDisplayName = candidate;
            settingsIdx = i;
          }
        }
      }
    } else if (step.type === 'PLANNER_RESPONSE' && typeof step.model === 'string') {
      const slug = step.model.trim();
      if (slug) {
        plannerSlug = slug;
        plannerIdx = i;
      }
    }
  }

  let displayName = '';
  if (settingsDisplayName) {
    if (plannerIdx < settingsIdx) {
      displayName = settingsDisplayName;
    } else if (plannerSlug && isSameModelFamily(settingsDisplayName, plannerSlug)) {
      displayName = settingsDisplayName;
    }
  }
  return {
    displayName,
    modelSlug: plannerSlug,
  };
}

/**
 * Reads model metadata from a conversation's transcript.jsonl as an offline fallback when LS
 * trajectory metadata is unavailable.
 */
export function extractTranscriptModel(conversationId, overrideTranscriptPath = '') {
  const path =
    overrideTranscriptPath && existsSync(overrideTranscriptPath)
      ? overrideTranscriptPath
      : getTranscriptPath(conversationId);
  const stamp = path ? combinedFileStamp(path) : '';
  if (!stamp) {
    return { displayName: '', modelSlug: '' };
  }

  const cacheKey = overrideTranscriptPath || conversationId;
  const cached = modelCache.get(cacheKey);
  if (cached && cached.stamp === stamp) return cached.model;

  const { steps } = loadTranscriptSteps({
    conversationId,
    overrideTranscriptPath,
    tailBytes: 160 * 1024,
  });
  let model = extractModelFromSteps(steps);
  if (!model.displayName && !model.modelSlug) {
    try {
      if (statSync(path).size > 160 * 1024) {
        const full = loadTranscriptSteps({
          conversationId,
          overrideTranscriptPath,
          tailBytes: 0,
        });
        model = extractModelFromSteps(full.steps);
      }
    } catch {
      // Ignore stat/read errors
    }
  }

  modelCache.set(cacheKey, { stamp, model });
  if (modelCache.size > 60) {
    modelCache.delete(modelCache.keys().next().value);
  }
  return model;
}

function round1(num) {
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.round(num * 10) / 10;
}

function snapCompactionThreshold(tokens) {
  const n = Number(tokens || 0);
  if (n >= 460000 && n <= 560000) return 512000;
  if (n >= 220000 && n <= 290000) return 256000;
  if (n >= 175000 && n <= 220000) return 200000;
  return n > 0 ? n : 512000;
}

function inferContextThreshold(modelName, rawModelId, lastCompactionBeforeTokens) {
  const before = Number(lastCompactionBeforeTokens || 0);
  if (before > 0) {
    return {
      limitTokens: snapCompactionThreshold(before),
      source: 'observed',
    };
  }
  const combined = `${modelName || ''} ${rawModelId || ''}`.toLowerCase();
  if (/gemini[-_\s]?4|gemini[-_\s]?3|gemini[-_\s]?2\.5|gemini[-_\s]?pro|gemini[-_\s]?flash/.test(combined)) {
    return { limitTokens: 512000, source: 'estimated' };
  }
  if (/claude|sonnet|opus|haiku/.test(combined)) {
    return { limitTokens: 200000, source: 'estimated' };
  }
  if (/gpt[-_\s]?[45]|o[134]/.test(combined)) {
    return { limitTokens: 256000, source: 'estimated' };
  }
  return { limitTokens: 512000, source: 'default' };
}

function inferContextWindowLimit(modelName, rawModelId, compactionLimitTokens) {
  const combined = `${modelName || ''} ${rawModelId || ''}`.toLowerCase();
  if (/gemini[-_\s]?4|gemini[-_\s]?3|gemini[-_\s]?2\.5|gemini[-_\s]?pro|gemini[-_\s]?flash/.test(combined)) {
    return 1000000;
  }
  if (/claude|sonnet|opus|haiku/.test(combined)) {
    return compactionLimitTokens > 220000 ? 1000000 : 200000;
  }
  if (/gpt[-_\s]?[45]|o[134]/.test(combined)) {
    return 256000;
  }
  return Math.max(1000000, Number(compactionLimitTokens || 0));
}

/**
 * Computes compaction count, compaction threshold progress, and cumulative token usage
 * directly from compact `transcript.jsonl` using the exact same accounting formulas as
 * `agy-tps-monitor`. Cached by transcript `mtimeMs:size` for near-zero polling overhead.
 */
export function extractSessionTelemetry(
  conversationId,
  { overrideTranscriptPath = '', modelName = '', rawModelId = '' } = {},
) {
  const path =
    overrideTranscriptPath && existsSync(overrideTranscriptPath)
      ? overrideTranscriptPath
      : getTranscriptPath(conversationId);
  const stamp = path ? fileStamp(path) : '';
  if (!stamp) return null;

  const modelHintKey = `${String(modelName || '').trim()}|${String(rawModelId || '').trim()}`;
  const cacheKey = `${overrideTranscriptPath || conversationId}|${modelHintKey}`;
  const cached = telemetryCache.get(cacheKey);
  if (cached && cached.stamp === stamp) {
    return cached.telemetry;
  }

  let rawText = '';
  try {
    rawText = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let currentContextTokens = 0;
  let peakContextTokens = 0;
  let compactionCount = 0;
  let lastCompactionBeforeTokens = 0;
  let pendingCompaction = false;
  let detectedModelName = String(modelName || '').trim();
  let detectedRawModelId = String(rawModelId || '').trim();

  const lines = rawText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let s;
    try {
      s = JSON.parse(line);
    } catch {
      continue;
    }
    if (!s || typeof s !== 'object') continue;

    if (s.type === 'USER_INPUT' && typeof s.content === 'string') {
      const m = /`Model Selection` from [^\n]+? to ([^\n.]+?)\./.exec(s.content);
      if (m && m[1]) detectedModelName = m[1].trim();
      continue;
    }

    if (typeof s.model === 'string' && s.model.trim()) {
      detectedRawModelId = s.model.trim();
      if (!detectedModelName) detectedModelName = detectedRawModelId;
    }

    if (s.type === 'CHECKPOINT') {
      const cIn = Number(s.input_tokens || 0);
      const cCache = Number(s.cache_read_tokens || 0);
      const cOut = Number(s.output_tokens || 0);
      const cPrompt = cIn + cCache;
      totalInputTokens += cIn;
      totalCacheReadTokens += cCache;
      totalOutputTokens += cOut;

      const beforeCtx = Math.max(cPrompt, currentContextTokens || 0);
      if (beforeCtx > 0) {
        lastCompactionBeforeTokens = beforeCtx;
        if (beforeCtx > peakContextTokens) peakContextTokens = beforeCtx;
      }
      compactionCount += 1;
      pendingCompaction = true;
      continue;
    }

    if (s.type === 'PLANNER_RESPONSE') {
      const inTok = Number(s.input_tokens || 0);
      const cacheTok = Number(s.cache_read_tokens || 0);
      const outTok = Number(s.output_tokens || 0);
      totalInputTokens += inTok;
      totalCacheReadTokens += cacheTok;
      totalOutputTokens += outTok;

      const stepCtx = inTok + cacheTok;
      if (stepCtx > 0) {
        if (pendingCompaction) pendingCompaction = false;
        currentContextTokens = stepCtx;
        if (stepCtx > peakContextTokens) peakContextTokens = stepCtx;
      }
    }
  }

  const totalTokens = totalInputTokens + totalCacheReadTokens + totalOutputTokens;
  const justCompacted = Boolean(pendingCompaction);
  const activeContextTokens = justCompacted ? 0 : currentContextTokens;
  const threshold = inferContextThreshold(
    detectedModelName,
    detectedRawModelId,
    lastCompactionBeforeTokens,
  );
  const windowLimitTokens = inferContextWindowLimit(
    detectedModelName,
    detectedRawModelId,
    threshold.limitTokens,
  );
  const compactionUsagePct =
    threshold.limitTokens > 0 && activeContextTokens > 0
      ? round1((activeContextTokens / threshold.limitTokens) * 100)
      : 0;

  const telemetry = {
    totalTokens,
    totalInputTokens,
    totalCacheReadTokens,
    totalOutputTokens,
    currentContextTokens: activeContextTokens,
    peakContextTokens,
    compactionThresholdTokens: threshold.limitTokens,
    compactionThresholdSource: threshold.source,
    compactionUsagePct,
    windowLimitTokens,
    compactionCount,
    justCompacted,
  };

  telemetryCache.set(cacheKey, { stamp, telemetry });
  if (telemetryCache.size > 120) {
    telemetryCache.delete(telemetryCache.keys().next().value);
  }
  return telemetry;
}
