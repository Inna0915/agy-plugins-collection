(function () {
  const hostConvId = (window.sidecar && window.sidecar.conversationId) || '';
  const CIRC = 2 * Math.PI * 45; // r = 45 -> ~282.743
  // 230-deg speedometer arc for r = 50 centered at (68, 62) -> arc length ≈ 200.713
  const GAUGE_ARC_LEN = (230 / 360) * 2 * Math.PI * 50;

  let latestSnapshot = null;
  let knownAssetVersion = '';
  let snapshotMonoMs = typeof performance !== 'undefined' ? performance.now() : 0;
  let tokenFormat = 'M';
  let hoveredSeg = '';

  const els = {
    statusRing: document.getElementById('status-ring'),
    statusDot: document.getElementById('status-dot'),
    statusText: document.getElementById('status-text'),
    btnUnitToggle: document.getElementById('btn-unit-toggle'),
    sessionTitle: document.getElementById('session-title'),
    modelName: document.getElementById('model-name'),

    // TPS hero speedometer card
    tpsLiveMeta: document.getElementById('tps-live-meta'),
    tpsHealthAlert: document.getElementById('tps-health-alert'),
    tpsGaugeArc: document.getElementById('tps-gauge-arc'),
    tpsRealtime: document.getElementById('tps-realtime'),
    tpsRealtimeLabel: document.getElementById('tps-realtime-label'),
    tpsAvg: document.getElementById('tps-avg'),
    tpsAvgSub: document.getElementById('tps-avg-sub'),
    tpsPeak: document.getElementById('tps-peak'),
    tpsDeltaVsAvg: document.getElementById('tps-delta-vs-avg'),
    tpsWaveAvgLabel: document.getElementById('tps-wave-avg-label'),
    tpsSparkline: document.getElementById('tps-sparkline'),

    // Token donut card
    tokenCard: document.getElementById('token-card'),
    tokenCacheHit: document.getElementById('token-cache-hit'),
    tokenHero: document.getElementById('token-hero'),
    donutTokCache: document.getElementById('donut-tok-cache'),
    donutTokInput: document.getElementById('donut-tok-input'),
    donutTokOutput: document.getElementById('donut-tok-output'),
    totalTokens: document.getElementById('total-tokens'),
    tokenDonutSub: document.getElementById('token-donut-sub'),
    tokenLegend: document.getElementById('token-legend'),
    tokenSubMeta: document.getElementById('token-sub-meta'),
    sessionDuration: document.getElementById('session-duration'),
    bgTokCache: document.getElementById('bg-tok-cache'),
    bgTokInput: document.getElementById('bg-tok-input'),
    bgTokOutput: document.getElementById('bg-tok-output'),
    tokCache: document.getElementById('tok-cache'),
    tokCachePct: document.getElementById('tok-cache-pct'),
    tokInput: document.getElementById('tok-input'),
    tokInputPct: document.getElementById('tok-input-pct'),
    tokOutput: document.getElementById('tok-output'),
    tokOutputPct: document.getElementById('tok-output-pct'),

    // Embedded cache freshness strip inside context card
    ctxCacheStrip: document.getElementById('ctx-cache-strip'),
    cacheStateBadge: document.getElementById('cache-state-badge'),
    cacheCountdownLabel: document.getElementById('cache-countdown-label'),
    cacheCountdownVal: document.getElementById('cache-countdown-val'),
    cacheTtlFill: document.getElementById('cache-ttl-fill'),

    // CLI-native /context card
    contextCard: document.getElementById('context-card'),
    ctxHeadRatio: document.getElementById('ctx-head-ratio'),
    ctxPctPill: document.getElementById('ctx-pct-pill'),
    ctxCompactedBanner: document.getElementById('ctx-compacted-banner'),
    ctxProgressTrack: document.getElementById('ctx-progress-track'),
    cliCtxGrid: document.getElementById('cli-ctx-grid'),
    cliGridFoot: document.getElementById('cli-grid-foot'),
    cliCatList: document.getElementById('cli-cat-list'),
    cliCtxMeta: document.getElementById('cli-ctx-meta'),

    // Embedded sparkline & on-demand compaction history inside context card
    sparkLimitLabel: document.getElementById('spark-limit-label'),
    ctxSparkline: document.getElementById('ctx-sparkline'),
    compactPaceLine: document.getElementById('compact-pace-line'),
    compactCountBadge: document.getElementById('compact-count-badge'),
    topConsumersBox: document.getElementById('top-consumers-box'),
    topConsumersSummary: document.getElementById('top-consumers-summary'),
    topConsumersList: document.getElementById('top-consumers-list'),
    compactHistoryBox: document.getElementById('compact-history-box'),
    compactHistorySummary: document.getElementById('compact-history-summary'),
    compactList: document.getElementById('compact-list'),
  };

  // Lightweight render cache to prevent 1.2s polling from clobbering hover state or flickering SVG
  const renderCache = {
    tpsWave: '',
    ctxGrid: '',
    ctxCat: '',
    ctxSpark: '',
    topConsumers: '',
    compactList: '',
  };

  // Auto-detect light/dark host theme from CSS variables pushed by preload.js
  function parseColorLuminance(colorStr) {
    const s = String(colorStr || '').trim();
    if (!s) return null;
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (hex) {
      let h = hex[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s);
    if (rgb) {
      return 0.2126 * Number(rgb[1]) + 0.7152 * Number(rgb[2]) + 0.0722 * Number(rgb[3]);
    }
    return null;
  }

  function syncThemeMode() {
    try {
      if (!document.documentElement || typeof window.getComputedStyle !== 'function') return;
      const cs = window.getComputedStyle(document.documentElement);
      const rawBg = cs.getPropertyValue('--background') || cs.getPropertyValue('--card') || '';
      const lum = parseColorLuminance(rawBg);
      if (lum !== null) {
        document.documentElement.setAttribute('data-theme', lum < 128 ? 'dark' : 'light');
      }
    } catch {}
  }

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('message', (event) => {
      if (event && event.data && event.data.type === 'theme-change') {
        if (typeof setTimeout === 'function') setTimeout(syncThemeMode, 0);
        else syncThemeMode();
      }
    });
  }
  syncThemeMode();

  function apiFetch(url, bodyObj) {
    if (window.sidecar && typeof window.sidecar.fetch === 'function') {
      return window.sidecar.fetch(url, {
        method: 'POST',
        body: JSON.stringify(bodyObj || {}),
      });
    }
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj || {}),
    });
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtTokens(n) {
    const num = Math.max(0, Math.round(Number(n || 0)));
    if (tokenFormat === 'raw') {
      return num.toLocaleString('en-US');
    }
    if (num >= 1000000) {
      return (num / 1000000).toFixed(2) + 'M';
    }
    if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'K';
    }
    return String(num);
  }

  function fmtSignedTokens(delta) {
    if (delta === null || delta === undefined || !Number.isFinite(Number(delta))) return '--';
    const num = Math.round(Number(delta));
    if (num === 0) return '0';
    return (num > 0 ? '+' : '-') + fmtTokens(Math.abs(num));
  }

  function fmtPct(part, total) {
    if (!total || total <= 0) return '0.0%';
    return ((Number(part || 0) / Number(total)) * 100).toFixed(1) + '%';
  }

  function fmtSec(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(Number(ms)) || Number(ms) < 0) return '--';
    return (Number(ms) / 1000).toFixed(1) + 's';
  }

  function fmtMmSs(ms) {
    const totalSec = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function fmtDurationBrief(ms) {
    const totalSec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
  }

  function fmtClock(tsMs) {
    const n = Number(tsMs || 0);
    if (!n) return '--:--:--';
    const d = new Date(n);
    const now = new Date();
    const pad = (v) => String(v).padStart(2, '0');
    const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return hms;
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms}`;
  }

  function getUsageTone(pct) {
    const v = Number(pct || 0);
    if (v >= 85) return 'red';
    if (v >= 65) return 'amber';
    return 'green';
  }

  function setAttr(el, name, value) {
    if (el && typeof el.setAttribute === 'function') {
      el.setAttribute(name, String(value));
    }
  }

  function setWidth(el, pct) {
    if (el && el.style) {
      el.style.width = `${Math.max(0, Math.min(100, Number(pct || 0))).toFixed(1)}%`;
    }
  }

  function applyDonutSegments(items, { fullCircle = true, gapPx = 2.4, minArcPx = 4 } = {}) {
    const activeCount = items.filter((it) => it.ratio > 0).length;
    const gap = activeCount > 1 ? gapPx : 0;
    const clampedTotal = Math.min(
      1,
      items.reduce((sum, it) => sum + Math.max(0, Number(it.ratio || 0)), 0)
    );
    const rawTotalPx = fullCircle ? CIRC : clampedTotal * CIRC;

    const lengths = items.map((it) => {
      const r = Math.max(0, Number(it.ratio || 0));
      if (r <= 0 || rawTotalPx <= 0) return 0;
      return r * CIRC;
    });

    if (activeCount > 1) {
      let extraNeeded = 0;
      let largestIdx = -1;
      let largestVal = 0;
      for (let i = 0; i < lengths.length; i++) {
        if (lengths[i] > largestVal) {
          largestVal = lengths[i];
          largestIdx = i;
        }
        if (lengths[i] > 0 && lengths[i] < minArcPx + gap) {
          extraNeeded += minArcPx + gap - lengths[i];
          lengths[i] = minArcPx + gap;
        }
      }
      if (extraNeeded > 0 && largestIdx >= 0 && lengths[largestIdx] > extraNeeded + minArcPx + gap) {
        lengths[largestIdx] -= extraNeeded;
      }
    }

    let offset = 0;
    for (let i = 0; i < items.length; i++) {
      const el = items[i].el;
      const segPx = lengths[i];
      if (!el || segPx <= 0) {
        setAttr(el, 'stroke-dasharray', `0 ${CIRC.toFixed(2)}`);
        setAttr(el, 'stroke-dashoffset', '0');
        continue;
      }
      const drawLen = Math.max(1.2, segPx - gap);
      setAttr(el, 'stroke-dasharray', `${drawLen.toFixed(2)} ${CIRC.toFixed(2)}`);
      setAttr(el, 'stroke-dashoffset', (-offset).toFixed(2));
      offset += segPx;
    }
  }

  function renderStatus(cur) {
    if (!cur) {
      els.statusRing.className = 'status-ring';
      els.statusDot.className = 'status-dot';
      els.statusText.className = 'status-pill';
      els.statusText.textContent = '待命';
      return;
    }
    if (cur.healthState === 'interrupted') {
      els.statusRing.className = 'status-ring warn';
      els.statusDot.className = 'status-dot warn';
      els.statusText.className = 'status-pill warn';
      els.statusText.textContent = '已中断';
    } else if (cur.status === 'generating') {
      els.statusRing.className = 'status-ring busy';
      els.statusDot.className = 'status-dot busy';
      els.statusText.className = 'status-pill busy';
      els.statusText.textContent = '推理中';
    } else if (cur.status === 'tool_running') {
      els.statusRing.className = 'status-ring busy';
      els.statusDot.className = 'status-dot busy';
      els.statusText.className = 'status-pill busy';
      els.statusText.textContent = '工具执行';
    } else {
      els.statusRing.className = 'status-ring';
      els.statusDot.className = 'status-dot';
      els.statusText.className = 'status-pill';
      els.statusText.textContent = '空闲';
    }
  }

  function renderTpsSparkline(steps, avgTps) {
    const valid = (Array.isArray(steps) ? steps : [])
      .map((s) => Number(s?.tps || 0))
      .filter((v) => Number.isFinite(v) && v > 0)
      .slice(-20);

    els.tpsWaveAvgLabel.textContent = `均线 ${Number(avgTps || 0).toFixed(1)} tok/s`;

    const W = 260;
    const H = 40;
    const padX = 5;
    const padY = 6;
    const plotW = W - padX * 2;
    const plotH = H - padY * 2;

    if (valid.length === 0) {
      const emptyWave = `<line x1="${padX}" y1="${H / 2}" x2="${W - padX}" y2="${H / 2}" stroke="currentColor" stroke-opacity="0.16" stroke-width="1" stroke-dasharray="3 3"/>`;
      if (renderCache.tpsWave !== emptyWave) {
        renderCache.tpsWave = emptyWave;
        els.tpsSparkline.innerHTML = emptyWave;
      }
      return;
    }

    const maxVal = Math.max(10, avgTps * 1.25, ...valid) * 1.08;
    const yFor = (val) => padY + plotH * (1 - Math.max(0, Math.min(maxVal, val)) / maxVal);
    const avgY = yFor(Number(avgTps || 0)).toFixed(1);

    const stepX = valid.length > 1 ? plotW / (valid.length - 1) : 0;
    const pts = valid.map((v, i) => ({
      x: valid.length === 1 ? W / 2 : padX + i * stepX,
      y: yFor(v),
    }));

    const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const areaPath = valid.length > 1
      ? `${linePath} L${pts[pts.length - 1].x.toFixed(1)},${(H - padY).toFixed(1)} L${pts[0].x.toFixed(1)},${(H - padY).toFixed(1)} Z`
      : '';
    const lastPt = pts[pts.length - 1];

    const waveHtml = [
      `<defs><linearGradient id="tpsWaveGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#06b6d4" stop-opacity="0.28"/><stop offset="100%" stop-color="#06b6d4" stop-opacity="0.02"/></linearGradient></defs>`,
      avgTps > 0
        ? `<line x1="${padX}" y1="${avgY}" x2="${W - padX}" y2="${avgY}" stroke="#10b981" stroke-opacity="0.45" stroke-width="1" stroke-dasharray="3 3"/>`
        : '',
      areaPath ? `<path d="${areaPath}" fill="url(#tpsWaveGrad)"/>` : '',
      valid.length > 1
        ? `<path d="${linePath}" fill="none" stroke="url(#grad-tps)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
        : '',
      `<circle cx="${lastPt.x.toFixed(1)}" cy="${lastPt.y.toFixed(1)}" r="3.2" fill="#06b6d4" stroke="var(--card-bg, #ffffff)" stroke-width="1.3"/>`,
    ].join('');
    if (renderCache.tpsWave !== waveHtml) {
      renderCache.tpsWave = waveHtml;
      els.tpsSparkline.innerHTML = waveHtml;
    }
  }

  function updateTpsLiveBadge() {
    const cur = latestSnapshot?.current;
    if (!cur) return;
    const nowMono = typeof performance !== 'undefined' ? performance.now() : 0;
    const monoDelta = Math.max(0, nowMono - snapshotMonoMs);

    // Update live session duration in Token card footer
    if (cur.sessionStartedAtMs > 0) {
      const baseSpan = Number(cur.sessionSpanMs || 0);
      const liveSpan = cur.isLiveSession ? baseSpan + monoDelta : baseSpan;
      els.sessionDuration.textContent = `历时 ${fmtDurationBrief(liveSpan)}`;
      setAttr(els.sessionDuration, 'title', `会话始于 ${fmtClock(cur.sessionStartedAtMs)}`);
    } else {
      els.sessionDuration.textContent = '历时 --';
    }

    // On-demand retry / stall / error / interrupted alert inside TPS card
    const hs = cur.healthState || 'idle';
    if (hs === 'retrying') {
      const waitMs = Number(cur.activeStepElapsedMs || 0) + monoDelta;
      const reason = cur.lastFailureReason ? ` · ${cur.lastFailureReason}` : '';
      els.tpsHealthAlert.textContent = `↻ 请求重试中（已失败 ${cur.activeRetryCount || 1} 次 · 已等待 ${fmtSec(waitMs)}${reason}）`;
      els.tpsHealthAlert.className = 'health-alert tone-red';
      els.tpsHealthAlert.classList.toggle('hidden', false);
    } else if (hs === 'stalled') {
      const waitMs = Number(cur.activeStepElapsedMs || cur.noProgressMs || 0);
      els.tpsHealthAlert.textContent = `⚠ 超过 6 分钟未收到新进展（已等待 ${fmtDurationBrief(waitMs)}），请核对会话状态`;
      els.tpsHealthAlert.className = 'health-alert tone-amber';
      els.tpsHealthAlert.classList.toggle('hidden', false);
    } else if (hs === 'error') {
      const reason = cur.lastFailureReason ? `：${cur.lastFailureReason}` : '';
      els.tpsHealthAlert.textContent = `⚠ 本轮请求遇到错误已停止${reason}`;
      els.tpsHealthAlert.className = 'health-alert tone-red';
      els.tpsHealthAlert.classList.toggle('hidden', false);
    } else if (hs === 'interrupted') {
      els.tpsHealthAlert.textContent = `⏹ ${cur.interruptedReason || '会话已中断'}`;
      els.tpsHealthAlert.className = 'health-alert tone-amber';
      els.tpsHealthAlert.classList.toggle('hidden', false);
    } else {
      els.tpsHealthAlert.textContent = '';
      els.tpsHealthAlert.classList.toggle('hidden', true);
    }

    // decode: output / (completed - first chunk), per Artificial Analysis Output Speed / TPOT;
    // e2e: legacy fallback that includes time to first token (runtime cannot read agy's conversation DB).
    const isDecode = cur.tpsMode === 'decode';
    const speedLabel = isDecode ? '生成速度' : '端到端速率';
    setAttr(els.tpsRealtimeLabel, 'title', isDecode
      ? '生成速度 = 输出 token ÷（完成 − 首个分块到达），不含首 token 等待；只统计输出 ≥300 token 且生成 ≥3s 的步骤'
      : '端到端速率 = 输出 token ÷（请求开始 → 结束），含首 token 等待；当前运行环境读不到 agy 会话库时使用');

    if (cur.status === 'generating' && cur.activeStepElapsedMs !== null && cur.activeStepElapsedMs !== undefined) {
      const elapsed = Number(cur.activeStepElapsedMs) + monoDelta;
      els.tpsLiveMeta.textContent = `推理中 ${fmtSec(elapsed)}`;
      els.tpsRealtimeLabel.textContent = `上步${speedLabel}`;
    } else if (cur.status === 'tool_running') {
      els.tpsLiveMeta.textContent = cur.lastDurationMs !== null
        ? `工具执行中 · 上步 ${fmtSec(cur.lastDurationMs)}`
        : '工具执行中';
      els.tpsRealtimeLabel.textContent = speedLabel;
    } else if (isDecode && cur.lastTpsGenMs !== null && cur.lastTpsGenMs !== undefined) {
      els.tpsLiveMeta.textContent = `首 token ${fmtSec(cur.lastTpsTtftMs)} · 生成 ${fmtSec(cur.lastTpsGenMs)} · ${fmtTokens(cur.lastTpsOutputTokens || 0)} 输出`;
      els.tpsRealtimeLabel.textContent = speedLabel;
    } else if (!isDecode && cur.lastDurationMs !== null && cur.lastDurationMs !== undefined) {
      els.tpsLiveMeta.textContent = `最近步 ${fmtSec(cur.lastDurationMs)} · ${fmtTokens(cur.lastOutputTokens || 0)} 输出`;
      els.tpsRealtimeLabel.textContent = speedLabel;
    } else {
      els.tpsLiveMeta.textContent = isDecode ? '暂无足够长的生成步骤' : '等待推理步骤';
      els.tpsRealtimeLabel.textContent = speedLabel;
    }
  }

  function renderTpsCard(cur) {
    const lastTps = Number(cur.lastTps || 0);
    const avgTps = Number(cur.avgTps || 0);
    const peakTps = Number(cur.peakTps || 0);

    const isDecode = cur.tpsMode === 'decode';
    // In decode mode 0 means "no measurable step yet", not zero speed.
    const fmtSpeed = (v) => (isDecode && !(v > 0) ? '--' : v.toFixed(1));
    els.tpsRealtime.textContent = fmtSpeed(lastTps);
    els.tpsAvg.textContent = fmtSpeed(avgTps);
    els.tpsPeak.textContent = fmtSpeed(peakTps);

    const cappedPeak = avgTps > 0 ? Math.min(peakTps, avgTps * 2.2) : peakTps;
    const maxScale = Math.max(80, cappedPeak * 1.15, lastTps * 1.15);
    const ratio = lastTps > 0 ? Math.min(1, Math.max(0.03, lastTps / maxScale)) : 0;
    const drawLen = ratio * GAUGE_ARC_LEN;
    setAttr(els.tpsGaugeArc, 'stroke-dasharray', `${drawLen.toFixed(2)} 240`);
    setAttr(els.tpsGaugeArc, 'stroke-opacity', lastTps > 0 ? '1' : '0');

    if (avgTps > 0 && lastTps > 0) {
      const diffPct = ((lastTps - avgTps) / avgTps) * 100;
      const sign = diffPct >= 0 ? '+' : '';
      els.tpsDeltaVsAvg.textContent = `较均速 ${sign}${diffPct.toFixed(1)}%`;
      els.tpsDeltaVsAvg.className = diffPct >= 0 ? 'tps-stat-sub tone-green-text' : 'tps-stat-sub tone-amber-text';
    } else {
      els.tpsDeltaVsAvg.textContent = '相对均速 --';
      els.tpsDeltaVsAvg.className = 'tps-stat-sub';
    }

    if (isDecode) {
      const ttftNote = cur.medianTtftMs !== null && cur.medianTtftMs !== undefined ? ` · 首 token 中位 ${fmtSec(cur.medianTtftMs)}` : '';
      els.tpsAvgSub.textContent = `${Number(cur.tpsSampleSteps || 0)} 步加权${ttftNote}`;
    } else {
      els.tpsAvgSub.textContent = cur.stepCount > 0 ? `端到端 · ${cur.stepCount} 步加权` : '端到端 · 全会话加权';
    }
    updateTpsLiveBadge();
    renderTpsSparkline(cur.steps || [], avgTps);
  }

  function updateTokenCenterLabel(cur) {
    if (!cur) {
      els.totalTokens.textContent = '0';
      els.tokenDonutSub.textContent = '总消耗';
      return;
    }
    const total = Number(cur.totalTokens || 0);
    if (hoveredSeg === 'cache') {
      els.totalTokens.textContent = fmtTokens(cur.totalCacheReadTokens || 0);
      els.tokenDonutSub.textContent = '缓存读取';
    } else if (hoveredSeg === 'input') {
      els.totalTokens.textContent = fmtTokens(cur.totalInputTokens || 0);
      els.tokenDonutSub.textContent = '新增输入';
    } else if (hoveredSeg === 'output') {
      els.totalTokens.textContent = fmtTokens(cur.totalOutputTokens || 0);
      els.tokenDonutSub.textContent = '模型输出';
    } else {
      els.totalTokens.textContent = fmtTokens(total);
      els.tokenDonutSub.textContent = '总消耗';
    }
  }

  function renderTokenCard(cur) {
    const total = Number(cur.totalTokens || 0);
    const cacheTok = Number(cur.totalCacheReadTokens || 0);
    const inTok = Number(cur.totalInputTokens || 0);
    const outTok = Number(cur.totalOutputTokens || 0);
    const compactTok = Number(cur.compactionTotalTokens || 0);
    const turns = Number(cur.currentTurnIndex || 0);
    const calls = Number(cur.stepCount || 0);
    const compactCount = Number(cur.compactionStats?.count || 0);
    const promptTotal = inTok + cacheTok;
    const sessionCacheHit = promptTotal > 0 ? ((cacheTok / promptTotal) * 100).toFixed(1) : '0.0';

    els.tokenCacheHit.textContent = `累计缓存命中 ${sessionCacheHit}%`;
    updateTokenCenterLabel(cur);

    const cacheRatio = total > 0 ? cacheTok / total : 0;
    const inRatio = total > 0 ? inTok / total : 0;
    const outRatio = total > 0 ? outTok / total : 0;

    applyDonutSegments(
      [
        { el: els.donutTokCache, ratio: cacheRatio },
        { el: els.donutTokInput, ratio: inRatio },
        { el: els.donutTokOutput, ratio: outRatio },
      ],
      { fullCircle: true, gapPx: 2.6, minArcPx: 5 }
    );

    setWidth(els.bgTokCache, cacheRatio * 100);
    setWidth(els.bgTokInput, inRatio * 100);
    setWidth(els.bgTokOutput, outRatio * 100);

    els.tokCache.textContent = fmtTokens(cacheTok);
    els.tokCachePct.textContent = fmtPct(cacheTok, total);
    els.tokInput.textContent = fmtTokens(inTok);
    els.tokInputPct.textContent = fmtPct(inTok, total);
    els.tokOutput.textContent = fmtTokens(outTok);
    els.tokOutputPct.textContent = fmtPct(outTok, total);

    const subParts = [`${turns} 轮对话`, `${calls} 次推理`];
    if (compactCount > 0 && compactTok > 0) {
      subParts.push(`含压缩消耗 ${fmtTokens(compactTok)}`);
    }
    els.tokenSubMeta.textContent = subParts.join(' · ');
  }

  function updateCacheLiveCountdown() {
    const cur = latestSnapshot?.current;
    const cs = cur?.cacheStats;
    if (!cur || !cs || !cs.lastRefreshAtMs) {
      els.cacheStateBadge.textContent = '等待建缓';
      els.cacheStateBadge.className = 'ctx-cache-pill tone-muted';
      els.cacheCountdownLabel.textContent = '暂无记录';
      els.cacheCountdownVal.textContent = '--:--';
      els.cacheCountdownVal.className = 'ctx-cache-timer';
      els.cacheTtlFill.className = 'ctx-cache-fill tone-muted';
      setWidth(els.cacheTtlFill, 0);
      return;
    }

    const nowMono = typeof performance !== 'undefined' ? performance.now() : 0;
    const monoDelta = Math.max(0, nowMono - snapshotMonoMs);
    const baseIdle = cs.idleMs !== null && cs.idleMs !== undefined ? Number(cs.idleMs) : 0;
    const liveIdleMs = cs.isActiveKeepAlive ? 0 : baseIdle + monoDelta;
    const hotMs = Math.max(60000, Number(cs.hotWindowMs || 180000));
    const softMs = Math.max(hotMs, Number(cs.softWindowMs || 300000));
    const expireMs = Math.max(softMs, Number(cs.expireWindowMs || 1800000));
    const isFixed = cs.mode === 'fixed';

    if (cs.isActiveKeepAlive) {
      els.cacheStateBadge.textContent = '活跃保鲜中';
      els.cacheStateBadge.className = 'ctx-cache-pill tone-blue';
      els.cacheCountdownLabel.textContent = '持续刷新';
      els.cacheCountdownVal.textContent = '活跃';
      els.cacheCountdownVal.className = 'ctx-cache-timer';
      els.cacheTtlFill.className = 'ctx-cache-fill tone-blue';
      setWidth(els.cacheTtlFill, 100);
      return;
    }

    if (isFixed) {
      const remMs = Math.max(0, hotMs - liveIdleMs);
      const pct = (remMs / hotMs) * 100;
      if (remMs <= 0) {
        els.cacheStateBadge.textContent = '已过期';
        els.cacheStateBadge.className = 'ctx-cache-pill tone-red';
        els.cacheCountdownLabel.textContent = '已静置';
        els.cacheCountdownVal.textContent = fmtDurationBrief(liveIdleMs);
        els.cacheCountdownVal.className = 'ctx-cache-timer tone-red-text';
        els.cacheTtlFill.className = 'ctx-cache-fill tone-red';
        setWidth(els.cacheTtlFill, 0);
      } else {
        const tone = remMs <= 90000 ? 'amber' : 'green';
        els.cacheStateBadge.textContent = tone === 'amber' ? '即将过期' : '缓存有效';
        els.cacheStateBadge.className = `ctx-cache-pill tone-${tone}`;
        els.cacheCountdownLabel.textContent = '过期倒计时';
        els.cacheCountdownVal.textContent = fmtMmSs(remMs);
        els.cacheCountdownVal.className = `ctx-cache-timer tone-${tone}-text`;
        els.cacheTtlFill.className = `ctx-cache-fill tone-${tone}`;
        setWidth(els.cacheTtlFill, pct);
      }
      return;
    }

    // Implicit cache (Gemini): 0-3m hot, 3-5m decay warning, 5-30m weak, >30m expired
    if (liveIdleMs < hotMs) {
      const remHot = hotMs - liveIdleMs;
      const pct = Math.max(4, (remHot / hotMs) * 100);
      els.cacheStateBadge.textContent = '热缓存';
      els.cacheStateBadge.className = 'ctx-cache-pill tone-green';
      els.cacheCountdownLabel.textContent = '热区倒计时';
      els.cacheCountdownVal.textContent = fmtMmSs(remHot);
      els.cacheCountdownVal.className = 'ctx-cache-timer tone-green-text';
      els.cacheTtlFill.className = 'ctx-cache-fill tone-green';
      setWidth(els.cacheTtlFill, pct);
    } else if (liveIdleMs < softMs) {
      const remSoft = softMs - liveIdleMs;
      const span = Math.max(1, softMs - hotMs);
      const pct = Math.max(8, (remSoft / span) * 45);
      els.cacheStateBadge.textContent = '衰减临界';
      els.cacheStateBadge.className = 'ctx-cache-pill tone-amber';
      els.cacheCountdownLabel.textContent = '衰变倒计时';
      els.cacheCountdownVal.textContent = fmtMmSs(remSoft);
      els.cacheCountdownVal.className = 'ctx-cache-timer tone-amber-text';
      els.cacheTtlFill.className = 'ctx-cache-fill tone-amber';
      setWidth(els.cacheTtlFill, pct);
    } else if (liveIdleMs < expireMs) {
      const remExp = expireMs - liveIdleMs;
      const pct = Math.max(5, (remExp / Math.max(1, expireMs - softMs)) * 22);
      els.cacheStateBadge.textContent = '易失效';
      els.cacheStateBadge.className = 'ctx-cache-pill tone-red';
      els.cacheCountdownLabel.textContent = '已静置';
      els.cacheCountdownVal.textContent = fmtDurationBrief(liveIdleMs);
      els.cacheCountdownVal.className = 'ctx-cache-timer tone-red-text';
      els.cacheTtlFill.className = 'ctx-cache-fill tone-red';
      setWidth(els.cacheTtlFill, pct);
    } else {
      els.cacheStateBadge.textContent = '预计已失效';
      els.cacheStateBadge.className = 'ctx-cache-pill tone-red';
      els.cacheCountdownLabel.textContent = '已静置';
      els.cacheCountdownVal.textContent = fmtDurationBrief(liveIdleMs);
      els.cacheCountdownVal.className = 'ctx-cache-timer tone-red-text';
      els.cacheTtlFill.className = 'ctx-cache-fill tone-red';
      setWidth(els.cacheTtlFill, 0);
    }
  }

  function renderCacheCard(cur) {
    const cs = cur.cacheStats || {};
    const parts = [];
    if (cs.hint) parts.push(cs.hint);
    if (cs.lastRefreshAtMs) parts.push(`上次刷新 ${fmtClock(cs.lastRefreshAtMs)}`);
    if (Number(cs.missCount || 0) > 0) {
      parts.push(`本会话过期重建 ${cs.missCount} 次（重算 ${fmtTokens(cs.missRecomputeTokens || 0)}）`);
    }
    setAttr(els.ctxCacheStrip, 'title', parts.join(' · '));
    updateCacheLiveCountdown();
  }

  function allocateGridCells(items, totalCells = 100) {
    const sum = items.reduce((acc, it) => acc + Math.max(0, Number(it.tokens || 0)), 0);
    if (sum <= 0) {
      return items.map((it) => (it.key === 'free' ? totalCells : 0));
    }
    const exact = items.map((it) => (Math.max(0, Number(it.tokens || 0)) / sum) * totalCells);
    const floors = exact.map((v, idx) => {
      if (items[idx].tokens > 0 && items[idx].used && v > 0 && v < 1) return 1;
      return Math.floor(v);
    });
    let usedSum = floors.reduce((a, b) => a + b, 0);
    const remainders = exact.map((v, idx) => ({ idx, rem: v - Math.floor(v) }));

    if (usedSum < totalCells) {
      remainders.sort((a, b) => b.rem - a.rem);
      for (let i = 0; i < remainders.length && usedSum < totalCells; i++) {
        floors[remainders[i].idx] += 1;
        usedSum += 1;
      }
    } else if (usedSum > totalCells) {
      // Shave excess from largest buckets (preferring free/reserve first)
      const order = items
        .map((it, idx) => ({ idx, pref: it.used ? 0 : 1, count: floors[idx] }))
        .sort((a, b) => b.pref - a.pref || b.count - a.count);
      let guard = 0;
      while (usedSum > totalCells && guard < 200) {
        guard += 1;
        for (const o of order) {
          if (usedSum <= totalCells) break;
          if (floors[o.idx] > (items[o.idx].used ? 1 : 0)) {
            floors[o.idx] -= 1;
            usedSum -= 1;
          }
        }
      }
    }
    return floors;
  }

  function renderContextCard(cur) {
    const ctx = cur.contextStats || {};
    const currentTokens = Number(ctx.currentTokens || 0);
    const windowLimit = Math.max(1, Number(ctx.windowLimitTokens || 1000000));
    const compactLimit = Math.max(1, Number(ctx.compactionThresholdTokens || ctx.referenceLimitTokens || 512000));
    const windowPct = Number(ctx.windowUsagePct !== undefined ? ctx.windowUsagePct : (currentTokens / windowLimit) * 100);
    const compactPct = Number(ctx.compactionUsagePct !== undefined ? ctx.compactionUsagePct : (currentTokens / compactLimit) * 100);
    const justCompacted = Boolean(ctx.justCompacted);
    const tone = justCompacted ? 'blue' : getUsageTone(compactPct);
    const bd = ctx.breakdown || {};

    els.ctxCompactedBanner.classList.toggle('hidden', !justCompacted);
    els.ctxHeadRatio.textContent = justCompacted
      ? `已重置 / ${fmtTokens(windowLimit)}`
      : `${fmtTokens(currentTokens)} / ${fmtTokens(windowLimit)}`;

    if (justCompacted) {
      els.ctxPctPill.textContent = '刚压缩';
      els.ctxPctPill.className = 'pct-pill tone-blue';
    } else {
      els.ctxPctPill.textContent = `${windowPct.toFixed(1)}%`;
      els.ctxPctPill.className = `pct-pill tone-${tone}`;
    }

    setAttr(els.ctxProgressTrack, 'aria-valuenow', Math.round(Math.min(100, windowPct)));

    const cellUnit = windowLimit / 100;
    const hasReserve = windowLimit > compactLimit;
    els.cliGridFoot.textContent = hasReserve
      ? `每格 ≈ ${fmtTokens(cellUnit)} · 约 ${fmtTokens(compactLimit)} 自动压缩`
      : `每格 ≈ ${fmtTokens(cellUnit)} · 模型总窗口 ${fmtTokens(windowLimit)}`;

    const categories = [
      { key: 'sys', sym: '⛁', label: '系统/工具', tokens: Number(bd.systemTokens || 0), used: true, always: true },
      { key: 'ckpt', sym: '⊠', label: '压缩摘要', tokens: Number(bd.checkpointTokens || 0), used: true, always: false },
      { key: 'user', sym: '◉', label: '用户消息', tokens: Number(bd.userTokens || 0), used: true, always: true },
      { key: 'assistant', sym: '◉', label: '模型回复', tokens: Number(bd.assistantTokens || 0), used: true, always: true },
      { key: 'tool', sym: '◉', label: '工具输出', tokens: Number(bd.toolTokens || 0), used: true, always: true },
      { key: 'free', sym: '□', label: hasReserve ? '距压缩可用' : '剩余可用', tokens: Number(bd.freeToCompactTokens !== undefined ? bd.freeToCompactTokens : Math.max(0, compactLimit - currentTokens)), used: false, always: true, muted: true },
      { key: 'reserve', sym: '⊠', label: '压缩保留区', tokens: Number(bd.compactReserveTokens !== undefined ? bd.compactReserveTokens : Math.max(0, windowLimit - Math.max(currentTokens, compactLimit))), used: false, always: false, muted: true },
    ];

    const visibleCats = categories.filter((c) => c.always || c.tokens > 0);
    const cellCounts = allocateGridCells(visibleCats, 100);
    const denom = Math.max(windowLimit, currentTokens);

    // Render 10x10 CLI-style proportional cell grid (diff-guarded to preserve hover)
    const gridCells = [];
    for (let i = 0; i < visibleCats.length; i++) {
      const cat = visibleCats[i];
      const count = cellCounts[i];
      for (let j = 0; j < count; j++) {
        gridCells.push(`<span class="cli-cell cat-${cat.key}" title="${escapeHtml(cat.label)}: ${escapeHtml(fmtTokens(cat.tokens))}"></span>`);
      }
    }
    const nextGridHtml = gridCells.join('');
    if (renderCache.ctxGrid !== nextGridHtml) {
      renderCache.ctxGrid = nextGridHtml;
      els.cliCtxGrid.innerHTML = nextGridHtml;
    }

    // Render right-side CLI category breakdown list
    const listHtml = [];
    let insertedSep = false;
    for (const cat of visibleCats) {
      if (!cat.used && !insertedSep) {
        listHtml.push('<div class="cli-cat-sep"></div>');
        insertedSep = true;
      }
      const pct = denom > 0 ? ((cat.tokens / denom) * 100).toFixed(1) : '0.0';
      listHtml.push(`<div class="cli-cat-row${cat.muted ? ' is-muted' : ''}" data-cat="${cat.key}">
        <span class="cli-cat-left">
          <span class="cli-sym sym-${cat.key}">${cat.sym}</span>
          <span class="cli-cat-name">${escapeHtml(cat.label)}</span>
        </span>
        <span class="cli-cat-right">
          <span class="cli-cat-val">${escapeHtml(fmtTokens(cat.tokens))}</span>
          <span class="cli-cat-pct">${pct}%</span>
        </span>
      </div>`);
    }
    const nextCatHtml = listHtml.join('');
    if (renderCache.ctxCat !== nextCatHtml) {
      renderCache.ctxCat = nextCatHtml;
      els.cliCatList.innerHTML = nextCatHtml;
      if (els.cliCatList && typeof els.cliCatList.querySelectorAll === 'function') {
        els.cliCatList.querySelectorAll('.cli-cat-row').forEach((row) => {
          const key = row.getAttribute('data-cat') || '';
          row.addEventListener('mouseenter', () => {
            if (els.contextCard && typeof els.contextCard.setAttribute === 'function') {
              els.contextCard.setAttribute('data-hover-cat', key);
            }
          });
          row.addEventListener('mouseleave', () => {
            if (els.contextCard && typeof els.contextCard.removeAttribute === 'function') {
              els.contextCard.removeAttribute('data-hover-cat');
            }
          });
        });
      }
    }

    const hitStr = justCompacted ? '--' : `${Number(ctx.cacheHitRate || 0).toFixed(1)}%`;
    const deltaStr = justCompacted ? '已释放' : fmtSignedTokens(ctx.lastDeltaTokens);
    const peakStr = fmtTokens(ctx.peakTokens || 0);
    els.cliCtxMeta.textContent = `缓存命中 ${hitStr} · 上步 ${deltaStr} · 峰值 ${peakStr}`;

    // Render on-demand Top 3 heavy context consumers (collapsed by default)
    const consumers = Array.isArray(ctx.topConsumers) ? ctx.topConsumers : [];
    if (consumers.length === 0) {
      els.topConsumersBox.classList.toggle('hidden', true);
      if (renderCache.topConsumers !== '') {
        renderCache.topConsumers = '';
        els.topConsumersList.innerHTML = '';
      }
    } else {
      els.topConsumersBox.classList.toggle('hidden', false);
      const topSum = consumers.reduce((acc, c) => acc + Number(c.deltaTokens || 0), 0);
      const maxDelta = Math.max(1, Number(consumers[0].deltaTokens || 1));
      els.topConsumersSummary.textContent = `大块占用 Top ${consumers.length}（合计 +${fmtTokens(topSum)}）`;
      const nextConsumerHtml = consumers
        .map((c, idx) => {
          const pct = Math.max(8, Math.min(100, (Number(c.deltaTokens || 0) / maxDelta) * 100));
          return `<div class="consumer-row" title="${escapeHtml(c.label)}">
            <span class="consumer-bar" style="width:${pct.toFixed(1)}%"></span>
            <span class="consumer-left">
              <span class="consumer-rank">#${idx + 1}</span>
              <span class="consumer-label">${escapeHtml(c.label)}</span>
            </span>
            <span class="consumer-right">
              <span class="consumer-step">#${c.stepIndex}</span>
              <span class="consumer-val">+${escapeHtml(fmtTokens(c.deltaTokens))}</span>
            </span>
          </div>`;
        })
        .join('');
      if (renderCache.topConsumers !== nextConsumerHtml) {
        renderCache.topConsumers = nextConsumerHtml;
        els.topConsumersList.innerHTML = nextConsumerHtml;
      }
    }
  }

  function renderSparkline(ctx) {
    const history = Array.isArray(ctx.history) ? ctx.history : [];
    const limitTokens = Math.max(1, Number(ctx.referenceLimitTokens || 512000));
    const limitLabel = ctx.referenceLimitLabel || '压缩参考线';
    els.sparkLimitLabel.textContent = `${limitLabel} ${fmtTokens(limitTokens)}`;

    const W = 420;
    const H = 64;
    const padX = 6;
    const padTop = 8;
    const padBottom = 6;
    const plotW = W - padX * 2;
    const plotH = H - padTop - padBottom;
    const maxVal = Math.max(limitTokens * 1.06, ...history.map((p) => Number(p.tokens || 0)));

    const yFor = (val) => {
      const clamped = Math.max(0, Math.min(maxVal, Number(val || 0)));
      return padTop + plotH * (1 - clamped / maxVal);
    };

    const limitY = yFor(limitTokens).toFixed(1);
    const midY = yFor(limitTokens * 0.5).toFixed(1);
    const gridLines = [
      `<line x1="${padX}" y1="${limitY}" x2="${W - padX}" y2="${limitY}" stroke="currentColor" stroke-opacity="0.28" stroke-width="1" stroke-dasharray="4 3"/>`,
      `<line x1="${padX}" y1="${midY}" x2="${W - padX}" y2="${midY}" stroke="currentColor" stroke-opacity="0.09" stroke-width="1" stroke-dasharray="2 4"/>`,
    ].join('');

    if (history.length === 0) {
      const emptySpark = `${gridLines}<text x="${W / 2}" y="${H / 2 + 4}" text-anchor="middle" fill="currentColor" fill-opacity="0.45" font-size="11">等待推理步骤记录上下文轨迹…</text>`;
      if (renderCache.ctxSpark !== emptySpark) {
        renderCache.ctxSpark = emptySpark;
        els.ctxSparkline.innerHTML = emptySpark;
      }
      return;
    }

    const stepX = history.length > 1 ? plotW / (history.length - 1) : 0;
    const pts = history.map((p, idx) => ({
      x: history.length === 1 ? W * 0.5 : padX + idx * stepX,
      y: yFor(p.tokens),
      isCompaction: Boolean(p.isCompaction),
    }));

    const linePath = pts.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ');
    const areaPath = history.length > 1
      ? `${linePath} L${pts[pts.length - 1].x.toFixed(1)},${(H - padBottom).toFixed(1)} L${pts[0].x.toFixed(1)},${(H - padBottom).toFixed(1)} Z`
      : '';

    const lastPt = pts[pts.length - 1];
    const compactPctVal = ctx.compactionUsagePct !== undefined ? ctx.compactionUsagePct : (ctx.usagePct || 0);
    const tone = getUsageTone(compactPctVal);
    const strokeCol = tone === 'red' ? '#ef4444' : tone === 'amber' ? '#f59e0b' : '#0284c7';

    const compactionDots = pts
      .filter((p) => p.isCompaction)
      .map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.8" fill="#10b981" stroke="var(--card-bg, #ffffff)" stroke-width="1.5"/>`)
      .join('');

    const nextSparkHtml = [
      `<defs><linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${strokeCol}" stop-opacity="0.24"/><stop offset="100%" stop-color="${strokeCol}" stop-opacity="0.01"/></linearGradient></defs>`,
      gridLines,
      areaPath ? `<path d="${areaPath}" fill="url(#sparkGrad)"/>` : '',
      history.length > 1 ? `<path d="${linePath}" fill="none" stroke="${strokeCol}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>` : '',
      compactionDots,
      `<circle cx="${lastPt.x.toFixed(1)}" cy="${lastPt.y.toFixed(1)}" r="6.5" fill="${strokeCol}" fill-opacity="0.16"/>`,
      `<circle cx="${lastPt.x.toFixed(1)}" cy="${lastPt.y.toFixed(1)}" r="3.6" fill="${strokeCol}" stroke="var(--card-bg, #ffffff)" stroke-width="1.5"/>`,
    ].join('');
    if (renderCache.ctxSpark !== nextSparkHtml) {
      renderCache.ctxSpark = nextSparkHtml;
      els.ctxSparkline.innerHTML = nextSparkHtml;
    }
  }

  function renderCompactionSummary(cur) {
    const ctx = cur.contextStats || {};
    const comp = cur.compactionStats || {};
    const count = Number(comp.count || 0);
    const records = Array.isArray(comp.records) ? comp.records : [];
    const currentTokens = Number(ctx.currentTokens || 0);

    renderSparkline(ctx);

    if (count === 0) {
      els.compactCountBadge.classList.toggle('hidden', true);
      els.compactHistoryBox.classList.toggle('hidden', true);
      if (renderCache.compactList !== '') {
        renderCache.compactList = '';
        els.compactList.innerHTML = '';
      }

      if (ctx.recentAvgGrowthTokens > 0 && ctx.estimatedStepsToCompaction > 0) {
        els.compactPaceLine.textContent = `近期均增 +${fmtTokens(ctx.recentAvgGrowthTokens)}/步 · 预计约 ${ctx.estimatedStepsToCompaction} 步后触达压缩线`;
      } else if (currentTokens > 0) {
        els.compactPaceLine.textContent = '尚未触发自动压缩 · 当前上下文增速平稳';
      } else {
        els.compactPaceLine.textContent = '尚未触发自动压缩 · 等待上下文增长数据';
      }
      return;
    }

    const latest = comp.latest || records[records.length - 1] || null;
    const totalSaved = Number(comp.totalSavedTokens || 0);
    const totalCost = Number(comp.totalCompactionTokens || 0);

    els.compactCountBadge.textContent = `已压缩 ${count} 次`;
    els.compactCountBadge.classList.toggle('hidden', false);
    els.compactHistoryBox.classList.toggle('hidden', false);

    if (ctx.recentAvgGrowthTokens > 0 && ctx.estimatedStepsToCompaction > 0) {
      els.compactPaceLine.textContent = `压缩后推进 ${ctx.stepsSinceLastCompaction || 0} 步 · 均增 +${fmtTokens(ctx.recentAvgGrowthTokens)}/步 · 距下次约 ${ctx.estimatedStepsToCompaction} 步`;
    } else {
      els.compactPaceLine.textContent = `最近压缩于 Step #${latest?.stepIndex ?? '--'} · 累计释放 ${totalSaved > 0 ? fmtTokens(totalSaved) : '--'}`;
    }

    const ratioText =
      latest && latest.reductionPct !== null && latest.reductionPct !== undefined
        ? `最近 -${Number(latest.reductionPct).toFixed(1)}%`
        : '刚刚完成';
    const costText = totalCost > 0 ? ` · 压缩耗 ${fmtTokens(totalCost)}` : '';
    els.compactHistorySummary.textContent = `压缩记录（${count} 次 · ${ratioText} · 累计释放 ${totalSaved > 0 ? fmtTokens(totalSaved) : '--'}${costText}）`;

    const nextListHtml = [...records]
      .reverse()
      .map((rec) => {
        const beforeStr = rec.beforeContextTokens ? fmtTokens(rec.beforeContextTokens) : '未知';
        const afterStr = rec.afterContextTokens ? fmtTokens(rec.afterContextTokens) : '待下一步刷新';
        const flowText =
          rec.beforeContextTokens || rec.afterContextTokens
            ? `${beforeStr} → ${afterStr}`
            : '已记录压缩点（未包含 Token 数值）';
        const ratioHtml =
          rec.reductionPct !== null && rec.reductionPct !== undefined
            ? `<span class="compact-ratio">-${Number(rec.reductionPct).toFixed(1)}%</span>`
            : '';
        const keptPct =
          rec.beforeContextTokens > 0 && rec.afterContextTokens > 0
            ? Math.max(3, Math.min(100, (rec.afterContextTokens / rec.beforeContextTokens) * 100))
            : 0;
        const barHtml = keptPct > 0
          ? `<div class="compact-bar-pair" title="浅绿为释放空间，蓝色为压缩后保留占比"><div class="compact-bar-track"><div class="compact-bar-after" style="width:${keptPct.toFixed(1)}%"></div></div></div>`
          : '';
        const metaParts = [];
        if (rec.savedTokens) metaParts.push(`释放 ${fmtTokens(rec.savedTokens)}`);
        if (rec.outputTokens) metaParts.push(`摘要 ${fmtTokens(rec.outputTokens)}`);
        if (rec.totalTokens) metaParts.push(`耗费 ${fmtTokens(rec.totalTokens)}`);
        const subLine = metaParts.length ? metaParts.join(' · ') : `第 ${rec.turnIndex || 1} 轮`;

        return `<div class="compact-item">
          <div class="compact-item-top">
            <span class="compact-item-title">#${rec.index} ${escapeHtml(rec.label || '上下文压缩')}</span>
            <span class="compact-item-time">Step #${rec.stepIndex} · ${escapeHtml(fmtClock(rec.atMs))}</span>
          </div>
          <div class="compact-item-flow">
            <span>${escapeHtml(flowText)}</span>
            ${ratioHtml}
          </div>
          ${barHtml}
          <div class="compact-item-sub">${escapeHtml(subLine)}</div>
        </div>`;
      })
      .join('');
    if (renderCache.compactList !== nextListHtml) {
      renderCache.compactList = nextListHtml;
      els.compactList.innerHTML = nextListHtml;
    }
  }

  function renderEmpty() {
    renderStatus(null);
    els.sessionTitle.textContent = '当前暂无活跃会话记录';
    els.modelName.textContent = '--';

    els.tpsRealtime.textContent = '0.0';
    els.tpsAvg.textContent = '0.0';
    els.tpsPeak.textContent = '0.0';
    els.tpsDeltaVsAvg.textContent = '相对均速 --';
    els.tpsAvgSub.textContent = '全会话加权均速';
    els.tpsLiveMeta.textContent = '等待推理步骤';
    els.tpsHealthAlert.textContent = '';
    els.tpsHealthAlert.classList.toggle('hidden', true);
    els.sessionDuration.textContent = '历时 --';
    setAttr(els.tpsGaugeArc, 'stroke-dasharray', '0 240');
    setAttr(els.tpsGaugeArc, 'stroke-opacity', '0');
    renderTpsSparkline([], 0);

    els.tokenCacheHit.textContent = '累计缓存命中 0.0%';
    updateTokenCenterLabel(null);
    applyDonutSegments(
      [
        { el: els.donutTokCache, ratio: 0 },
        { el: els.donutTokInput, ratio: 0 },
        { el: els.donutTokOutput, ratio: 0 },
      ],
      { fullCircle: true }
    );
    setWidth(els.bgTokCache, 0);
    setWidth(els.bgTokInput, 0);
    setWidth(els.bgTokOutput, 0);
    els.tokCache.textContent = '0';
    els.tokCachePct.textContent = '0.0%';
    els.tokInput.textContent = '0';
    els.tokInputPct.textContent = '0.0%';
    els.tokOutput.textContent = '0';
    els.tokOutputPct.textContent = '0.0%';
    els.tokenSubMeta.textContent = '0 轮对话 · 0 次推理';

    renderCacheCard({ cacheStats: {} });
    renderContextCard({ contextStats: {}, compactionStats: {} });
    renderCompactionSummary({ contextStats: {}, compactionStats: { count: 0, records: [] } });
  }

  function renderSnapshot(data, resetMono = true) {
    if (data && data.assetVersion) {
      if (
        knownAssetVersion &&
        knownAssetVersion !== data.assetVersion &&
        window.location &&
        typeof window.location.reload === 'function'
      ) {
        window.location.reload();
        return;
      }
      knownAssetVersion = data.assetVersion;
    }
    latestSnapshot = data;
    if (resetMono && typeof performance !== 'undefined') {
      snapshotMonoMs = performance.now();
    }
    if (data?.prefs && (data.prefs.tokenFormat === 'M' || data.prefs.tokenFormat === 'raw')) {
      tokenFormat = data.prefs.tokenFormat;
    }
    els.btnUnitToggle.textContent = tokenFormat === 'M' ? '单位: K/M ⇄' : '单位: 精确 ⇄';

    const cur = data?.current;
    if (!cur) {
      renderEmpty();
      return;
    }

    renderStatus(cur);
    const titleStr = cur.title || `会话 ${String(cur.conversationId || '').slice(0, 8)}`;
    els.sessionTitle.textContent = titleStr;
    setAttr(els.sessionTitle, 'title', titleStr);
    els.modelName.textContent = cur.modelName || '--';

    renderTpsCard(cur);
    renderTokenCard(cur);
    renderCacheCard(cur);
    renderContextCard(cur);
    renderCompactionSummary(cur);
  }

  async function handleToggleTokenUnit() {
    tokenFormat = tokenFormat === 'M' ? 'raw' : 'M';
    if (latestSnapshot) renderSnapshot(latestSnapshot, false);
    try {
      const res = await apiFetch('/api/prefs', { tokenFormat });
      if (res && res.ok) {
        const saved = await res.json();
        if (saved && saved.tokenFormat) tokenFormat = saved.tokenFormat;
      }
    } catch {}
  }

  els.btnUnitToggle.addEventListener('click', handleToggleTokenUnit);
  els.tokenHero.addEventListener('click', handleToggleTokenUnit);

  if (els.tokenLegend && typeof els.tokenLegend.querySelectorAll === 'function') {
    els.tokenLegend.querySelectorAll('.legend-row').forEach((row) => {
      const seg = row.getAttribute('data-seg') || '';
      row.addEventListener('mouseenter', () => {
        hoveredSeg = seg;
        if (els.tokenCard) els.tokenCard.className = `card token-card hover-${seg}`;
        updateTokenCenterLabel(latestSnapshot?.current || null);
      });
      row.addEventListener('mouseleave', () => {
        hoveredSeg = '';
        if (els.tokenCard) els.tokenCard.className = 'card token-card';
        updateTokenCenterLabel(latestSnapshot?.current || null);
      });
    });
  }

  async function pollSnapshot() {
    try {
      const res = await apiFetch('/api/snapshot', { conversationId: hostConvId });
      if (!res || !res.ok) return;
      const data = await res.json();
      renderSnapshot(data, true);
    } catch {}
  }

  pollSnapshot();
  setInterval(pollSnapshot, 1200);
  setInterval(() => {
    updateTpsLiveBadge();
    updateCacheLiveCountdown();
  }, 200);
})();
