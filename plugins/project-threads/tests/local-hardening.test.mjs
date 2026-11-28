import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildModelConfigLookup,
  resolveConcreteModelIdFromLookup,
} from '../lib/ls-client.mjs';
import {
  buildCoordinatorReport,
  DEFAULT_COORDINATOR_REPORT_MAX_CHARS,
  extractSessionTelemetry,
  extractThreadCompletion,
  parseThreadTranscript,
  peekLiveActivity,
  scanPendingBackgroundTasks,
} from '../lib/transcript.mjs';
import {
  dispatchThread,
  getDefaultThreadModel,
  getModelSelectorState,
  getThreadDetail,
  initCoordinator,
  inspectWorktreeGit,
  invalidateWorktreeGitCache,
  loadRegistry,
  resolveConversationConcreteModel,
  saveRegistry,
} from '../lib/store.mjs';

const require = createRequire(import.meta.url);

test('edit-integrity-guard blocks IDE editor tools inside sibling .worktrees while keeping temp/scratch allowed', () => {
  const guardPath = fileURLToPath(new URL('../../edit-integrity-guard/hooks/guard.js', import.meta.url));
  const guard = require(guardPath);

  const ctx = {
    hookEventName: 'PreToolUse',
    cwd: 'D:\\dev\\demo-repo',
    workspacePaths: ['D:\\dev\\demo-repo'],
    artifactDirectoryPath: 'C:\\Users\\OMEN\\.gemini\\antigravity\\brain\\conv-test',
  };

  // Sibling Git worktree must be treated as workspace file and denied for edit_file/write_file
  const wtFile = 'D:\\dev\\.worktrees\\demo-repo\\thr-001-fix\\src\\App.java';
  assert.equal(guard.isWorkspaceFile(wtFile, ctx), true);
  const denyRes = guard.evaluateHook('pre', {
    ...ctx,
    toolCall: { name: 'edit_file', args: { Path: wtFile } },
  });
  assert.equal(denyRes.decision, 'deny');

  // Temp worktrees (like unit tests) and .gemini/scratch must stay excluded/allowed
  const tempWtFile = join(tmpdir(), 'pt-test', '.worktrees', 'repo', 'thr-001', 'README.md');
  assert.equal(guard.isWorkspaceFile(tempWtFile, ctx), false);
  const allowTemp = guard.evaluateHook('pre', {
    ...ctx,
    toolCall: { name: 'write_file', args: { Path: tempWtFile } },
  });
  assert.equal(allowTemp.decision, 'allow');

  const scratchFile = 'C:\\Users\\OMEN\\.gemini\\antigravity\\brain\\conv-test\\scratch\\ops.json';
  assert.equal(guard.isWorkspaceFile(scratchFile, ctx), false);
});

test('initCoordinator auto-excludes main repo .agents/rules/project-memory.md and inspectWorktreeGit honors TTL cache', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pt-harden-'));
  const geminiDir = join(tempRoot, '.gemini');
  const appDataDir = join(geminiDir, 'antigravity');
  mkdirSync(join(appDataDir, 'project-threads'), { recursive: true });

  const envKeys = [
    'ANTIGRAVITY_GEMINI_DIR',
    'ANTIGRAVITY_APP_DATA_DIR',
    'ANTIGRAVITY_LS_ADDRESS',
    'ANTIGRAVITY_CSRF_TOKEN',
  ];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  process.env.ANTIGRAVITY_GEMINI_DIR = geminiDir;
  process.env.ANTIGRAVITY_APP_DATA_DIR = appDataDir;
  delete process.env.ANTIGRAVITY_LS_ADDRESS;
  delete process.env.ANTIGRAVITY_CSRF_TOKEN;

  const repoRoot = join(tempRoot, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'README.md'), '# Repo\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot });

  t.after(() => {
    invalidateWorktreeGitCache();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  await initCoordinator({
    workspacePath: repoRoot,
    conversationId: 'conv-coord-harden-01',
  });

  // 1. Main repo .agents/rules/project-memory.md must be created and ignored via .git/info/exclude
  assert.equal(existsSync(join(repoRoot, '.agents', 'rules', 'project-memory.md')), true);
  const excludeText = readFileSync(join(repoRoot, '.git', 'info', 'exclude'), 'utf8');
  assert.match(excludeText, /\.agents\/rules\/project-memory\.md/);
  const statusOut = execFileSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  assert.equal(statusOut, '', 'main repo git status must remain clean after initCoordinator');

  // 2. inspectWorktreeGit respects maxAgeMs TTL cache and refreshes on force: true
  const first = await inspectWorktreeGit(repoRoot, 'main', { maxAgeMs: 20_000 });
  assert.equal(first.dirtyCount, 0);

  writeFileSync(join(repoRoot, 'dirty.txt'), 'changed\n', 'utf8');
  const cached = await inspectWorktreeGit(repoRoot, 'main', { maxAgeMs: 20_000 });
  assert.equal(cached.dirtyCount, 0, 'within TTL window should return cached git snapshot');

  const forced = await inspectWorktreeGit(repoRoot, 'main', { maxAgeMs: 20_000, force: true });
  assert.equal(forced.dirtyCount, 1, 'force: true should bypass cache and observe dirty file');
});

test('PreInvocation hook reminds Worker Thread of worktree isolation once after /compact without repeating', (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pt-worker-compact-'));
  const geminiDir = join(tempRoot, '.gemini');
  const appDataDir = join(geminiDir, 'antigravity');
  mkdirSync(join(appDataDir, 'project-threads'), { recursive: true });

  const envKeys = ['ANTIGRAVITY_GEMINI_DIR', 'ANTIGRAVITY_APP_DATA_DIR'];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  process.env.ANTIGRAVITY_GEMINI_DIR = geminiDir;
  process.env.ANTIGRAVITY_APP_DATA_DIR = appDataDir;

  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const workerConvId = 'conv-worker-compact-01';
  const reg = loadRegistry();
  reg.threads['thr-099'] = {
    threadId: 'thr-099',
    conversationId: workerConvId,
    workspaceKey: 'd:\\dev\\demo',
    repoRoot: 'D:\\dev\\demo',
    worktreePath: 'D:\\dev\\.worktrees\\demo\\thr-099-fix',
    branch: 'thread/thr-099-fix',
    archived: false,
    lastStepCount: 40,
  };
  saveRegistry(reg);

  const handlerPath = fileURLToPath(new URL('../scripts/hook-handler.mjs', import.meta.url));
  const hookEnv = {
    ...process.env,
    ANTIGRAVITY_GEMINI_DIR: geminiDir,
    ANTIGRAVITY_APP_DATA_DIR: appDataDir,
  };

  // Step drops from 40 -> 3 (/compact occurred): must inject isolation reminder once
  const res1 = spawnSync(process.execPath, [handlerPath, 'PreInvocation'], {
    env: hookEnv,
    input: JSON.stringify({
      hookEventName: 'PreInvocation',
      conversationId: workerConvId,
      initialNumSteps: 3,
    }),
    encoding: 'utf8',
  });
  assert.equal(res1.status, 0);
  const out1 = JSON.parse(res1.stdout.trim());
  assert.equal(Array.isArray(out1.injectSteps), true);
  assert.match(out1.injectSteps[0].systemMessage.systemMessage, /thr-099-fix/);
  assert.match(out1.injectSteps[0].systemMessage.systemMessage, /agy-fs\.mjs/);

  // Next turn (step 5 >= 3): must NOT re-inject
  const res2 = spawnSync(process.execPath, [handlerPath, 'PreInvocation'], {
    env: hookEnv,
    input: JSON.stringify({
      hookEventName: 'PreInvocation',
      conversationId: workerConvId,
      initialNumSteps: 5,
    }),
    encoding: 'utf8',
  });
  assert.equal(res2.status, 0);
  const out2 = JSON.parse(res2.stdout.trim());
  assert.equal(out2.injectSteps, undefined);
});

test('dispatchThread inherits coordinator concrete model via modelEnum and falls back to gemini-4-neon-xhigh', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pt-model-inherit-'));
  const geminiDir = join(tempRoot, '.gemini');
  const appDataDir = join(geminiDir, 'antigravity');
  mkdirSync(join(appDataDir, 'project-threads'), { recursive: true });

  const envKeys = [
    'ANTIGRAVITY_GEMINI_DIR',
    'ANTIGRAVITY_APP_DATA_DIR',
    'ANTIGRAVITY_LS_ADDRESS',
    'ANTIGRAVITY_CSRF_TOKEN',
    'PROJECT_THREADS_DEFAULT_MODEL',
  ];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

  const createdPayloads = [];
  let genMetaByConv = {};

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData') {
        res.end(
          JSON.stringify({
            clientModelConfigs: [
              {
                label: 'Gemini 4 Neon (XHigh)',
                modelId: 'gemini-4-neon-xhigh',
                modelOrAlias: { model: 'MODEL_PLACEHOLDER_M535' },
              },
              {
                label: 'Claude Opus 5.5 (High)',
                modelId: 'claude-opus-5-5-high',
                modelOrAlias: { model: 'MODEL_PLACEHOLDER_M402' },
              },
              {
                label: 'Disabled Model',
                modelId: 'disabled-model-x',
                modelOrAlias: { model: 'MODEL_PLACEHOLDER_M999' },
                disabled: true,
              },
            ],
          }),
        );
        return;
      }
      if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata') {
        res.end(JSON.stringify({ generatorMetadata: genMetaByConv[payload.cascadeId] || [] }));
        return;
      }
      if (req.url === '/product.v1.ConversationService/GetConversation') {
        res.end(JSON.stringify({ conversation: { id: payload.conversationId, metadata: {}, state: {} } }));
        return;
      }
      if (req.url === '/product.v1.ConversationService/CreateConversation') {
        createdPayloads.push(payload);
        res.end(
          JSON.stringify({
            conversation: {
              id: `conv-created-${createdPayloads.length}`,
              state: { runState: 'RUN_STATE_RUNNING' },
            },
          }),
        );
        return;
      }
      if (req.url === '/product.v1.ConversationService/UpdateConversation') {
        res.end(JSON.stringify({ conversation: { id: payload.conversationId } }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  process.env.ANTIGRAVITY_GEMINI_DIR = geminiDir;
  process.env.ANTIGRAVITY_APP_DATA_DIR = appDataDir;
  process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${port}`;
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf';
  delete process.env.PROJECT_THREADS_DEFAULT_MODEL;

  t.after(async () => {
    await new Promise((r) => server.close(r));
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  assert.equal(getDefaultThreadModel(), 'gemini-4-neon-xhigh');

  // 1. Lookup preserves effort suffix via modelEnum even when responseModel omits `-xhigh`
  const lookup = buildModelConfigLookup({
    clientModelConfigs: [
      {
        label: 'Gemini 4 Neon (XHigh)',
        modelId: 'gemini-4-neon-xhigh',
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M535' },
      },
    ],
  });
  assert.equal(
    resolveConcreteModelIdFromLookup(
      { modelEnum: 'MODEL_PLACEHOLDER_M535', responseModel: 'gemini-4-neon', displayName: 'Gemini 4 Neon (XHigh)' },
      lookup,
    ),
    'gemini-4-neon-xhigh',
  );

  const coordConvId = 'conv-coord-model-01';
  const reg = loadRegistry();
  reg.coordinators['conv:conv-coord-model-01'] = {
    key: 'conv:conv-coord-model-01',
    conversationId: coordConvId,
    workspacePath: '',
    title: '[Coordinator] Model Test',
  };
  saveRegistry(reg);

  // 2. When Coordinator uses Claude Opus 5.5 (High), inherit resolves exact concrete modelId
  genMetaByConv[coordConvId] = [
    {
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M402',
        responseModel: 'claude-opus-5-5',
        modelDisplayName: 'Claude Opus 5.5 (High)',
      },
    },
  ];
  const resolvedCoord = await resolveConversationConcreteModel(coordConvId);
  assert.deepEqual(resolvedCoord, {
    id: 'claude-opus-5-5-high',
    label: 'Claude Opus 5.5 (High)',
  });

  const t1 = await dispatchThread({
    coordinatorId: coordConvId,
    title: 'Inherit coord model',
    taskPrompt: 'Check logic',
    createWorktree: false,
  });
  assert.equal(t1.model, 'claude-opus-5-5-high');
  assert.equal(createdPayloads[0].model, 'claude-opus-5-5-high');

  // 3. When Coordinator has no generator metadata yet, fallback is gemini-4-neon-xhigh
  genMetaByConv[coordConvId] = [];
  const t2 = await dispatchThread({
    coordinatorId: coordConvId,
    title: 'Fallback to neon xhigh',
    taskPrompt: 'Check fallback',
    createWorktree: false,
  });
  assert.equal(t2.model, 'gemini-4-neon-xhigh');
  assert.equal(t2.modelDisplayName, 'Gemini 4 Neon (XHigh)');
  assert.equal(createdPayloads[1].model, 'gemini-4-neon-xhigh');

  // 4. getModelSelectorState excludes disabled models and exposes defaultModel
  const selectorState = await getModelSelectorState({ coordinatorId: coordConvId });
  assert.equal(selectorState.defaultModel, 'gemini-4-neon-xhigh');
  assert.equal(selectorState.defaultModelLabel, 'Gemini 4 Neon (XHigh)');
  assert.deepEqual(
    selectorState.models.map((m) => m.id),
    ['gemini-4-neon-xhigh', 'claude-opus-5-5-high'],
  );
});

test('extractSessionTelemetry matches agy-tps-monitor accounting for totalTokens, compaction line, and compaction count', (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pt-tel-'));
  const txPath = join(tempRoot, 'transcript.jsonl');
  t.after(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  // Case 1: Gemini session with 1 CHECKPOINT (observed ~500k -> snaps to 512k) + post-compaction step
  const steps = [
    {
      step_index: 0,
      type: 'USER_INPUT',
      content: '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 4 Neon (XHigh).\n</USER_SETTINGS_CHANGE>',
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      model: 'gemini-4-neon-xhigh',
      input_tokens: 120000,
      cache_read_tokens: 380000,
      output_tokens: 4000,
    },
    {
      step_index: 2,
      type: 'CHECKPOINT',
      content: 'Resuming from a compaction...',
      input_tokens: 10000,
      cache_read_tokens: 495000,
      output_tokens: 3000,
    },
    {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      model: 'gemini-4-neon-xhigh',
      input_tokens: 25000,
      cache_read_tokens: 75000,
      output_tokens: 2000,
    },
  ];
  writeFileSync(txPath, `${steps.map((s) => JSON.stringify(s)).join('\n')}\n`, 'utf8');

  const tel = extractSessionTelemetry('conv-tel-1', { overrideTranscriptPath: txPath });
  assert.equal(tel.compactionCount, 1);
  assert.equal(tel.justCompacted, false);
  assert.equal(tel.compactionThresholdTokens, 512000);
  assert.equal(tel.compactionThresholdSource, 'observed');
  assert.equal(tel.currentContextTokens, 100000);
  assert.equal(tel.compactionUsagePct, 19.5);
  assert.equal(
    tel.totalTokens,
    (120000 + 380000 + 4000) + (10000 + 495000 + 3000) + (25000 + 75000 + 2000),
  );

  // Case 2: Claude model without compaction uses 200K estimated compaction threshold
  const claudeTx = join(tempRoot, 'claude.jsonl');
  writeFileSync(
    claudeTx,
    `${JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      model: 'claude-opus-5-5-high',
      input_tokens: 50000,
      cache_read_tokens: 100000,
      output_tokens: 2500,
    })}\n`,
    'utf8',
  );
  const claudeTel = extractSessionTelemetry('conv-tel-2', { overrideTranscriptPath: claudeTx });
  assert.equal(claudeTel.compactionCount, 0);
  assert.equal(claudeTel.compactionThresholdTokens, 200000);
  assert.equal(claudeTel.compactionThresholdSource, 'estimated');
  assert.equal(claudeTel.currentContextTokens, 150000);
  assert.equal(claudeTel.compactionUsagePct, 75);
  assert.equal(claudeTel.totalTokens, 152500);
});

test('buildCoordinatorReport raises cap to 6500 and preserves ### Thread Summary intact when folding long bodies', () => {
  assert.equal(DEFAULT_COORDINATOR_REPORT_MAX_CHARS, 6500);

  // 1. Report between old 4200 and new 6500 passes through untruncated
  const medium = `${'A'.repeat(5800)}\n\n### Thread Summary\n- All 5800 chars kept.`;
  assert.equal(buildCoordinatorReport(medium), medium);

  // 2. Long report (>6500) preserves 100% of ### Thread Summary and folds only the preceding body
  const summarySection = [
    '### Thread Summary',
    '- **Root Cause**: Exact detail #1 that must never be folded away.',
    '- **Modified Files**: `src/a.java`, `src/b.java`',
    `- **Checklist**: ${'KEY-ITEM '.repeat(120).trim()}`,
    '- **Tail Marker**: SUMMARY_END_TOKEN_999',
  ].join('\n');
  const longBody = `## Detailed Audit\nSTART_TOKEN_111\n${'Verbose finding line.\n'.repeat(450)}`;
  const combined = `${longBody}\n${summarySection}`;
  assert.ok(combined.length > 10000);

  const folded = buildCoordinatorReport(combined);
  assert.ok(folded.includes('START_TOKEN_111'), 'keeps opening context');
  assert.ok(folded.includes(summarySection), 'preserves entire ### Thread Summary verbatim');
  assert.ok(folded.includes('SUMMARY_END_TOKEN_999'), 'preserves summary ending');
  assert.ok(
    folded.includes('get_thread_detail(threadId, includeFullReport: true)'),
    'hints Coordinator to use get_thread_detail instead of reading raw transcript_full.jsonl',
  );
  assert.ok(folded.length <= DEFAULT_COORDINATOR_REPORT_MAX_CHARS + 60);

  // 3. Report without summary heading falls back to head + tail cleanly
  const noSummary = `HEAD_MARKER ${'X'.repeat(9000)} TAIL_MARKER`;
  const fallbackFolded = buildCoordinatorReport(noSummary);
  assert.ok(fallbackFolded.includes('HEAD_MARKER'));
  assert.ok(fallbackFolded.includes('TAIL_MARKER'));
  assert.ok(fallbackFolded.includes('get_thread_detail(threadId, includeFullReport: true)'));
  assert.ok(fallbackFolded.length <= DEFAULT_COORDINATOR_REPORT_MAX_CHARS + 60);

  // 4. Oversized summary (>6500 by itself) still caps output cleanly
  const hugeSummary = `Intro context.\n\n### Thread Summary\nS_HEAD ${'Z'.repeat(8500)} S_TAIL`;
  const cappedHuge = buildCoordinatorReport(hugeSummary);
  assert.ok(cappedHuge.includes('### Thread Summary'));
  assert.ok(cappedHuge.includes('S_HEAD'));
  assert.ok(cappedHuge.includes('S_TAIL'));
  assert.ok(cappedHuge.length <= DEFAULT_COORDINATOR_REPORT_MAX_CHARS + 80);
});

test('getThreadDetail supports includeFullReport=true with transcript_full hydration and maxReportChars clipping', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pt-detail-'));
  const geminiDir = join(tempRoot, '.gemini');
  const appDataDir = join(geminiDir, 'antigravity');
  mkdirSync(join(appDataDir, 'project-threads'), { recursive: true });

  const envKeys = ['ANTIGRAVITY_GEMINI_DIR', 'ANTIGRAVITY_APP_DATA_DIR'];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  process.env.ANTIGRAVITY_GEMINI_DIR = geminiDir;
  process.env.ANTIGRAVITY_APP_DATA_DIR = appDataDir;

  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const workerConvId = 'conv-worker-fullreport-01';
  const txDir = join(appDataDir, 'brain', workerConvId, '.system_generated', 'logs');
  mkdirSync(txDir, { recursive: true });

  const fullAssistantText = `## Full Investigation\n${'Detail row 12345.\n'.repeat(550)}\n### Thread Summary\nFINAL_VERIFIED_FACT`;
  assert.ok(fullAssistantText.length > 9000);

  const compactSteps = [
    { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Investigate</USER_REQUEST>' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      thinking: 'SECRET_THINKING_NOISE_SHOULD_NOT_APPEAR',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'git status' } }],
    },
    {
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      thinking: 'MORE_THINKING_NOISE',
      content: `${fullAssistantText.slice(0, 1000)} <truncated 8500 chars>`,
      truncated_fields: ['content'],
    },
  ];
  const fullSteps = [
    compactSteps[0],
    compactSteps[1],
    {
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      thinking: 'MORE_THINKING_NOISE',
      content: fullAssistantText,
    },
  ];
  writeFileSync(join(txDir, 'transcript.jsonl'), `${compactSteps.map((s) => JSON.stringify(s)).join('\n')}\n`, 'utf8');
  writeFileSync(join(txDir, 'transcript_full.jsonl'), `${fullSteps.map((s) => JSON.stringify(s)).join('\n')}\n`, 'utf8');

  const reg = loadRegistry();
  reg.threads['thr-077'] = {
    threadId: 'thr-077',
    conversationId: workerConvId,
    workspaceKey: '__test__',
    title: 'Deep audit',
    model: 'gemini-4-neon-xhigh',
    runState: 'RUN_STATE_IDLE',
    archived: false,
    lastSummary: 'Short card summary',
    createdAt: '2026-11-27T01:00:00Z',
    updatedAt: '2026-11-27T01:00:00Z',
  };
  saveRegistry(reg);

  // 1. Default includeFullReport=false keeps response compact
  const metaOnly = await getThreadDetail({ threadId: 'thr-077', skipSync: true });
  assert.equal(metaOnly.threadId, 'thr-077');
  assert.equal(metaOnly.fullReport, undefined);

  // 2. includeFullReport=true hydrates untruncated reply without thinking/tool noise
  const withFull = await getThreadDetail({ threadId: 'thr-077', includeFullReport: true, skipSync: true });
  assert.equal(withFull.fullReport, fullAssistantText);
  assert.equal(withFull.fullReportStepIndex, 2);
  assert.equal(withFull.fullReportLength, fullAssistantText.length);
  assert.equal(withFull.fullReportTruncated, false);
  assert.ok(!withFull.fullReport.includes('SECRET_THINKING_NOISE'));
  assert.ok(!withFull.fullReport.includes('MORE_THINKING_NOISE'));

  // 3. maxReportChars clips cleanly when explicitly bounded
  const clipped = await getThreadDetail({
    threadId: 'thr-077',
    includeFullReport: true,
    maxReportChars: 1500,
    skipSync: true,
  });
  assert.equal(clipped.fullReportTruncated, true);
  assert.equal(clipped.fullReportLength, fullAssistantText.length);
  assert.ok(clipped.fullReport.includes('maxReportChars=1500'));

  // 4. MCP stdio server exposes includeFullReport and returns unescaped markdown report
  const mcpPath = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url));
  const rpcInput = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_thread_detail', arguments: { threadId: 'thr-077', includeFullReport: true } },
    }),
  ].join('\n') + '\n';
  const rpcRes = spawnSync(process.execPath, [mcpPath], {
    env: {
      ...process.env,
      ANTIGRAVITY_GEMINI_DIR: geminiDir,
      ANTIGRAVITY_APP_DATA_DIR: appDataDir,
      ANTIGRAVITY_LS_ADDRESS: '',
      ANTIGRAVITY_CSRF_TOKEN: '',
    },
    input: rpcInput,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(rpcRes.status, 0);
  const rpcMsgs = rpcRes.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
  const detailTool = rpcMsgs[0].result.tools.find((x) => x.name === 'get_thread_detail');
  assert.ok(detailTool.inputSchema.properties.includeFullReport);
  assert.ok(detailTool.inputSchema.properties.maxReportChars);
  const callResult = rpcMsgs[1].result;
  assert.equal(callResult.isError, undefined);
  assert.ok(callResult.content[0].text.includes('FINAL_VERIFIED_FACT'));
  assert.equal(callResult.structuredContent.fullReport, fullAssistantText);
});

test('scanPendingBackgroundTasks and parseThreadTranscript ignore IsDaemon tasks and clear pending tasks on server restart', (t) => {
  const nowIso = new Date().toISOString();
  const convId = 'conv-daemon-test-001';

  // 1. IsDaemon=true (stringified & boolean) on run_command / schedule must not block completion
  const daemonSteps = [
    { step_index: 0, type: 'USER_INPUT', created_at: nowIso, content: '<USER_REQUEST>Start daemon and verify</USER_REQUEST>' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: nowIso,
      tool_calls: [
        {
          name: 'run_command',
          args: {
            CommandLine: '"sb run d:/repo --port 30030"',
            IsDaemon: 'true',
            WaitMsBeforeAsync: '500',
            toolSummary: '"Start fms269 Spring Boot daemon"',
          },
        },
        {
          name: 'schedule',
          args: {
            CronExpression: '"*/10 * * * *"',
            IsDaemon: true,
            Prompt: '"Standing check"',
          },
        },
      ],
    },
    {
      step_index: 2,
      type: 'GENERIC',
      status: 'RUNNING',
      created_at: nowIso,
      content: `Tool is running as a background task with task id: ${convId}/task-2`,
    },
    {
      step_index: 3,
      type: 'GENERIC',
      status: 'RUNNING',
      created_at: nowIso,
      content: `Tool is running as a background task with task id: ${convId}/task-3`,
    },
    {
      step_index: 4,
      type: 'PLANNER_RESPONSE',
      created_at: nowIso,
      content: 'Service started and verified.\n\n### Thread Summary\nAll checks passed.',
    },
  ];
  assert.deepEqual(scanPendingBackgroundTasks(daemonSteps), []);

  // 2. Non-daemon background task stays pending until finished or server restart notice
  const nonDaemonSteps = [
    { step_index: 0, type: 'USER_INPUT', created_at: nowIso, content: '<USER_REQUEST>Run build</USER_REQUEST>' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: nowIso,
      tool_calls: [
        {
          name: 'run_command',
          args: {
            CommandLine: '"mvn test"',
            WaitMsBeforeAsync: '5000',
            toolSummary: '"Run maven test"',
          },
        },
      ],
    },
    {
      step_index: 2,
      type: 'GENERIC',
      status: 'RUNNING',
      created_at: nowIso,
      content: `Tool is running as a background task with task id: ${convId}/task-10`,
    },
  ];
  const pendingBefore = scanPendingBackgroundTasks(nonDaemonSteps);
  assert.equal(pendingBefore.length, 1);
  assert.equal(pendingBefore[0].taskId, `${convId}/task-10`);

  const afterRestartSteps = [
    ...nonDaemonSteps,
    {
      step_index: 3,
      type: 'SYSTEM_MESSAGE',
      created_at: nowIso,
      content:
        'The following is a <SYSTEM_MESSAGE>\n<SYSTEM_MESSAGE>\n[Message] sender=system content=[Notice] All your subagents and background tasks have been stopped due to server restart.\n</SYSTEM_MESSAGE>',
    },
    {
      step_index: 4,
      type: 'PLANNER_RESPONSE',
      created_at: nowIso,
      content: 'Recovered after restart.',
    },
  ];
  assert.deepEqual(scanPendingBackgroundTasks(afterRestartSteps), []);

  // 3. End-to-end transcript file checks for extractThreadCompletion, peekLiveActivity, and parseThreadTranscript
  const tempRoot = mkdtempSync(join(tmpdir(), 'pt-daemon-tx-'));
  const prevAppData = process.env.ANTIGRAVITY_APP_DATA_DIR;
  process.env.ANTIGRAVITY_APP_DATA_DIR = tempRoot;
  t.after(() => {
    if (prevAppData === undefined) delete process.env.ANTIGRAVITY_APP_DATA_DIR;
    else process.env.ANTIGRAVITY_APP_DATA_DIR = prevAppData;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const txDir = join(tempRoot, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(txDir, { recursive: true });
  const txPath = join(txDir, 'transcript.jsonl');
  writeFileSync(txPath, `${daemonSteps.map((s) => JSON.stringify(s)).join('\n')}\n`, 'utf8');

  const liveAct = peekLiveActivity(convId);
  assert.equal(liveAct.hasPendingBgTask, false);
  assert.equal(liveAct.lastStepIndex, 4);

  const comp = extractThreadCompletion(convId);
  assert.equal(comp.waitingOnBackgroundTask, false);
  assert.equal(comp.stepIndex, 4);
  assert.ok(comp.fullReport.includes('All checks passed.'));

  const parsed = parseThreadTranscript(convId);
  const traceItem = parsed.items.find((x) => x.kind === 'trace');
  assert.ok(traceItem);
  assert.equal(traceItem.calls[0].running, false);
  assert.equal(traceItem.calls[0].done, true);
  const finalAssistant = parsed.items.find((x) => x.kind === 'assistant');
  assert.ok(finalAssistant);
  assert.equal(finalAssistant.isFinalReply, true);
  assert.equal(finalAssistant.showFooter, true);

  // Also verify server-restart notice hides itself from user bubbles and clears running state
  const convRestart = 'conv-restart-test-002';
  const txDir2 = join(tempRoot, 'brain', convRestart, '.system_generated', 'logs');
  mkdirSync(txDir2, { recursive: true });
  writeFileSync(
    join(txDir2, 'transcript.jsonl'),
    `${afterRestartSteps.map((s) => JSON.stringify(s)).join('\n')}\n`,
    'utf8',
  );
  const parsedRestart = parseThreadTranscript(convRestart);
  assert.equal(parsedRestart.items.filter((x) => x.kind === 'user').length, 1);
  const restartFinal = parsedRestart.items.find((x) => x.kind === 'assistant');
  assert.ok(restartFinal && restartFinal.isFinalReply === true);
});

test('local-hardening static checks: default model inherits/neon-xhigh, dynamic model dropdown, agy-fs guidance, 10s poll, LF endings intact', () => {
  const lsSrc = readFileSync(new URL('../lib/ls-client.mjs', import.meta.url), 'utf8');
  const txSrc = readFileSync(new URL('../lib/transcript.mjs', import.meta.url), 'utf8');
  const storeSrc = readFileSync(new URL('../lib/store.mjs', import.meta.url), 'utf8');
  const serverSrc = readFileSync(new URL('../mcp/server.mjs', import.meta.url), 'utf8');
  const hookSrc = readFileSync(new URL('../scripts/hook-handler.mjs', import.meta.url), 'utf8');
  const mainSrc = readFileSync(new URL('../sidecars/threads/main.mjs', import.meta.url), 'utf8');
  const sidecarJson = readFileSync(new URL('../sidecars/threads/sidecar.json', import.meta.url), 'utf8');
  const htmlSrc = readFileSync(new URL('../sidecars/threads/index.html', import.meta.url), 'utf8');
  const appSrc = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');

  assert.match(lsSrc, /export async function listAvailableModels/);
  assert.match(txSrc, /export function extractSessionTelemetry/);
  assert.match(txSrc, /DEFAULT_COORDINATOR_REPORT_MAX_CHARS\s*=\s*6500/);
  assert.match(storeSrc, /model\s*=\s*'inherit'/);
  assert.match(storeSrc, /'gemini-4-neon-xhigh'/);
  assert.match(storeSrc, /const finalLocale = detected \|\| 'zh-CN'/);
  assert.match(storeSrc, /export async function getThreadDetail/);
  assert.match(storeSrc, /agy-fs\.mjs/);
  assert.match(serverSrc, /Defaults to "inherit"\./);
  assert.match(serverSrc, /includeFullReport/);
  assert.match(serverSrc, /enum:\s*\['antigravity',\s*'codex'\]/);
  assert.match(hookSrc, /DIRECTIVE_VERSION\s*=\s*10/);
  assert.match(mainSrc, /'\/api\/models'/);
  assert.match(mainSrc, /'\/api\/thread_open_external'/);
  assert.match(mainSrc, /},\s*10000\);/);
  assert.match(sidecarJson, /"display_name":\s*"项目线程"/);
  assert.match(htmlSrc, /<html lang="zh-CN">/);
  assert.match(htmlSrc, /value="gemini-4-neon-xhigh" selected/);
  assert.match(htmlSrc, /id="goal-metrics"/);
  assert.match(htmlSrc, /id="f-engine-seg"/);
  assert.match(appSrc, /let curLocale = 'zh-CN';/);
  assert.match(appSrc, /applyLocale\('zh-CN'\);/);
  assert.match(appSrc, /\/api\/models/);
  assert.match(appSrc, /\/api\/thread_open_external/);
  assert.match(appSrc, /renderTelemetryStripInnerHtml/);
  assert.match(appSrc, /renderEngineBadgeHtml/);
  assert.match(appSrc, /const shouldOpen = openTraceIds\.has\(it\.id\);/);

  for (const rel of [
    '../lib/ls-client.mjs',
    '../lib/transcript.mjs',
    '../lib/codex-adapter.mjs',
    '../lib/store.mjs',
    '../mcp/server.mjs',
    '../scripts/hook-handler.mjs',
    '../scripts/codex-thread-runner.mjs',
    '../sidecars/threads/main.mjs',
    './local-hardening.test.mjs',
    './codex-engine.test.mjs',
  ]) {
    const raw = readFileSync(new URL(rel, import.meta.url));
    assert.ok(!raw.includes(Buffer.from('\r')), `${rel} must keep LF line endings`);
  }
});
