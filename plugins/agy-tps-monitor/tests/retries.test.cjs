'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = fs.mkdtempSync(path.join(process.cwd(), '.agy-test-'));
process.env.AGY_TPS_HOME = root;
const telemetry = require('../lib/telemetry.cjs');
const base = Date.parse('2026-11-16T00:00:00Z');
const iso = (ms) => new Date(base + ms).toISOString();

test.after(() => {
  const target = path.resolve(root);
  const parent = path.resolve(process.cwd()) + path.sep;
  if (!target.startsWith(parent) || !path.basename(target).startsWith('.agy-test-')) throw new Error('Unsafe test cleanup');
  fs.rmSync(target, { recursive: true, force: true });
});

function clock(ms, fn) {
  const original = Date.now;
  Date.now = () => base + ms;
  try { return fn(); } finally { Date.now = original; }
}
function fixture(id) {
  const file = path.join(root, '.gemini/antigravity/brain', id, '.system_generated/logs/transcript.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entries = [{ step_index: 0, type: 'USER_INPUT', content: 'test', created_at: iso(0) }];
  function save() { fs.writeFileSync(file, entries.map((x) => JSON.stringify(x)).join('\n') + '\n'); }
  save();
  return { id, file, entries, save,
    sync(ms, opts = {}) { save(); return clock(ms, () => telemetry.syncSessionFromTranscript(id, { transcriptPath: file, ...opts })); },
    detail(ms) { return clock(ms, () => telemetry.getSessionDetail(id)); },
  };
}
const error = (index, attempt, ms) => ({ step_index: index, type: 'ERROR_MESSAGE', status: 'DONE', created_at: iso(ms), error: 'API error (attempt ' + attempt + '): request failed: stream idle timeout (5m0s): context deadline exceeded' });
const planner = (index, ms, content = 'progress', tools = []) => ({ step_index: index, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(ms), content, tool_calls: tools, output_tokens: 1000, input_tokens: 2000, cache_read_tokens: 3000 });
let activeDetail;
let completeDetail;

test('active errors hydrate without hook completion, never become idle, and reads do not write state', () => {
  const f = fixture('aaaaaaaa-0001');
  f.sync(1000, { status: 'generating', activeStartMs: base + 1000 });
  f.entries.push(error(1, 1, 301000)); f.save();
  const before = fs.readFileSync(telemetry.getSessionFile(f.id), 'utf8');
  const detail = f.detail(302000);
  assert.equal(detail.healthState, 'retrying');
  assert.equal(detail.activeRetryCount, 1);
  assert.equal(detail.activeRetryWaitMs, 300000);
  assert.equal(detail.activeStepElapsedMs, 301000);
  assert.equal(f.detail(900000).status, 'generating');
  assert.equal(f.detail(900000).longWait, true);
  assert.equal(fs.readFileSync(telemetry.getSessionFile(f.id), 'utf8'), before);
  // An internal retry invoking the hook again must not reset the logical start.
  f.sync(305000, { status: 'generating', activeStartMs: base + 305000 });
  assert.equal(f.detail(306000).activeStartMs, base + 1000);
  f.entries.push(error(2, 2, 605000), error(3, 3, 912000)); f.save();
  activeDetail = f.detail(924000);
  assert.equal(activeDetail.activeRetryCount, 3);
  assert.equal(activeDetail.activeRetryWaitMs, 911000);
  assert.equal(activeDetail.turnRetryCount, 3);
  assert.equal(f.detail(925000).turnRetryCount, 3);
  f.entries.push(planner(4, 925000));
  f.sync(1226000, { status: 'idle', llmStartMs: base + 1000, llmEndMs: base + 1226000, activeStartMs: null });
  completeDetail = f.detail(1227000);
  const step = completeDetail.steps.at(-1);
  assert.equal(step.durationMs, 301000);
  assert.equal(step.logicalDurationMs, 1225000);
  assert.equal(step.retryWaitMs, 924000);
  assert.equal(step.retryCount, 3);
  assert.equal(step.logicalDurationIsLowerBound, false);
  assert.equal(completeDetail.healthState, 'idle');
  assert.equal(completeDetail.totalRequestMs, 1225000);
  assert.equal(completeDetail.turnFirstTextStepMs, 1226000);
  assert.equal(completeDetail.turnVisibleTtfrMs, null);
});

test('six-minute quiet period warns without an error and Stop is the completion signal', () => {
  const f = fixture('aaaaaaaa-0002');
  f.sync(1000, { status: 'generating', activeStartMs: base + 1000 });
  assert.equal(f.detail(400000).healthState, 'stalled');
  assert.equal(f.detail(400000).status, 'generating');
  f.sync(401000, { status: 'idle', activeStartMs: null });
  assert.equal(f.detail(402000).healthState, 'idle');
});

test('historical retries reconstruct a labelled lower bound and deduplicate repeated errors', () => {
  const f = fixture('aaaaaaaa-0003');
  f.entries.push(error(1, 1, 301000), error(2, 2, 605000), error(2, 2, 605000), planner(3, 612000)); f.save();
  telemetry.writeJsonAtomic(telemetry.getSessionFile(f.id), { conversationId: f.id, status: 'idle', transcriptPath: f.file, stepTimings: { 3: { t1Ms: base + 612000, t4Ms: base + 650000, durationMs: 38000, precise: true } } });
  const detail = f.detail(651000);
  assert.equal(detail.steps[0].retryCount, 2);
  assert.equal(detail.steps[0].logicalDurationMs, 649000);
  assert.equal(detail.steps[0].retryWaitMs, 611000);
  assert.equal(detail.steps[0].logicalDurationIsLowerBound, true);
});

test('failed or interrupted turns do not leak retries into the next user turn', () => {
  const f = fixture('aaaaaaaa-0004');
  f.sync(1000, { status: 'generating', activeStartMs: base + 1000 });
  f.entries.push(error(1, 1, 301000));
  f.sync(302000, { status: 'idle', activeStartMs: null });
  assert.equal(f.detail(303000).healthState, 'error');
  f.entries.push({ step_index: 2, type: 'USER_INPUT', content: 'next', created_at: iso(400000) });
  f.sync(401000, { status: 'generating', activeStartMs: base + 401000 });
  assert.equal(f.detail(402000).turnRetryCount, 0);
  assert.equal(f.detail(402000).totalRetryCount, 1);
  f.entries.push(planner(3, 401000));
  f.sync(410000, { status: 'idle', llmStartMs: base + 401000, llmEndMs: base + 410000, activeStartMs: null });
  assert.equal(f.detail(411000).steps.at(-1).retryCount, 0);
});

test('first text stays frozen across later retry steps, and tool-only content is not first text', () => {
  const f = fixture('aaaaaaaa-0005');
  f.entries.push(planner(1, 1000, '', [{ name: 'read_file' }]));
  f.sync(5000, { status: 'tool_running', llmStartMs: base + 1000, llmEndMs: base + 5000 });
  assert.equal(f.detail(5000).turnFirstTextStepMs, null);
  assert.equal(f.detail(5000).turnFirstToolMs, 5000);
  f.sync(6000, { status: 'generating', activeStartMs: base + 6000 });
  f.entries.push(planner(2, 6000));
  f.sync(10000, { status: 'tool_running', llmStartMs: base + 6000, llmEndMs: base + 10000, activeStartMs: null });
  const frozen = f.detail(10000).turnFirstTextStepMs;
  f.sync(11000, { status: 'generating', activeStartMs: base + 11000 });
  f.entries.push(error(3, 1, 311000), planner(4, 315000));
  f.sync(320000, { status: 'idle', llmStartMs: base + 11000, llmEndMs: base + 320000, activeStartMs: null });
  assert.equal(f.detail(320000).turnFirstTextStepMs, frozen);
  assert.equal(f.detail(320000).turnVisibleTtfrMs, null);
});

test('CLI renders retry and recovered totals with isolated session state', () => {
  function render(detail) {
    let output = '';
    const localFs = { ...fs, readFileSync: (file, ...args) => file === 0 ? JSON.stringify({ conversation_id: 'cli-test' }) : fs.readFileSync(file, ...args) };
    const localRequire = (name) => name === 'fs' ? localFs : name === '../lib/telemetry.cjs' ? { ...telemetry, getSessionDetail: () => detail } : require(name);
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cli/statusline.cjs'), 'utf8'), { require: localRequire, process: { env: {}, stdout: { write: (text) => { output += text; } } } });
    return output.replace(/\x1b\[[0-9;]*m/g, '');
  }
  assert.match(render(activeDetail), /重试中.*已失败 3 次/);
  assert.match(render(activeDetail), /失败等待 ≥911\.0s/);
  assert.match(render(completeDetail), /上步含重试 1225\.0s/);
});

function createPanelHarness(detail, tokenFormat = 'M') {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        textContent: '',
        innerHTML: '',
        value: '',
        className: '',
        style: {},
        attrs: {},
        hiddenState: null,
        setAttribute(k, v) { this.attrs[k] = v; },
        classList: {
          toggle(cls, force) {
            if (cls === 'hidden') this.owner.hiddenState = Boolean(force);
          },
          add() {},
        },
        addEventListener() {},
        querySelectorAll: () => [],
      });
      elements.get(id).classList.owner = elements.get(id);
    }
    return elements.get(id);
  };
  const sandbox = {
    document: { getElementById: get },
    window: { location: { search: '' }, sidecar: { conversationId: detail?.conversationId || '' } },
    fetch: async () => ({ ok: true, json: async () => ({ current: detail, prefs: { tokenFormat } }) }),
    setInterval() {},
    console,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../sidecars/tps_panel/app.js'), 'utf8'), sandbox);
  return new Promise((resolve) => setImmediate(() => resolve(get)));
}

test('slim sidebar panel shows only current-session token, context, and compaction info without steer or step breakdown', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../sidecars/tps_panel/index.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '../sidecars/tps_panel/main.mjs'), 'utf8');
  assert.doesNotMatch(html, /steer-input|steer-presets|steps-list|feed-list|sessions-list|session-select|companion-card/);
  assert.doesNotMatch(server, /\/api\/steer|\/api\/interrupt/);

  const f = fixture('aaaaaaaa-0006');
  f.entries[0] = { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\n精简侧栏监控面板\n</USER_REQUEST>', created_at: iso(0) };
  f.entries.push(
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: iso(1000),
      model: 'gemini-4-neon-xhigh',
      content: '第一阶段',
      input_tokens: 10000,
      cache_read_tokens: 495000,
      output_tokens: 2000,
    },
    {
      step_index: 2,
      type: 'CHECKPOINT',
      source: 'SYSTEM',
      status: 'DONE',
      created_at: iso(5000),
      content: '# Resuming from a compaction\n\nSummary text',
      input_tokens: 4000,
      cache_read_tokens: 510000,
      output_tokens: 6000,
    },
    {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: iso(8000),
      model: 'gemini-4-neon-xhigh',
      content: '压缩后继续',
      input_tokens: 27000,
      cache_read_tokens: 0,
      output_tokens: 1000,
    },
    {
      step_index: 4,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: iso(12000),
      model: 'gemini-4-neon-xhigh',
      content: '继续推进',
      input_tokens: 5000,
      cache_read_tokens: 27000,
      output_tokens: 800,
    }
  );
  f.sync(13000, { status: 'idle', activeStartMs: null });
  const detail = f.detail(14000);

  // Verify telemetry stats
  assert.equal(detail.totalInputTokens, 46000);
  assert.equal(detail.totalCacheReadTokens, 1032000);
  assert.equal(detail.totalOutputTokens, 9800);
  assert.equal(detail.totalTokens, 1087800);
  assert.equal(detail.compactionTotalTokens, 520000);
  assert.equal(detail.contextStats.currentTokens, 32000);
  assert.equal(detail.contextStats.lastDeltaTokens, 5000);
  assert.equal(detail.contextStats.peakTokens, 514000);
  assert.equal(detail.contextStats.windowLimitTokens, 1000000);
  assert.equal(detail.contextStats.windowUsagePct, 3.2);
  assert.equal(detail.contextStats.compactionThresholdTokens, 512000);
  assert.equal(detail.contextStats.referenceLimitTokens, 512000);
  assert.equal(detail.contextStats.referenceLimitSource, 'observed');
  assert.equal(detail.contextStats.stepsSinceLastCompaction, 2);
  assert.equal(detail.contextStats.growthSinceCompaction, 5000);
  assert.equal(detail.compactionStats.count, 1);
  assert.equal(detail.compactionStats.totalSavedTokens, 487000);
  assert.equal(detail.compactionStats.records[0].beforeContextTokens, 514000);
  assert.equal(detail.compactionStats.records[0].afterContextTokens, 27000);
  assert.equal(detail.compactionStats.records[0].reductionPct, 94.7);

  // Verify 3-card layout: CLI-native 10x10 context grid, 1M window, TPS gauge & merged sparkline/compaction
  assert.doesNotMatch(html, /donut-ctx-cache|class="info-grid"|class="card compaction-card"/);
  const get = await createPanelHarness(detail, 'M');
  assert.equal(get('session-title').textContent, '精简侧栏监控面板');
  assert.equal(get('tps-realtime').textContent, Number(detail.lastTps || 0).toFixed(1));
  assert.equal(get('tps-avg').textContent, Number(detail.avgTps || 0).toFixed(1));
  assert.equal(get('tps-peak').textContent, Number(detail.peakTps || 0).toFixed(1));
  assert.equal(get('total-tokens').textContent, '1.09M');
  assert.match(get('token-sub-meta').textContent, /1 轮对话 · 3 次推理 · 含压缩消耗 520\.0K/);
  assert.match(get('donut-tok-cache').attrs['stroke-dasharray'], /^[1-9]/);
  assert.equal(get('ctx-head-ratio').textContent, '32.0K / 1.00M');
  assert.equal(get('ctx-pct-pill').textContent, '3.2%');
  assert.equal((get('cli-ctx-grid').innerHTML.match(/class="cli-cell /g) || []).length, 100);
  assert.match(get('cli-cat-list').innerHTML, /系统\/工具/);
  assert.match(get('cli-cat-list').innerHTML, /压缩摘要/);
  assert.match(get('cli-cat-list').innerHTML, /压缩保留区/);
  assert.match(get('cli-ctx-meta').textContent, /上步 \+5\.0K · 峰值 514\.0K/);
  assert.equal(get('compact-count-badge').textContent, '已压缩 1 次');
  assert.equal(get('compact-history-box').hiddenState, false);
  assert.match(get('compact-history-summary').textContent, /1 次 · 最近 -94\.7% · 累计释放 487\.0K/);
  assert.match(get('ctx-sparkline').innerHTML, /<path d="M/);
  assert.match(get('compact-list').innerHTML, /514\.0K → 27\.0K/);
  assert.match(get('compact-list').innerHTML, /-94\.7%/);
});

test('slim sidebar hides compaction history box and shows growth pace when no compaction has occurred', async () => {
  const f = fixture('aaaaaaaa-0010');
  f.entries.push(
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(1000), model: 'gemini-4-neon-xhigh', content: 'a', input_tokens: 100000, cache_read_tokens: 0, output_tokens: 500 },
    { step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(2000), model: 'gemini-4-neon-xhigh', content: 'b', input_tokens: 20000, cache_read_tokens: 100000, output_tokens: 500 },
    { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(3000), model: 'gemini-4-neon-xhigh', content: 'c', input_tokens: 20000, cache_read_tokens: 120000, output_tokens: 500 }
  );
  f.sync(4000, { status: 'idle', activeStartMs: null });
  const detail = f.detail(4500);
  assert.equal(detail.contextStats.recentAvgGrowthTokens, 20000);
  assert.equal(detail.contextStats.estimatedStepsToCompaction, 19);
  assert.equal(detail.contextStats.history.length, 3);

  const get = await createPanelHarness(detail, 'M');
  assert.equal(get('compact-history-box').hiddenState, true);
  assert.equal(get('compact-count-badge').hiddenState, true);
  assert.match(get('compact-pace-line').textContent, /近期均增 \+20\.0K\/步.*约 19 步/);
  assert.match(get('ctx-sparkline').innerHTML, /<path d="M/);
});

test('cache observability tracks hot/decay/expired countdowns and counts unexpected cache misses accurately', async () => {
  const f = fixture('aaaaaaaa-0011');
  f.entries.push(
    // Step 1: cold start (should NOT count as unexpected miss)
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(0), model: 'gemini-4-neon-xhigh', content: 'cold', input_tokens: 100000, cache_read_tokens: 0, output_tokens: 400 },
    // Step 2: 30s later, normal hit
    { step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(30000), model: 'gemini-4-neon-xhigh', content: 'hit', input_tokens: 5000, cache_read_tokens: 100000, output_tokens: 400 },
    // Step 3: 4 minutes later, cache expired & recomputed -> 1 unexpected miss
    { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(270000), model: 'gemini-4-neon-xhigh', content: 'miss', input_tokens: 112000, cache_read_tokens: 0, output_tokens: 400 }
  );
  f.sync(272000, { status: 'idle', llmStartMs: base + 270000, llmEndMs: base + 272000, activeStartMs: null });

  // At t=332s (60s idle since step 3 ended at 272s): hot zone (<3m), 02:00 remaining
  const hotDetail = f.detail(332000);
  assert.equal(hotDetail.cacheStats.mode, 'implicit');
  assert.equal(hotDetail.cacheStats.lastStatus, 'miss');
  assert.equal(hotDetail.cacheStats.missCount, 1);
  assert.equal(hotDetail.cacheStats.missRecomputeTokens, 112000);
  assert.equal(hotDetail.cacheStats.lastMiss.stepIndex, 3);

  const html = fs.readFileSync(path.join(__dirname, '../sidecars/tps_panel/index.html'), 'utf8');
  assert.doesNotMatch(html, /class="card cache-card"/);

  const hotUi = await createPanelHarness(hotDetail, 'M');
  assert.equal(hotUi('cache-state-badge').textContent, '热缓存');
  assert.equal(hotUi('cache-countdown-label').textContent, '热区倒计时');
  assert.equal(hotUi('cache-countdown-val').textContent, '02:00');
  assert.match(hotUi('ctx-cache-strip').attrs.title, /过期重建 1 次/);

  // At t=482s (210s = 3m30s idle): decay warning zone (3m-5m)
  const decayDetail = f.detail(482000);
  const decayUi = await createPanelHarness(decayDetail, 'M');
  assert.equal(decayUi('cache-state-badge').textContent, '衰减临界');
  assert.equal(decayUi('cache-countdown-label').textContent, '衰变倒计时');
  assert.equal(decayUi('cache-countdown-val').textContent, '01:30');

  // At t=2200s (>30m idle): expired
  const expDetail = f.detail(2200000);
  const expUi = await createPanelHarness(expDetail, 'M');
  assert.equal(expUi('cache-state-badge').textContent, '预计已失效');
  assert.equal(expUi('cache-countdown-label').textContent, '已静置');
});

test('on-demand retry alert, session duration, and Top 3 context consumers render accurately', async () => {
  // 1. Retry alert surfaces on retrying state and stays hidden when idle
  const retryingUi = await createPanelHarness(activeDetail, 'M');
  assert.equal(retryingUi('tps-health-alert').hiddenState, false);
  assert.match(retryingUi('tps-health-alert').textContent, /请求重试中.*已失败 3 次/);

  const doneUi = await createPanelHarness(completeDetail, 'M');
  assert.equal(doneUi('tps-health-alert').hiddenState, true);
  assert.match(doneUi('session-duration').textContent, /^历时 /);

  // 2. Top 3 context consumers attributes biggest context jumps to concrete tool actions
  const f = fixture('aaaaaaaa-0012');
  f.entries.push(
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(1000), model: 'gemini-4-neon-xhigh', content: '', tool_calls: [{ name: 'read_file', args: { Path: '"telemetry.cjs"' } }], input_tokens: 20000, cache_read_tokens: 0, output_tokens: 300 },
    { step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(5000), model: 'gemini-4-neon-xhigh', content: '', tool_calls: [{ name: 'run_command', args: { CommandLine: '"npm test"', toolSummary: '"Run regression tests"' } }], input_tokens: 35000, cache_read_tokens: 20000, output_tokens: 400 },
    { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(9000), model: 'gemini-4-neon-xhigh', content: 'done', input_tokens: 12000, cache_read_tokens: 55000, output_tokens: 500 }
  );
  f.sync(10000, { status: 'idle', activeStartMs: null });
  const detail = f.detail(11000);
  assert.equal(detail.contextStats.topConsumers.length, 2);
  assert.equal(detail.contextStats.topConsumers[0].deltaTokens, 35000);
  assert.match(detail.contextStats.topConsumers[0].label, /telemetry\.cjs/);
  assert.equal(detail.contextStats.topConsumers[1].deltaTokens, 12000);

  const topUi = await createPanelHarness(detail, 'M');
  assert.equal(topUi('top-consumers-box').hiddenState, false);
  assert.match(topUi('top-consumers-summary').textContent, /大块占用 Top 2（合计 \+47\.0K）/);
  assert.match(topUi('top-consumers-list').innerHTML, /telemetry\.cjs/);
  assert.match(topUi('top-consumers-list').innerHTML, /\+35\.0K/);
});

test('slim sidebar handles just-compacted state before the next planner response arrives', async () => {
  const f = fixture('aaaaaaaa-0008');
  f.entries.push(
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: iso(1000),
      content: 'step 1',
      input_tokens: 12000,
      cache_read_tokens: 500000,
      output_tokens: 1500,
    },
    {
      step_index: 2,
      type: 'CHECKPOINT',
      source: 'SYSTEM',
      status: 'DONE',
      created_at: iso(3000),
      content: '# Resuming from a compaction\n\nSummary',
      input_tokens: 3000,
      cache_read_tokens: 512000,
      output_tokens: 7200,
    }
  );
  f.sync(4000, { status: 'generating', activeStartMs: base + 3500 });
  const detail = f.detail(4500);
  assert.equal(detail.contextStats.justCompacted, true);
  assert.equal(detail.compactionStats.count, 1);

  const get = await createPanelHarness(detail, 'M');
  assert.equal(get('status-text').textContent, '推理中');
  assert.match(get('ctx-head-ratio').textContent, /已重置 \/ 1\.00M/);
  assert.equal(get('ctx-pct-pill').textContent, '刚压缩');
  assert.equal(get('ctx-compacted-banner').hiddenState, false);
  assert.match(get('compact-list').innerHTML, /515\.0K → 待下一步刷新/);
});

test('silent thinking + tool execution freezes TTFA immediately in telemetry', () => {
  const f = fixture('aaaaaaaa-0009');
  f.sync(200, { status: 'generating', activeStartMs: base + 200, fromActiveHook: true });
  const pre = f.detail(3000);
  assert.equal(pre.waitingFirstResponse, true);
  assert.equal(pre.waitingFirstResponseElapsedMs, 3000);

  clock(4200, () => telemetry.markToolRunningFast(f.id, { transcriptPath: f.file, nowMs: base + 4200 }));
  const midToolPreFlush = f.detail(9000);
  assert.equal(midToolPreFlush.waitingFirstResponse, false);
  assert.equal(midToolPreFlush.turnFirstResponseMs, 4200);
  assert.equal(midToolPreFlush.turnFirstResponseKind, 'tool');
});

test('VS Code adapter displays retries and retains the warning without disk writes', (t) => {
  const extensionFile = process.env.AGY_TPS_EXTENSION;
  if (!extensionFile) {
    t.skip('AGY_TPS_EXTENSION not set');
    return;
  }
  const bar = { show() {} };
  class MarkdownString { constructor() { this.value = ''; } appendMarkdown(text) { this.value += text; } }
  const vscode = { window: { createStatusBarItem: () => bar }, workspace: {}, StatusBarAlignment: { Right: 1 }, MarkdownString, ThemeColor: class {}, commands: { registerCommand: () => ({ dispose() {} }) } };
  const fakeFs = { existsSync: () => true, mkdirSync() {}, watch: () => ({ close() {} }) };
  const localRequire = (name) => name === 'vscode' ? vscode : name === 'fs' ? fakeFs : name.endsWith('telemetry.cjs') ? { getPrefs: () => ({ tokenFormat: 'M' }), listRecentSessions: () => [activeDetail] } : require(name);
  localRequire.resolve = (name) => name;
  localRequire.cache = {};
  const exports = {};
  vm.runInNewContext(fs.readFileSync(extensionFile, 'utf8'), { require: localRequire, process: { env: { USERPROFILE: root } }, module: exports, setInterval: () => 1, clearInterval() {} });
  const context = { subscriptions: [] };
  exports.exports.activate(context);
  assert.match(bar.text, /重试中.*已失败3次/);
  assert.match(bar.tooltip.value, /本轮失败 \/ 重试损耗/);
  context.subscriptions.forEach((item) => item.dispose?.());
});

test('markToolRunningFast preserves exact pre-tool LLM timing without scanning transcript and is idempotent across parallel tool calls', () => {
  const f = fixture('aaaaaaaa-0007');
  f.sync(1000, { status: 'generating', activeStartMs: base + 1000, fromActiveHook: true });
  // Simulate 3 parallel PreToolUse hooks firing at t=4200ms, 4205ms, 4210ms
  clock(4200, () => telemetry.markToolRunningFast(f.id, { transcriptPath: f.file, nowMs: base + 4200 }));
  const afterFirst = fs.readFileSync(telemetry.getSessionFile(f.id), 'utf8');
  clock(4205, () => telemetry.markToolRunningFast(f.id, { transcriptPath: f.file, nowMs: base + 4205 }));
  clock(4210, () => telemetry.markToolRunningFast(f.id, { transcriptPath: f.file, nowMs: base + 4210 }));
  assert.equal(fs.readFileSync(telemetry.getSessionFile(f.id), 'utf8'), afterFirst);

  // Now the planner response lands and tool runs for 8 seconds until t=12200ms
  f.entries.push(planner(1, 1000, 'opening', [{ name: 'read_file' }, { name: 'run_command' }]));
  f.save();
  // Live poll during tool execution sees exact 3200ms LLM duration (not inflated by tool time)
  const liveDetail = f.detail(9000);
  assert.equal(liveDetail.status, 'tool_running');
  assert.equal(liveDetail.steps.at(-1).durationMs, 3200);
  assert.equal(liveDetail.steps.at(-1).precise, true);

  // PostInvocation at t=12200ms commits the exact 3200ms stepTiming and clears pendingStepTiming
  f.sync(12200, { status: 'tool_running', activeStartMs: null, fromActiveHook: true });
  const saved = telemetry.readJsonSafe(telemetry.getSessionFile(f.id));
  assert.equal(saved.pendingStepTiming, null);
  assert.equal(saved.stepTimings['1'].durationMs, 3200);
});

// ---- Decode-speed TPS from agy's conversation DB (output / (completed - first chunk)) ----
function pbVarint(n) {
  const out = [];
  while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); }
  out.push(n);
  return Buffer.from(out);
}
function pbMsg(pairs) {
  return Buffer.concat(pairs.map(([field, value]) => Buffer.isBuffer(value)
    ? Buffer.concat([pbVarint(field * 8 + 2), pbVarint(value.length), value])
    : Buffer.concat([pbVarint(field * 8), pbVarint(value)])));
}
const pbTs = (ms) => pbMsg([[1, Math.floor((base + ms) / 1000)], [2, ((base + ms) % 1000) * 1e6]]);
function stepMeta({ start, first, end, out, think, ans }) {
  return pbMsg([
    [1, pbTs(start)], [6, pbTs(first)], [7, pbTs(end)], [8, pbTs(end)],
    [9, pbMsg([[1, 1535], [2, 2876], [3, out], [5, 164260], [9, think], [10, ans]])],
    [20, pbMsg([[2, 92], [3, 43]])],
  ]);
}
let hasSqlite = false;
try { hasSqlite = typeof require('node:sqlite').DatabaseSync === 'function'; } catch {}

test('planner step metadata decodes first-chunk timing and rejects inconsistent or malformed blobs', () => {
  const ok = telemetry.parsePlannerStepMetadata(stepMeta({ start: 0, first: 3989, end: 15929, out: 1662, think: 159, ans: 1503 }));
  assert.deepEqual(ok, {
    startMs: base, firstChunkMs: base + 3989, endMs: base + 15929,
    outputTokens: 1662, thinkingTokens: 159, answerTokens: 1503, inputTokens: 2876, cacheReadTokens: 164260,
  });
  assert.equal(telemetry.parsePlannerStepMetadata(stepMeta({ start: 0, first: 100, end: 900, out: 50, think: 10, ans: 30 })), null, 'output must equal thinking + answer');
  assert.equal(telemetry.parsePlannerStepMetadata(stepMeta({ start: 5000, first: 100, end: 900, out: 40, think: 10, ans: 30 })), null, 'first chunk before start');
  const full = stepMeta({ start: 0, first: 100, end: 900, out: 40, think: 10, ans: 30 });
  assert.equal(telemetry.parsePlannerStepMetadata(full.subarray(0, full.length - 3)), null, 'truncated');
  assert.equal(telemetry.parsePlannerStepMetadata(pbMsg([[1, pbTs(0)], [6, pbTs(1)], [7, pbTs(2)]])), null, 'no usage');
  assert.equal(telemetry.parsePlannerStepMetadata(Buffer.from([0xff, 0xff, 0xff])), null, 'garbage');
  assert.equal(telemetry.parsePlannerStepMetadata(null), null);
});

test('decode TPS excludes time to first token, skips short or mismatched steps, and the panel labels it', async (t) => {
  if (!hasSqlite) {
    t.skip('node:sqlite unavailable on this runtime (legacy end-to-end fallback)');
    return;
  }
  const { DatabaseSync } = require('node:sqlite');
  const f = fixture('aaaaaaaa-0013');
  const plannerStep = (index, ms, out) => ({ step_index: index, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(ms), content: '进展', output_tokens: out, input_tokens: 2876, cache_read_tokens: 164260 });
  f.entries.push(plannerStep(1, 1000, 1662), plannerStep(2, 20000, 35), plannerStep(3, 30000, 600));
  f.save();
  const dbFile = path.join(root, '.gemini/antigravity/conversations', `${f.id}.db`);
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, metadata blob)');
  const insert = db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, 15, 3, ?)');
  insert.run(1, stepMeta({ start: 1000, first: 5000, end: 17000, out: 1662, think: 159, ans: 1503 })); // 12s window
  insert.run(2, stepMeta({ start: 20000, first: 24375, end: 24603, out: 35, think: 23, ans: 12 }));     // single chunk
  insert.run(3, stepMeta({ start: 30000, first: 34000, end: 40000, out: 601, think: 1, ans: 600 }));   // != transcript
  db.close();
  const dbBefore = fs.readFileSync(dbFile);

  const detail = f.detail(60000);
  assert.equal(detail.tpsMode, 'decode');
  assert.equal(detail.lastTps, 138.5);
  assert.equal(detail.avgTps, 138.5);
  assert.equal(detail.peakTps, 138.5);
  assert.equal(detail.tpsSampleSteps, 1);
  assert.equal(detail.lastTpsStepIdx, 1);
  assert.equal(detail.lastTpsTtftMs, 4000);
  assert.equal(detail.lastTpsGenMs, 12000);
  assert.equal(detail.lastTtftMs, 4375);
  assert.equal(detail.medianTtftMs, 4375);
  const [s1, s2, s3] = detail.steps;
  assert.equal(s1.tps, 138.5);
  assert.equal(s2.tps, 0, 'short single-chunk step is not measurable');
  assert.equal(s2.ttftMs, 4375);
  assert.equal(s3.tps, 0, 'DB/transcript token mismatch is ignored');
  assert.equal(s3.ttftMs, null);
  assert.ok(s2.e2eTps > 0, 'legacy end-to-end value is still kept per step');
  assert.equal(fs.existsSync(telemetry.getSessionFile(f.id)), false, 'reads do not write state');
  assert.deepEqual(fs.readFileSync(dbFile), dbBefore, 'agy DB is never modified');

  const get = await createPanelHarness(detail, 'M');
  assert.equal(get('tps-realtime').textContent, '138.5');
  assert.equal(get('tps-realtime-label').textContent, '生成速度');
  assert.match(get('tps-realtime-label').attrs.title, /不含首 token 等待/);
  assert.equal(get('tps-live-meta').textContent, '首 token 4.0s · 生成 12.0s · 1.7K 输出');
  assert.equal(get('tps-avg-sub').textContent, '1 步加权 · 首 token 中位 4.4s');

  const noSample = await createPanelHarness({ ...detail, lastTps: 0, avgTps: 0, peakTps: 0, tpsSampleSteps: 0, lastTpsGenMs: null, lastTpsTtftMs: null, steps: [] }, 'M');
  assert.equal(noSample('tps-realtime').textContent, '--');
  assert.equal(noSample('tps-live-meta').textContent, '暂无足够长的生成步骤');

  const fallback = await createPanelHarness({ ...detail, tpsMode: 'e2e' }, 'M');
  assert.equal(fallback('tps-realtime-label').textContent, '端到端速率');
  assert.match(fallback('tps-avg-sub').textContent, /^端到端/);
});

test('CLI marks the legacy end-to-end fallback', () => {
  function render(detail) {
    let output = '';
    const localFs = { ...fs, readFileSync: (file, ...args) => file === 0 ? JSON.stringify({ conversation_id: 'cli-tps' }) : fs.readFileSync(file, ...args) };
    const localRequire = (name) => name === 'fs' ? localFs : name === '../lib/telemetry.cjs' ? { ...telemetry, getSessionDetail: () => detail } : require(name);
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cli/statusline.cjs'), 'utf8'), { require: localRequire, process: { env: {}, stdout: { write: (text) => { output += text; } } } });
    return output.replace(/\x1b\[[0-9;]*m/g, '');
  }
  const idle = { conversationId: 'cli-tps', status: 'idle', healthState: 'idle', turnFirstResponseMs: null, turnFirstTextStepMs: null, lastDurationMs: null, totalTokens: 1000, sessionSpanMs: 1000 };
  assert.match(render({ ...idle, tpsMode: 'e2e', lastTps: 96.8, avgTps: 87.6 }), /96\.8 tok\/s \(均 87\.6 · 端到端\)/);
  assert.match(render({ ...idle, tpsMode: 'decode', lastTps: 139.2, avgTps: 148.2 }), /139\.2 tok\/s \(均 148\.2\)/);
});

test('VS Code adapter shows decode speed with TTFT, or labels the end-to-end fallback', (t) => {
  const extensionFile = process.env.AGY_TPS_EXTENSION;
  if (!extensionFile) {
    t.skip('AGY_TPS_EXTENSION not set');
    return;
  }
  function activate(detail) {
    const bar = { show() {} };
    class MarkdownString { constructor() { this.value = ''; } appendMarkdown(text) { this.value += text; } }
    const vscode = { window: { createStatusBarItem: () => bar }, workspace: {}, StatusBarAlignment: { Right: 1 }, MarkdownString, ThemeColor: class {}, commands: { registerCommand: () => ({ dispose() {} }) } };
    const fakeFs = { existsSync: () => true, mkdirSync() {}, watch: () => ({ close() {} }) };
    const localRequire = (name) => name === 'vscode' ? vscode : name === 'fs' ? fakeFs : name.endsWith('telemetry.cjs') ? { getPrefs: () => ({ tokenFormat: 'M' }), listRecentSessions: () => [detail] } : require(name);
    localRequire.resolve = (name) => name;
    localRequire.cache = {};
    const exports = {};
    vm.runInNewContext(fs.readFileSync(extensionFile, 'utf8'), { require: localRequire, process: { env: { USERPROFILE: root } }, module: exports, setInterval: () => 1, clearInterval() {} });
    const context = { subscriptions: [] };
    exports.exports.activate(context);
    context.subscriptions.forEach((item) => item.dispose?.());
    return bar;
  }
  const idle = { conversationId: 'vs-tps', title: 't', surface: 'IDE', status: 'idle', healthState: 'idle', isLiveSession: false, sessionSpanMs: 1000, totalTokens: 1000, lastDurationMs: 17180, turnFirstResponseMs: null, turnFirstTextStepMs: null, turnRetryCount: 0 };
  const decode = activate({ ...idle, tpsMode: 'decode', lastTps: 139.2, avgTps: 148.2, peakTps: 217, lastTpsTtftMs: 3989, lastTpsGenMs: 11940, lastTtftMs: 4375, medianTtftMs: 5309 });
  assert.match(decode.text, /AGY 139\.2 tok\/s/);
  assert.match(decode.tooltip.value, /\*\*生成速度\*\*：\*\*139\.2 tok\/s\*\* （均 148\.2 \/ 峰 217\.0） · 该步首 token 4\.0s · 生成 11\.9s\n/);
  assert.match(decode.tooltip.value, /\*\*流式首 Token \(TTFT\)\*\*：最近 4\.4s · 中位 5\.3s/);
  const none = activate({ ...idle, tpsMode: 'decode', lastTps: 0, avgTps: 0, peakTps: 0, lastTpsGenMs: null, lastTtftMs: null, medianTtftMs: null });
  assert.match(none.text, /AGY -- tok\/s/);
  assert.match(none.tooltip.value, /流式首 Token \/ 前端渲染 \(T2, T3\)\*\*：未采集/);
  const e2e = activate({ ...idle, tpsMode: 'e2e', lastTps: 96.8, avgTps: 87.6, peakTps: 158.1 });
  assert.match(e2e.tooltip.value, /\*\*端到端速率\*\*：\*\*96\.8 tok\/s\*\*.*含首 token 等待/);
  assert.doesNotMatch(e2e.tooltip.value, /生成速度/);
});
