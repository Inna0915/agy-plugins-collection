import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildCodexInvokeArgs,
  extractCodexTelemetry,
  formatCodexErrorBanner,
  formatCodexHandoffMarkdown,
  readCodexConfigDefaults,
} from '../lib/codex-adapter.mjs';
import {
  archiveThread,
  dispatchThread,
  getModelSelectorState,
  getThreadDetail,
  getThreadMessages,
  loadRegistry,
  saveRegistry,
  sendThreadMessage,
  syncThreads,
} from '../lib/store.mjs';

function writeMockAgentApi(dir, name, jsBody) {
  const jsPath = join(dir, `${name}.mjs`);
  writeFileSync(jsPath, jsBody, 'utf8');
  if (process.platform === 'win32') {
    const cmdPath = join(dir, `${name}.cmd`);
    writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${jsPath}" %*\r\n`, 'utf8');
    return cmdPath;
  }
  const shPath = join(dir, name);
  writeFileSync(shPath, `#!/bin/sh\nexec "${process.execPath}" "${jsPath}" "$@"\n`, 'utf8');
  chmodSync(shPath, 0o755);
  return shPath;
}

async function waitFor(predicate, timeoutMs = 15000, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await predicate();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

test('buildCodexInvokeArgs enforces read-only review/plan locks, config.toml inheritance, and clean session resume', (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pt-codex-args-'));
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempRoot;
  t.after(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  writeFileSync(
    join(tempRoot, 'config.toml'),
    [
      'model = "gpt-6.2-astra"',
      'model_reasoning_effort = "xhigh"',
      'service_tier = "priority"',
      'model_context_window = 400000',
      'model_auto_compact_token_limit = 340000',
      '',
      '[features]',
      'hooks = true',
    ].join('\n'),
    'utf8',
  );

  const cfg = readCodexConfigDefaults();
  assert.equal(cfg.model, 'gpt-6.2-astra');
  assert.equal(cfg.effort, 'xhigh');
  assert.equal(cfg.serviceTier, 'priority');
  assert.equal(cfg.contextWindow, 400000);
  assert.equal(cfg.autoCompactTokenLimit, 340000);

  // 1. review taskKind hard-locks read-only + WorktreeMode off, omits -Model/-Effort when default
  const reviewArgs = buildCodexInvokeArgs({
    invokeScript: 'C:/scripts/Invoke-CodexTask.ps1',
    projectDir: 'D:/repo',
    codexTask: 'codex-thr-001',
    promptFile: 'C:/tmp/p.md',
    taskKind: 'review',
    model: 'default',
    effort: '',
    fast: true,
    structuredHandoff: true,
    createWorktree: true,
    skipGitRepoCheck: true,
  });
  assert.ok(reviewArgs.includes('-TaskKind'));
  assert.equal(reviewArgs[reviewArgs.indexOf('-TaskKind') + 1], 'review');
  assert.equal(reviewArgs[reviewArgs.indexOf('-Mode') + 1], 'read-only');
  assert.equal(reviewArgs[reviewArgs.indexOf('-WorktreeMode') + 1], 'off');
  assert.ok(!reviewArgs.includes('-Model'));
  assert.ok(!reviewArgs.includes('-Effort'));
  assert.ok(reviewArgs.includes('-Fast'));
  assert.ok(reviewArgs.includes('-StructuredHandoff'));
  assert.ok(reviewArgs.includes('-SkipGitRepoCheck'));

  // 2. implement taskKind with createWorktree=false passes -NoWorktree and explicit model/effort
  const implArgs = buildCodexInvokeArgs({
    invokeScript: 'C:/scripts/Invoke-CodexTask.ps1',
    projectDir: 'D:/repo',
    codexTask: 'codex-thr-002',
    promptFile: 'C:/tmp/p2.md',
    taskKind: 'implement',
    model: 'gpt-6.2-astra',
    effort: 'high',
    createWorktree: false,
  });
  assert.equal(implArgs[implArgs.indexOf('-Mode') + 1], 'yolo');
  assert.ok(implArgs.includes('-NoWorktree'));
  assert.equal(implArgs[implArgs.indexOf('-Model') + 1], 'gpt-6.2-astra');
  assert.equal(implArgs[implArgs.indexOf('-Effort') + 1], 'high');

  // 3. Resume with SessionId omits -TaskKind/-Mode/-Model/-Effort to avoid permission drift
  const resumeArgs = buildCodexInvokeArgs({
    invokeScript: 'C:/scripts/Invoke-CodexTask.ps1',
    projectDir: 'D:/repo',
    codexTask: 'codex-thr-002',
    promptFile: 'C:/tmp/p3.md',
    taskKind: 'implement',
    model: 'gpt-6.2-astra',
    sessionId: '01a21738-c3d4-73b2-b15f-4a0dfbcf0e63',
  });
  assert.ok(resumeArgs.includes('-SessionId'));
  assert.ok(!resumeArgs.includes('-TaskKind'));
  assert.ok(!resumeArgs.includes('-Mode'));
  assert.ok(!resumeArgs.includes('-Model'));
});

test('extractCodexTelemetry accurately accounts for OpenAI cached input tokens, compactions, and events fallback', (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pt-codex-tel-'));
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempRoot;
  t.after(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  writeFileSync(
    join(tempRoot, 'config.toml'),
    'model_context_window = 400000\nmodel_auto_compact_token_limit = 340000\n',
    'utf8',
  );

  // 1. Rollout JSONL with token_count + compacted
  const rolloutPath = join(tempRoot, 'rollout-test.jsonl');
  const rolloutLines = [
    JSON.stringify({ type: 'session_meta', payload: { id: 'test-1' } }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 350000, cached_input_tokens: 200000, output_tokens: 5000, total_tokens: 355000 },
          last_token_usage: { input_tokens: 335000, cached_input_tokens: 200000, output_tokens: 1000, total_tokens: 336000 },
          model_context_window: 380000,
        },
      },
    }),
    JSON.stringify({
      type: 'compacted',
      payload: {
        window_number: 1,
        latest_token_usage_record: { last_token_usage: { input_tokens: 335000 } },
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 450000, cached_input_tokens: 300000, output_tokens: 7500, total_tokens: 457500 },
          last_token_usage: { input_tokens: 85000, cached_input_tokens: 60000, output_tokens: 500, total_tokens: 85500 },
          model_context_window: 380000,
        },
      },
    }),
  ];
  writeFileSync(rolloutPath, `${rolloutLines.join('\n')}\n`, 'utf8');

  const tel = extractCodexTelemetry({
    threadId: 'thr-cx-1',
    codex: { nativeSession: rolloutPath, runs: [] },
  });
  assert.equal(tel.totalTokens, 457500);
  assert.equal(tel.totalCacheReadTokens, 300000);
  assert.equal(tel.totalInputTokens, 150000); // 450000 - 300000 uncached
  assert.equal(tel.totalOutputTokens, 7500);
  assert.equal(tel.currentContextTokens, 85000);
  assert.equal(tel.compactionCount, 1);
  assert.equal(tel.compactionThresholdTokens, 340000);
  assert.equal(tel.windowLimitTokens, 380000);
  assert.equal(tel.compactionUsagePct, 25);

  // 2. Fallback to events.jsonl turn.completed when nativeSession is missing
  const evPath = join(tempRoot, 'r1.events.jsonl');
  writeFileSync(
    evPath,
    `${JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 20000, cached_input_tokens: 12000, output_tokens: 400 },
    })}\n`,
    'utf8',
  );
  const fallbackTel = extractCodexTelemetry({
    threadId: 'thr-cx-2',
    codex: { nativeSession: '', runs: [{ eventsFile: evPath }] },
  });
  assert.equal(fallbackTel.totalTokens, 20400);
  assert.equal(fallbackTel.totalCacheReadTokens, 12000);
  assert.equal(fallbackTel.totalInputTokens, 8000);
  assert.equal(fallbackTel.totalOutputTokens, 400);
});

test('formatCodexHandoffMarkdown and formatCodexErrorBanner produce readable summary and error hints', () => {
  const md = formatCodexHandoffMarkdown({
    status: 'needs_input',
    summary: 'Found 1 blocking issue in lock release.',
    root_cause: 'Lock released outside transaction.',
    changed_files: [],
    verification: [{ command: 'git diff --check', exit_code: 0, result: 'clean' }],
    open_questions: ['Should we keep legacy fallback?'],
  });
  assert.match(md, /Handoff Status.*needs_input/);
  assert.match(md, /Found 1 blocking issue/);
  assert.match(md, /### Thread Summary/);

  assert.match(formatCodexErrorBanner({ errorKind: 'active_writer', error: 'busy' }), /Codex Desktop/);
  assert.match(formatCodexErrorBanner({ errorKind: 'capacity', error: '503' }), /满载/);
  assert.match(formatCodexErrorBanner({ state: 'timeout', exitCode: 124 }), /超时/);
});

test('end-to-end Codex thread lifecycle: dispatch, live events, auto callback, full report, resume, and archive cleanup', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pt-codex-e2e-'));
  const geminiDir = join(tempRoot, '.gemini');
  const appDataDir = join(geminiDir, 'antigravity');
  const stateDir = join(appDataDir, 'project-threads');
  const projectDir = join(tempRoot, 'demo-project');
  const mockScriptsDir = join(tempRoot, 'codex-scripts');
  const mockWtDir = join(tempRoot, 'demo-wt');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(mockScriptsDir, { recursive: true });
  mkdirSync(mockWtDir, { recursive: true });

  const envKeys = [
    'ANTIGRAVITY_GEMINI_DIR',
    'ANTIGRAVITY_APP_DATA_DIR',
    'ANTIGRAVITY_LS_ADDRESS',
    'ANTIGRAVITY_CSRF_TOKEN',
    'ANTIGRAVITY_AGENTAPI_EXE',
    'PROJECT_THREADS_CODEX_SCRIPTS_DIR',
    'PROJECT_THREADS_PWSH_EXE',
    'CODEX_HOME',
  ];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

  const sendLogPath = join(tempRoot, 'coord-sends.jsonl');
  const removeLogPath = join(tempRoot, 'remove-wt.log');
  const mockAgentApi = writeMockAgentApi(
    tempRoot,
    'mock-agentapi',
    `import { appendFileSync } from 'node:fs';
     appendFileSync(${JSON.stringify(sendLogPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');
     process.stdout.write(JSON.stringify({ response: { sendMessage: { ok: true } } }));`,
  );

  // Mock Invoke-CodexTask.ps1 & Remove-TaskWorktree.ps1 executed by a tiny Node shim posing as pwshExe!
  // Using process.execPath directly is fast, cross-platform, and deterministic in unit tests.
  writeFileSync(join(mockScriptsDir, 'Invoke-CodexTask.ps1'), '# mock invoke\n', 'utf8');
  writeFileSync(join(mockScriptsDir, 'Remove-TaskWorktree.ps1'), '# mock remove\n', 'utf8');

  const fakePwshShim = writeMockAgentApi(
    tempRoot,
    'fake-pwsh',
    `import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
     import { join, basename } from 'node:path';

     const args = process.argv.slice(2);
     const getArg = (flag) => {
       const idx = args.indexOf(flag);
       return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : '';
     };
     const scriptFile = getArg('-File');
     const project = getArg('-Project');
     const task = getArg('-Task');

     if (basename(scriptFile) === 'Remove-TaskWorktree.ps1') {
       appendFileSync(${JSON.stringify(removeLogPath)}, JSON.stringify(args) + '\\n');
       if (existsSync(${JSON.stringify(mockWtDir)})) rmSync(${JSON.stringify(mockWtDir)}, { recursive: true, force: true });
       process.exit(0);
     }

     const sessionIn = getArg('-SessionId');
     const promptFile = getArg('-PromptFile');
     const promptText = promptFile && existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : '';
     const logDir = join(project, 'work', 'alpha', 'logs', task);
     mkdirSync(logDir, { recursive: true });
     const roundTag = sessionIn ? 'r2' : 'r1';
     const runId = 'codex-mock-' + roundTag + '-' + Date.now();
     const statusFile = join(logDir, runId + '.status.json');
     const eventsFile = join(logDir, runId + '.events.jsonl');
     const finalFile = join(logDir, runId + '.final.md');
     const sessionId = sessionIn || '01a21738-c3d4-73b2-b15f-4a0dfbcf0e63';
     const desktopUrl = 'codex://threads/' + sessionId;

     const writeStatus = (obj) => writeFileSync(statusFile, JSON.stringify(obj, null, 2), 'utf8');
     writeStatus({
       runId,
       task,
       taskKind: sessionIn ? 'implement' : (getArg('-TaskKind') || 'implement'),
       cwd: ${JSON.stringify(mockWtDir)},
       sourceProject: project,
       state: 'running',
       runnerPid: process.pid,
       events: eventsFile,
       final: finalFile,
       startedAt: new Date().toISOString(),
     });

     process.stderr.write('WORKER_STARTUP ' + JSON.stringify({
       worker: 'codex',
       task,
       runId,
       runnerPid: process.pid,
       statusFile,
       eventsFile,
       cwd: ${JSON.stringify(mockWtDir)},
       worktreeUsed: true,
     }) + '\\n');
     process.stderr.write('CODEX_DESKTOP_URL=' + desktopUrl + '\\n');

     writeFileSync(eventsFile, [
       JSON.stringify({ type: 'thread.started', thread_id: sessionId }),
       JSON.stringify({ type: 'turn.started' }),
       JSON.stringify({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'git status --short', aggregated_output: 'M App.java\\n', exit_code: 0, status: 'completed' } }),
       JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call', server: 'node_repl', tool: 'js', arguments: { code: '1+1' }, result: '2', status: 'completed' } }),
       JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12000, cached_input_tokens: 8000, output_tokens: 350 } }),
     ].join('\\n') + '\\n', 'utf8');

     const finalBody = sessionIn
       ? 'Follow-up round 2 applied for: ' + promptText.trim() + '\\n\\n### Thread Summary\\n- Round 2 completed.'
       : 'Verified project memory present: ' + String(promptText.includes('SHARED_MEMORY_TOKEN_XYZ')) + '\\n\\n### Thread Summary\\n- Round 1 completed cleanly.';
     writeFileSync(finalFile, finalBody, 'utf8');

     setTimeout(() => {
       writeStatus({
         runId,
         task,
         taskKind: sessionIn ? 'implement' : (getArg('-TaskKind') || 'implement'),
         cwd: ${JSON.stringify(mockWtDir)},
         sourceProject: project,
         worktree: {
           used: true,
           topology: 'single-repo',
           effectiveProject: ${JSON.stringify(mockWtDir)},
           worktreeRoot: ${JSON.stringify(mockWtDir)},
           branch: 'worker/' + task,
           repos: [],
         },
         appliedSettings: { model: 'gpt-6.2-astra', effort: 'xhigh', serviceTier: 'priority' },
         sessionId,
         desktopUrl,
         runnerPid: process.pid,
         startedAt: new Date(Date.now() - 200).toISOString(),
         finishedAt: new Date().toISOString(),
         state: 'finished',
         exitCode: 0,
         errorKind: null,
         error: null,
         events: eventsFile,
         final: finalFile,
       });
       process.exit(0);
     }, 180);`,
  );

  process.env.ANTIGRAVITY_GEMINI_DIR = geminiDir;
  process.env.ANTIGRAVITY_APP_DATA_DIR = appDataDir;
  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:59997';
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf';
  process.env.ANTIGRAVITY_AGENTAPI_EXE = mockAgentApi;
  process.env.PROJECT_THREADS_CODEX_SCRIPTS_DIR = mockScriptsDir;
  process.env.PROJECT_THREADS_PWSH_EXE = fakePwshShim;
  process.env.CODEX_HOME = tempRoot;

  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  // Seed coordinator and shared project memory
  const memDir = join(projectDir, '.agents', 'rules');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, 'project-memory.md'), '# Memory\n- SHARED_MEMORY_TOKEN_XYZ\n', 'utf8');

  const coordConvId = 'conv-coord-codex-01';
  const reg0 = loadRegistry();
  const normKey = process.platform === 'win32' ? projectDir.toLowerCase() : projectDir;
  reg0.coordinators[normKey] = {
    key: normKey,
    conversationId: coordConvId,
    workspacePath: projectDir,
    title: '[Coordinator] Demo',
  };
  saveRegistry(reg0);

  // 1. getModelSelectorState reports codex available
  const selState = await getModelSelectorState({ workspacePath: projectDir, coordinatorId: coordConvId });
  assert.equal(selState.codex.available, true);

  // 2. Dispatch Codex thread
  const spawned = await dispatchThread({
    engine: 'codex',
    taskKind: 'implement',
    workspacePath: projectDir,
    coordinatorId: coordConvId,
    title: 'Fix order lock',
    taskPrompt: 'Inspect lock handling and patch cleanly.',
    fast: true,
    createWorktree: true,
  });
  assert.equal(spawned.engine, 'codex');
  assert.equal(spawned.runState, 'RUN_STATE_RUNNING');
  assert.equal(spawned.conversationId, '');

  // 3. Wait for detached runner to finish & push callback to Coordinator
  const finishedThread = await waitFor(async () => {
    const snap = await syncThreads({ workspacePath: projectDir, includeArchived: true });
    const found = snap.threads.find((x) => x.threadId === spawned.threadId);
    return found && found.runState === 'RUN_STATE_IDLE' && found.lastSyncedStepIndex === 1 ? found : null;
  }, 15000);
  assert.ok(finishedThread, 'Codex thread should finish and auto-sync round 1 to Coordinator');
  assert.equal(finishedThread.codex.sessionId, '01a21738-c3d4-73b2-b15f-4a0dfbcf0e63');
  assert.equal(finishedThread.codex.desktopUrl, 'codex://threads/01a21738-c3d4-73b2-b15f-4a0dfbcf0e63');
  assert.equal(finishedThread.modelDisplayName, 'gpt-6.2-astra (xhigh · fast)');
  assert.equal(finishedThread.worktreePath, mockWtDir);
  assert.ok(finishedThread.telemetry && finishedThread.telemetry.totalTokens === 12350);

  // Verify Coordinator callback actually arrived via agentapi with inherited memory proof
  assert.ok(existsSync(sendLogPath));
  const sends1 = readFileSync(sendLogPath, 'utf8').trim().split(/\r?\n/);
  assert.equal(sends1.length, 1);
  assert.match(sends1[0], /THREAD_COMPLETION_SYNC/);
  assert.match(sends1[0], /codex:\/\/threads\/01a21738-c3d4-73b2-b15f-4a0dfbcf0e63/);

  // 4. getThreadDetail(includeFullReport: true) returns full untruncated report
  const detail = await getThreadDetail({ threadId: spawned.threadId, includeFullReport: true, skipSync: true });
  assert.match(detail.fullReport, /Verified project memory present: true/);
  assert.match(detail.fullReport, /Round 1 completed cleanly/);

  // 5. getThreadMessages returns task_brief, trace (cmd + mcp), and assistant reply
  const msgs = await getThreadMessages({ threadId: spawned.threadId, markRead: true });
  assert.equal(msgs.ok, true);
  assert.ok(msgs.items.some((it) => it.kind === 'task_brief'));
  const traceItem = msgs.items.find((it) => it.kind === 'trace');
  assert.ok(traceItem && traceItem.calls.length === 2);
  assert.equal(traceItem.calls[0].category, 'cmd');
  assert.equal(traceItem.calls[1].category, 'mcp');
  assert.ok(msgs.items.some((it) => it.kind === 'assistant' && it.text.includes('Round 1 completed cleanly')));

  // 6. Send follow-up via sendThreadMessage -> triggers round 2 resume with SessionId
  const sendRes = await sendThreadMessage({
    threadId: spawned.threadId,
    message: 'Please also verify edge case #2.',
  });
  assert.equal(sendRes.ok, true);
  assert.equal(sendRes.thread.codex.runs.length, 2);

  // While round 2 is running, concurrent sendThreadMessage must be blocked
  await assert.rejects(
    () => sendThreadMessage({ threadId: spawned.threadId, message: 'Concurrent message' }),
    /still running/,
  );

  const round2Done = await waitFor(async () => {
    const snap = await syncThreads({ workspacePath: projectDir, includeArchived: true });
    const found = snap.threads.find((x) => x.threadId === spawned.threadId);
    return found && found.runState === 'RUN_STATE_IDLE' && found.lastSyncedStepIndex === 2 ? found : null;
  }, 15000);
  assert.ok(round2Done, 'Round 2 follow-up should complete and auto-sync');

  const msgs2 = await getThreadMessages({ threadId: spawned.threadId });
  assert.ok(msgs2.items.some((it) => it.kind === 'user' && it.text.includes('edge case #2')));
  assert.ok(msgs2.items.some((it) => it.kind === 'assistant' && it.text.includes('Round 2 completed')));

  // 7. Archive delegates worktree removal to Remove-TaskWorktree.ps1
  const archRes = await archiveThread(spawned.threadId, { removeWorktree: true, deleteBranch: true });
  assert.equal(archRes.ok, true);
  assert.equal(archRes.archived, true);
  assert.equal(archRes.worktreeRemoved, true);
  assert.equal(archRes.branchDeleted, true);
  assert.equal(existsSync(mockWtDir), false);
  assert.ok(existsSync(removeLogPath));
  assert.match(readFileSync(removeLogPath, 'utf8'), /-DeleteBranch/);

  // 8. MCP tools/list exposes multi-engine dispatch schema
  const mcpPath = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url));
  const rpcRes = spawnSync(process.execPath, [mcpPath], {
    env: { ...process.env, ANTIGRAVITY_LS_ADDRESS: '', ANTIGRAVITY_CSRF_TOKEN: '' },
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(rpcRes.status, 0);
  const tools = JSON.parse(rpcRes.stdout.trim()).result.tools;
  const dispatchTool = tools.find((x) => x.name === 'dispatch_thread');
  assert.deepEqual(dispatchTool.inputSchema.properties.engine.enum, ['antigravity', 'codex']);
  assert.deepEqual(dispatchTool.inputSchema.properties.taskKind.enum, ['implement', 'review', 'plan']);
});
