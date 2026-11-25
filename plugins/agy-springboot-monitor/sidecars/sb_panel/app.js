(function () {
  let latestSnap = null;
  let knownAssetVersion = '';
  let showAllJvms = false;
  let launcherOpen = false;
  let customWsMode = false;
  let currentMeta = null;
  let selectedLocalSet = new Set();

  // Docked full-height Log Console state
  const openLogs = new Map(); // id -> { id, logFile, errOnly, query, text, totalLines, sizeBytes, lastFetch }
  let activeLogId = '';
  let logWrap = true;
  let logAutoScroll = true;
  let logMaximized = false;
  let lastLogTextRendered = '';
  let userDismissedAutoLog = false;
  let programmaticScrollUntil = 0;

  const confirmStopMap = new Map(); // key -> expiresAtMs
  let lastCardsRenderKey = '';

  const els = {
    shell: document.getElementById('app-shell'),
    globalRing: document.getElementById('global-ring'),
    globalPill: document.getElementById('global-pill'),
    btnToggleLauncher: document.getElementById('btn-toggle-launcher'),
    btnRefresh: document.getElementById('btn-refresh'),
    eventBanner: document.getElementById('event-banner'),
    sumUp: document.getElementById('sum-up'),
    sumBusy: document.getElementById('sum-busy'),
    sumMem: document.getElementById('sum-mem'),
    sumPorts: document.getElementById('sum-ports'),
    launcherCard: document.getElementById('launcher-card'),
    launcherPortHint: document.getElementById('launcher-port-hint'),
    wsSelect: document.getElementById('ws-select'),
    wsCustom: document.getElementById('ws-custom'),
    btnWsMode: document.getElementById('btn-ws-mode'),
    dbSelect: document.getElementById('db-select'),
    esSelect: document.getElementById('es-select'),
    eslogSelect: document.getElementById('eslog-select'),
    portInput: document.getElementById('port-input'),
    modChips: document.getElementById('mod-chips'),
    btnModIdea: document.getElementById('btn-mod-idea'),
    btnModStarter: document.getElementById('btn-mod-starter'),
    chkNobuild: document.getElementById('chk-nobuild'),
    chkDebug: document.getElementById('chk-debug'),
    chkSave: document.getElementById('chk-save'),
    launcherStatus: document.getElementById('launcher-status'),
    btnCancelLaunch: document.getElementById('btn-cancel-launch'),
    btnDoLaunch: document.getElementById('btn-do-launch'),
    servicesList: document.getElementById('services-list'),
    emptyCard: document.getElementById('empty-card'),
    quickWsPills: document.getElementById('quick-ws-pills'),
    logConsole: document.getElementById('log-console'),
    logTabs: document.getElementById('log-tabs'),
    logSearch: document.getElementById('log-search'),
    btnLogErr: document.getElementById('btn-log-err'),
    btnLogWrap: document.getElementById('btn-log-wrap'),
    btnLogBottom: document.getElementById('btn-log-bottom'),
    btnLogRefresh: document.getElementById('btn-log-refresh'),
    btnLogMax: document.getElementById('btn-log-max'),
    btnLogClose: document.getElementById('btn-log-close'),
    logFileMeta: document.getElementById('log-file-meta'),
    logLineMeta: document.getElementById('log-line-meta'),
    logPre: document.getElementById('log-pre'),
    chkShowAll: document.getElementById('chk-show-all'),
    scanMeta: document.getElementById('scan-meta')
  };

  // ============================================================
  // Host Theme Sync
  // ============================================================
  function parseColorLuminance(colorStr) {
    const s = String(colorStr || '').trim();
    if (!s) return null;
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (hex) {
      let h = hex[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return 0.2126 * parseInt(h.slice(0, 2), 16) + 0.7152 * parseInt(h.slice(2, 4), 16) + 0.0722 * parseInt(h.slice(4, 6), 16);
    }
    const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s);
    if (rgb) return 0.2126 * Number(rgb[1]) + 0.7152 * Number(rgb[2]) + 0.0722 * Number(rgb[3]);
    return null;
  }

  function syncThemeMode() {
    try {
      const cs = window.getComputedStyle(document.documentElement);
      const rawBg = cs.getPropertyValue('--background') || cs.getPropertyValue('--card') || '';
      const lum = parseColorLuminance(rawBg);
      if (lum !== null) {
        document.documentElement.setAttribute('data-theme', lum < 128 ? 'dark' : 'light');
      }
    } catch {}
  }

  window.addEventListener('message', (event) => {
    if (event && event.data && event.data.type === 'theme-change') {
      setTimeout(syncThemeMode, 0);
    }
  });
  syncThemeMode();

  // ============================================================
  // Sidecar API Helper
  // ============================================================
  function apiFetch(url, bodyObj) {
    if (window.sidecar && typeof window.sidecar.fetch === 'function') {
      return window.sidecar.fetch(url, {
        method: 'POST',
        body: JSON.stringify(bodyObj || {})
      });
    }
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj || {})
    });
  }

  async function apiJson(url, bodyObj) {
    const res = await apiFetch(url, bodyObj);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  let bannerTimer = null;
  function showBanner(level, msg, autoHideMs = 5000) {
    els.eventBanner.className = `event-banner ${level}`;
    els.eventBanner.textContent = msg;
    els.eventBanner.classList.remove('hidden');
    if (bannerTimer) clearTimeout(bannerTimer);
    if (autoHideMs > 0) {
      bannerTimer = setTimeout(() => {
        els.eventBanner.classList.add('hidden');
      }, autoHideMs);
    }
  }

  async function copyText(text, btnEl) {
    try {
      await navigator.clipboard.writeText(text);
      if (btnEl) {
        const old = btnEl.textContent;
        btnEl.textContent = '已复制 ✓';
        setTimeout(() => { btnEl.textContent = old; }, 1200);
      } else {
        showBanner('ok', `已复制: ${text}`, 2200);
      }
    } catch {
      showBanner('info', `地址: ${text}`, 4000);
    }
  }

  // ============================================================
  // Docked Full-Height Log Console
  // ============================================================
  function scrollLogToBottom() {
    const pre = els.logPre;
    if (!pre) return;
    programmaticScrollUntil = Date.now() + 220;
    pre.scrollTop = pre.scrollHeight;
    requestAnimationFrame(() => {
      if (!logAutoScroll) return;
      programmaticScrollUntil = Date.now() + 220;
      pre.scrollTop = pre.scrollHeight;
    });
  }

  function syncFollowButton() {
    if (!els.btnLogBottom) return;
    els.btnLogBottom.classList.toggle('on', logAutoScroll);
    els.btnLogBottom.textContent = logAutoScroll ? '↓ 跟随' : '↓ 置底';
  }

  function syncLogConsoleLayout() {
    const hasLog = openLogs.size > 0 && activeLogId && openLogs.has(activeLogId);
    els.logConsole.classList.toggle('hidden', !hasLog);
    els.shell.classList.toggle('has-log', hasLog);
    els.shell.classList.toggle('log-max', hasLog && logMaximized);
    els.btnLogMax.textContent = logMaximized ? '⤡ 还原' : '⤢ 全屏';
    els.btnLogMax.classList.toggle('on', logMaximized);
    els.btnLogWrap.classList.toggle('on', logWrap);
    els.logPre.classList.toggle('wrap', logWrap);
    syncFollowButton();

    if (!hasLog) return;

    const st = openLogs.get(activeLogId);
    els.btnLogErr.classList.toggle('err-on', Boolean(st.errOnly));
    if (els.logSearch.value !== (st.query || '')) {
      els.logSearch.value = st.query || '';
    }

    // Tabs
    const tabsHtml = [...openLogs.keys()].map((id) =>
      `<button type="button" class="log-tab ${id === activeLogId ? 'active' : ''}" data-log-tab="${esc(id)}">${esc(id)}</button>`
    ).join('');
    if (els.logTabs.innerHTML !== tabsHtml) {
      els.logTabs.innerHTML = tabsHtml;
    }

    els.logFileMeta.textContent = st.logFile || `${st.id}.log`;
    const kb = st.sizeBytes ? `${Math.round(st.sizeBytes / 1024)}KB` : '';
    els.logLineMeta.textContent = st.totalLines ? `共 ${st.totalLines} 行${kb ? ' · ' + kb : ''}` : '';

    const text = st.text || '加载日志中…';
    if (text !== lastLogTextRendered) {
      els.logPre.textContent = text;
      lastLogTextRendered = text;
      if (logAutoScroll) {
        scrollLogToBottom();
      }
    }
  }

  function focusLog(id, logFile, { waitForNewFile = false } = {}) {
    if (!id) return;
    userDismissedAutoLog = false;
    const prev = openLogs.get(id);
    const oldLogFile = prev ? (prev.logFile || '') : '';
    const nextState = prev
      ? { ...prev }
      : {
          id,
          logFile: '',
          errOnly: false,
          query: '',
          text: '加载日志中…',
          totalLines: 0,
          sizeBytes: 0,
          lastFetch: 0
        };

    if (waitForNewFile) {
      // Do NOT keep polling the old stopped log file while waiting for the new launch to create its log file
      nextState.prevLogFile = oldLogFile;
      nextState.pendingNewSince = Date.now();
      nextState.logFile = '';
      nextState.lastSig = '';
      nextState.text = `正在启动 ${id}，等待新日志流…`;
      nextState.totalLines = 0;
      nextState.sizeBytes = 0;
      nextState.lastFetch = 0;
    } else if (logFile) {
      if (logFile !== nextState.logFile) {
        nextState.logFile = logFile;
        nextState.lastSig = '';
        nextState.text = '加载日志中…';
        nextState.lastFetch = 0;
      }
      delete nextState.pendingNewSince;
      delete nextState.prevLogFile;
    }

    openLogs.set(id, nextState);
    activeLogId = id;
    logAutoScroll = true;
    lastLogTextRendered = '';
    syncLogConsoleLayout();
    if (latestSnap) renderServices(latestSnap);
    if (!waitForNewFile) {
      fetchLogsFor(id);
    }
  }

  async function openOrToggleLog(id, logFile) {
    if (openLogs.has(id) && activeLogId === id) {
      openLogs.delete(id);
      const rest = [...openLogs.keys()];
      activeLogId = rest.length > 0 ? rest[rest.length - 1] : '';
      if (!activeLogId) {
        logMaximized = false;
        userDismissedAutoLog = true;
      }
      lastLogTextRendered = '';
      syncLogConsoleLayout();
      if (latestSnap) renderServices(latestSnap);
      return;
    }

    focusLog(id, logFile, { waitForNewFile: false });
  }

  function reconcileOpenLogsWithSnapshot(services) {
    if (!Array.isArray(services) || openLogs.size === 0) return;
    const byId = new Map(services.map((s) => [s.id, s]));
    const now = Date.now();
    const toRemove = [];
    for (const [id, st] of openLogs.entries()) {
      const svc = byId.get(id);
      if (svc && svc.logFile) {
        const isWaitingNew = Boolean(st.pendingNewSince);
        const isStillOld = isWaitingNew && st.prevLogFile && svc.logFile === st.prevLogFile;
        if (!isStillOld && svc.logFile !== st.logFile) {
          st.logFile = svc.logFile;
          delete st.pendingNewSince;
          delete st.prevLogFile;
          st.lastFetch = 0;
          if (id === activeLogId) {
            lastLogTextRendered = '';
            fetchLogsFor(id);
          }
        }
      } else if (!svc && !st.pendingNewSince) {
        // Service has cleanly stopped and its log was destroyed -> auto-close stale tab
        toRemove.push(id);
      } else if (st.pendingNewSince && now - st.pendingNewSince > 12000) {
        // Safety fallback after 12s if launch failed before creating an instance entry
        delete st.pendingNewSince;
        delete st.prevLogFile;
        st.lastFetch = 0;
      }
    }
    if (toRemove.length > 0) {
      for (const id of toRemove) openLogs.delete(id);
      if (!openLogs.has(activeLogId)) {
        const rest = [...openLogs.keys()];
        activeLogId = rest.length > 0 ? rest[rest.length - 1] : '';
        if (!activeLogId) logMaximized = false;
        lastLogTextRendered = '';
        syncLogConsoleLayout();
        if (activeLogId) fetchLogsFor(activeLogId);
      }
    }
  }

  let logFetchInFlight = false;
  async function fetchLogsFor(id) {
    const st = openLogs.get(id);
    if (!st) return;
    if (st.pendingNewSince) {
      // Wait for the newly spawned instance to publish its new logFile (avoid pinning old log!)
      return;
    }
    if (logFetchInFlight && id === activeLogId) return;
    if (id === activeLogId) logFetchInFlight = true;
    try {
      const liveSvc = latestSnap && Array.isArray(latestSnap.services)
        ? latestSnap.services.find((s) => s.id === id)
        : null;
      const effectiveLogFile = (liveSvc && liveSvc.logFile) ? liveSvc.logFile : (st.logFile || '');
      const res = await apiJson('/api/logs', {
        id,
        logFile: effectiveLogFile,
        lines: 300,
        errOnly: st.errOnly,
        query: st.query || '',
        lastSig: st.lastSig || ''
      });
      if (res && res.unchanged) {
        st.lastFetch = Date.now();
        return;
      }
      let logText = res.text || '(空日志)';
      if (st.query && st.query.trim()) {
        const q = st.query.trim().toLowerCase();
        const filtered = logText.split(/\r?\n/).filter((l) => l.toLowerCase().includes(q));
        logText = filtered.length > 0 ? filtered.join('\n') : `(未匹配关键词 "${st.query.trim()}")`;
      }
      st.text = logText;
      if (res.logFile) st.logFile = res.logFile;
      st.lastSig = res.sig || '';
      st.totalLines = res.totalLines || 0;
      st.sizeBytes = res.sizeBytes || 0;
      st.lastFetch = Date.now();
      if (id === activeLogId) syncLogConsoleLayout();
    } catch (err) {
      st.text = `读取日志失败: ${err.message}`;
      if (id === activeLogId) syncLogConsoleLayout();
    } finally {
      if (id === activeLogId) logFetchInFlight = false;
    }
  }

  els.logTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-log-tab]');
    if (!tab) return;
    activeLogId = tab.getAttribute('data-log-tab');
    lastLogTextRendered = '';
    syncLogConsoleLayout();
    fetchLogsFor(activeLogId);
  });

  els.btnLogErr.addEventListener('click', () => {
    const st = openLogs.get(activeLogId);
    if (!st) return;
    st.errOnly = !st.errOnly;
    st.lastSig = '';
    lastLogTextRendered = '';
    syncLogConsoleLayout();
    fetchLogsFor(activeLogId);
  });

  els.btnLogWrap.addEventListener('click', () => {
    logWrap = !logWrap;
    syncLogConsoleLayout();
    if (logAutoScroll) scrollLogToBottom();
  });

  els.btnLogBottom.addEventListener('click', () => {
    const pre = els.logPre;
    const dist = pre ? (pre.scrollHeight - pre.scrollTop - pre.clientHeight) : 0;
    if (!logAutoScroll || dist > 20) {
      logAutoScroll = true;
      syncFollowButton();
      scrollLogToBottom();
    } else {
      logAutoScroll = false;
      syncFollowButton();
    }
  });

  // Pause auto-scroll ONLY when the user manually scrolls up; re-enable automatically when scrolled back to bottom
  els.logPre.addEventListener('scroll', () => {
    if (Date.now() < programmaticScrollUntil) return;
    const pre = els.logPre;
    const dist = pre.scrollHeight - pre.scrollTop - pre.clientHeight;
    if (dist > 48 && logAutoScroll) {
      logAutoScroll = false;
      syncFollowButton();
    } else if (dist <= 20 && !logAutoScroll) {
      logAutoScroll = true;
      syncFollowButton();
    }
  }, { passive: true });

  // Keep pinned to bottom when container resizes (card height changes, maximize toggle, window resize)
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => {
      if (logAutoScroll && !els.logConsole.classList.contains('hidden')) {
        scrollLogToBottom();
      }
    });
    ro.observe(els.logPre);
  }

  els.btnLogRefresh.addEventListener('click', () => {
    if (!activeLogId) return;
    const st = openLogs.get(activeLogId);
    if (st) st.lastSig = '';
    fetchLogsFor(activeLogId);
  });

  els.btnLogMax.addEventListener('click', () => {
    logMaximized = !logMaximized;
    syncLogConsoleLayout();
    if (logAutoScroll) scrollLogToBottom();
  });

  els.btnLogClose.addEventListener('click', () => {
    if (!activeLogId) return;
    openLogs.delete(activeLogId);
    const rest = [...openLogs.keys()];
    activeLogId = rest.length > 0 ? rest[rest.length - 1] : '';
    if (!activeLogId) {
      logMaximized = false;
      userDismissedAutoLog = true;
    }
    lastLogTextRendered = '';
    syncLogConsoleLayout();
    if (latestSnap) renderServices(latestSnap);
  });

  let searchTimer = null;
  els.logSearch.addEventListener('input', () => {
    const st = openLogs.get(activeLogId);
    if (!st) return;
    st.query = els.logSearch.value;
    st.lastSig = '';
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      lastLogTextRendered = '';
      fetchLogsFor(activeLogId);
    }, 220);
  });

  // ============================================================
  // Launcher Drawer Logic
  // ============================================================
  function setLauncherOpen(open, preselectWorkspace) {
    launcherOpen = open;
    if (open && logMaximized) {
      logMaximized = false;
      syncLogConsoleLayout();
    }
    els.launcherCard.classList.toggle('hidden', !open);
    els.btnToggleLauncher.textContent = open ? '收起启动' : '+ 启动';
    if (open) {
      populateWorkspacesDropdown(latestSnap?.workspaces || [], preselectWorkspace);
      const ws = getSelectedWorkspace();
      if (ws) loadProjectMeta(ws);
    }
  }

  function populateWorkspacesDropdown(workspaces, forceSelect) {
    const prev = forceSelect || els.wsSelect.value;
    const optsHtml = workspaces.map((w) => {
      const suffix = w.running ? ' (运行中)' : (w.tag === 'saved' ? ' ★' : '');
      return `<option value="${esc(w.path)}">${esc(w.name)}${suffix} — ${esc(w.path)}</option>`;
    }).join('');
    if (els.wsSelect.innerHTML !== optsHtml) {
      els.wsSelect.innerHTML = optsHtml;
    }
    if (prev && workspaces.some((w) => w.path === prev)) {
      els.wsSelect.value = prev;
    }
  }

  function getSelectedWorkspace() {
    return customWsMode ? els.wsCustom.value.trim() : els.wsSelect.value;
  }

  async function loadProjectMeta(wsPath) {
    if (!wsPath) return;
    els.launcherStatus.textContent = '正在扫描项目 POM 与数据源…';
    els.modChips.innerHTML = '<span class="muted-hint">扫描中…</span>';
    try {
      const meta = await apiJson('/api/project-meta', { workspace: wsPath });
      currentMeta = meta;
      const defPort = meta.apps?.[0]?.defaultPort || 8080;
      els.launcherPortHint.textContent = `默认 :${defPort} · 冲突自动顺延`;
      els.portInput.placeholder = `默认 ${defPort} (留空自动顺延)`;

      const dbOpts = ['<option value="">默认 (yml 当前生效)</option>'];
      for (const d of meta.dbs || []) {
        const tag = d.kind === 'preset' ? '[预设]' : (d.active ? '[生效]' : '[注释]');
        const addr = d.hostPort ? `${d.hostPort}/${d.schema}` : d.name;
        dbOpts.push(`<option value="${esc(d.name)}">${tag} ${esc(d.name)} · ${esc(addr)} (${esc(d.vendor)})</option>`);
      }
      els.dbSelect.innerHTML = dbOpts.join('');
      if (meta.savedConfig?.db) els.dbSelect.value = meta.savedConfig.db;

      const esOpts = [
        '<option value="">默认 (spring.elasticsearch)</option>',
        '<option value="off">关闭业务 ES (off)</option>',
        '<option value="127.0.0.1:9200">本机 127.0.0.1:9200</option>'
      ];
      for (const e of meta.es || []) {
        const tag = e.kind === 'preset' ? '[ES预设]' : (e.active ? '[生效]' : '[注释]');
        esOpts.push(`<option value="${esc(e.name)}">${tag} ${esc(e.name)} (${esc(e.uris)})</option>`);
      }
      els.esSelect.innerHTML = esOpts.join('');
      if (meta.savedConfig?.es) els.esSelect.value = meta.savedConfig.es;

      const eslogOpts = [
        '<option value="">默认 (spring.elasticlog)</option>',
        '<option value="127.0.0.1:9200">本机 127.0.0.1:9200</option>'
      ];
      for (const e of meta.eslog || []) {
        const tag = e.kind === 'preset' ? '[ESLog预设]' : (e.active ? '[生效]' : '[注释]');
        eslogOpts.push(`<option value="${esc(e.name)}">${tag} ${esc(e.name)} (${esc(e.uris)})</option>`);
      }
      els.eslogSelect.innerHTML = eslogOpts.join('');
      if (meta.savedConfig?.eslog) els.eslogSelect.value = meta.savedConfig.eslog;

      selectedLocalSet = new Set();
      for (const m of meta.modules || []) {
        if (m.enabled || m.isStarter) selectedLocalSet.add(m.artifactId);
      }
      renderModChips();
      els.launcherStatus.textContent = meta.apps?.length
        ? `Starter: ${meta.apps[0].artifactId} (JDK ${meta.ideaJdk || '自动'})`
        : '未检测到 Spring Boot 启动类';
    } catch (err) {
      els.launcherStatus.textContent = `扫描失败: ${err.message}`;
      els.modChips.innerHTML = '<span class="muted-hint">请检查目录路径</span>';
    }
  }

  function renderModChips() {
    if (!currentMeta || !currentMeta.modules || currentMeta.modules.length === 0) {
      els.modChips.innerHTML = '<span class="muted-hint">无可选本地模块</span>';
      return;
    }
    els.modChips.innerHTML = currentMeta.modules.map((m) => {
      const isOn = m.isStarter || selectedLocalSet.has(m.artifactId);
      const cls = m.isStarter ? 'mod-chip starter' : (isOn ? 'mod-chip on' : 'mod-chip');
      const tip = m.isStarter ? 'Starter 主模块（始终走本地）' : (isOn ? '本地源码编译 (点击切换走 .m2)' : '走 .m2 仓库 (点击切换本地源码)');
      return `<span class="${cls}" data-mod="${esc(m.artifactId)}" data-starter="${m.isStarter ? '1' : '0'}" title="${esc(tip)}">${esc(m.artifactId)}</span>`;
    }).join('');
  }

  els.modChips.addEventListener('click', (e) => {
    const chip = e.target.closest('.mod-chip');
    if (!chip || chip.getAttribute('data-starter') === '1') return;
    const mod = chip.getAttribute('data-mod');
    if (selectedLocalSet.has(mod)) selectedLocalSet.delete(mod);
    else selectedLocalSet.add(mod);
    renderModChips();
  });

  els.btnModIdea.addEventListener('click', () => {
    if (!currentMeta) return;
    selectedLocalSet = new Set();
    for (const m of currentMeta.modules || []) {
      if (m.ideaLinked || m.isStarter) selectedLocalSet.add(m.artifactId);
    }
    renderModChips();
  });

  els.btnModStarter.addEventListener('click', () => {
    if (!currentMeta) return;
    selectedLocalSet = new Set();
    for (const m of currentMeta.modules || []) {
      if (m.isStarter) selectedLocalSet.add(m.artifactId);
    }
    renderModChips();
  });

  els.btnToggleLauncher.addEventListener('click', () => setLauncherOpen(!launcherOpen));
  els.btnCancelLaunch.addEventListener('click', () => setLauncherOpen(false));
  els.btnWsMode.addEventListener('click', () => {
    customWsMode = !customWsMode;
    els.wsSelect.classList.toggle('hidden', customWsMode);
    els.wsCustom.classList.toggle('hidden', !customWsMode);
    els.btnWsMode.textContent = customWsMode ? '列表' : '路径';
    if (customWsMode && !els.wsCustom.value && els.wsSelect.value) {
      els.wsCustom.value = els.wsSelect.value;
    }
  });
  els.wsSelect.addEventListener('change', () => loadProjectMeta(els.wsSelect.value));
  els.wsCustom.addEventListener('change', () => loadProjectMeta(els.wsCustom.value));

  els.btnDoLaunch.addEventListener('click', async () => {
    const workspace = getSelectedWorkspace();
    if (!workspace) {
      showBanner('err', '请先选择或输入工作区路径');
      return;
    }
    els.btnDoLaunch.disabled = true;
    try {
      const selectedList = [...selectedLocalSet];
      const payload = {
        workspace,
        localMode: selectedList.length > 0 ? 'custom' : 'default',
        localModules: selectedList.join(','),
        db: els.dbSelect.value || '',
        es: els.esSelect.value || '',
        eslog: els.eslogSelect.value || '',
        port: els.portInput.value.trim(),
        debugPort: els.chkDebug.checked ? '5005' : '',
        noBuild: els.chkNobuild.checked,
        save: els.chkSave.checked
      };
      const res = await apiJson('/api/start', payload);
      showBanner('info', res.message || `已触发启动 ${res.id}`, 4500);
      setLauncherOpen(false);
      userDismissedAutoLog = false;
      if (res && res.id) {
        focusLog(res.id, '', { waitForNewFile: true });
      }
      await pollSnapshot(false);
      burstPoll();
    } catch (err) {
      showBanner('err', `启动失败: ${err.message}`, 6000);
    } finally {
      els.btnDoLaunch.disabled = false;
    }
  });

  // ============================================================
  // Service Card Rendering & Actions
  // ============================================================
  function statusVisual(status) {
    switch (status) {
      case 'UP':
      case 'RUNNING':
        return { dot: 'up', badge: 'badge-up', label: status };
      case 'BUILDING':
        return { dot: 'busy', badge: 'badge-busy', label: '编译中' };
      case 'STARTING':
        return { dot: 'busy', badge: 'badge-busy', label: '启动中' };
      case 'RESTARTING':
        return { dot: 'busy', badge: 'badge-busy', label: '重启中' };
      case 'STOPPING':
        return { dot: 'busy', badge: 'badge-busy', label: '停止中' };
      case 'FAILED':
        return { dot: 'err', badge: 'badge-err', label: '启动失败' };
      default:
        return { dot: 'busy', badge: 'badge-busy', label: status || '未知' };
    }
  }

  function sourceBadge(source) {
    if (source === 'skill') return '<span class="badge badge-skill">sb 托管</span>';
    if (source === 'IDEA') return '<span class="badge badge-idea">IDEA</span>';
    return '<span class="badge badge-manual">手动</span>';
  }

  function renderServices(snap) {
    const services = snap.services || [];
    const now = Date.now();

    const { up, busy, totalRssText, activePorts } = snap.summary || {};
    if (busy > 0) {
      els.globalRing.className = 'status-ring busy';
      els.globalPill.className = 'status-pill busy';
      els.globalPill.textContent = `${up} 运行 · ${busy} 处理中`;
    } else if (up > 0) {
      els.globalRing.className = 'status-ring live';
      els.globalPill.className = 'status-pill live';
      els.globalPill.textContent = `${up} 个运行中`;
    } else {
      els.globalRing.className = 'status-ring';
      els.globalPill.className = 'status-pill';
      els.globalPill.textContent = '空闲';
    }

    els.sumUp.textContent = String(up || 0);
    els.sumBusy.textContent = busy > 0 ? `+${busy} 处理中` : '';
    els.sumMem.textContent = totalRssText || '0MB';
    els.sumPorts.textContent = activePorts && activePorts.length > 0
      ? activePorts.map((p) => `:${p}`).join('  ')
      : '--';
    els.sumPorts.title = els.sumPorts.textContent;

    const latestEv = snap.recentEvents && snap.recentEvents[0];
    if (latestEv && now - latestEv.ts < 5500 && latestEv.id !== renderServices._lastEvId) {
      renderServices._lastEvId = latestEv.id;
      showBanner(latestEv.level, `[${latestEv.time}] ${latestEv.message}`, 5000);
    }

    els.servicesList.classList.toggle('multi', services.length > 1);

    if (services.length === 0) {
      els.servicesList.innerHTML = '';
      els.emptyCard.classList.remove('hidden');
      const quickList = (snap.workspaces || []).slice(0, 8);
      els.quickWsPills.innerHTML = quickList.map((w) =>
        `<button type="button" class="ws-pill" data-quick-ws="${esc(w.path)}">▶ ${esc(w.name)}</button>`
      ).join('');
      lastCardsRenderKey = 'empty';
      syncLogConsoleLayout();
      return;
    }

    els.emptyCard.classList.add('hidden');

    const htmlParts = [];
    for (const s of services) {
      const sv = statusVisual(s.status);
      const portLabel = s.primaryPort ? `:${s.primaryPort}${s.contextPath || ''}` : (s.status === 'BUILDING' ? '编译中' : '无端口');
      const stopKey = `${s.id}::${s.pid || ''}`;
      const isConfirmStop = (confirmStopMap.get(stopKey) || 0) > now;
      const isLogActive = openLogs.has(s.id) && activeLogId === s.id;
      const isStopping = s.status === 'STOPPING' || s.status === 'RESTARTING';

      const modsTitle = s.localModules && s.localModules.length > 0 ? s.localModules.join(', ') : '';
      const dsRows = [];
      if (s.dbDisplay) dsRows.push(`<div class="ds-row"><span class="ds-tag db">DB</span><span class="ds-val" title="${esc(s.dbDisplay)}">${esc(s.dbDisplay)}</span></div>`);
      if (s.esDisplay) dsRows.push(`<div class="ds-row"><span class="ds-tag es">ES</span><span class="ds-val" title="${esc(s.esDisplay)}">${esc(s.esDisplay)}</span></div>`);
      if (s.eslogDisplay) dsRows.push(`<div class="ds-row"><span class="ds-tag eslog">ESLog</span><span class="ds-val" title="${esc(s.eslogDisplay)}">${esc(s.eslogDisplay)}</span></div>`);

      htmlParts.push(`
        <article class="card svc-card" data-id="${esc(s.id)}" data-pid="${esc(s.pid || '')}">
          <div class="svc-top">
            <div class="svc-title-group">
              <span class="svc-dot ${sv.dot}"></span>
              <span class="svc-name" title="${esc(s.mainClass || s.appName)}">${esc(s.id)}</span>
              ${sourceBadge(s.source)}
              <span class="badge ${sv.badge}">${esc(sv.label)}</span>
            </div>
            <div class="svc-right">
              ${s.url
                ? `<button type="button" class="port-pill" data-action="copy-url" data-url="${esc(s.url)}" title="点击复制 ${esc(s.url)}">${esc(portLabel)}</button>`
                : `<span class="head-badge">${esc(portLabel)}</span>`
              }
              <span class="uptime-txt">${esc(s.uptimeText)}</span>
            </div>
          </div>

          <div class="svc-metrics">
            <span>PID <strong>${esc(s.pid || '-')}</strong></span>
            <span>内存 <strong>${esc(s.rssText || '-')}</strong></span>
            ${s.profiles ? `<span>Profile <strong>${esc(s.profiles)}</strong></span>` : ''}
            ${s.localModules && s.localModules.length > 0 ? `<span title="${esc(modsTitle)}">本地模块 <strong>${s.localModules.length} 个</strong></span>` : ''}
            ${s.debugPort ? `<span>JDWP <strong>:${s.debugPort}</strong></span>` : ''}
            ${s.workspace ? `<span class="svc-ws" title="${esc(s.workspace)}">${esc(s.workspace)}</span>` : ''}
          </div>

          ${dsRows.length > 0 ? `<div class="svc-ds-list">${dsRows.join('')}</div>` : ''}
          ${s.error ? `<div class="svc-err-box">${esc(s.error)}</div>` : ''}

          <div class="svc-actions">
            <div class="act-group">
              ${s.logFile ? `<button type="button" class="act-btn ${isLogActive ? 'active' : ''}" data-action="toggle-logs" data-id="${esc(s.id)}" data-logfile="${esc(s.logFile)}">${isLogActive ? '隐藏日志' : '查看日志'}</button>` : ''}
              ${s.url ? `<button type="button" class="act-btn" data-action="copy-url" data-url="${esc(s.url)}">复制地址</button>` : ''}
              ${s.source === 'skill' && !isStopping ? `<button type="button" class="act-btn" data-action="restart" data-id="${esc(s.id)}" data-ws="${esc(s.workspace)}" title="重新编译并重启">重启</button>` : ''}
              ${s.source === 'skill' && !isStopping ? `<button type="button" class="act-btn" data-action="quick-restart" data-id="${esc(s.id)}" data-ws="${esc(s.workspace)}" title="跳过编译秒重启 (--no-build)">⚡秒启</button>` : ''}
            </div>
            <div class="act-group">
              ${s.status !== 'FAILED' ? `
                <button type="button" class="act-btn ${isConfirmStop ? 'confirm-danger' : 'danger'}"
                  data-action="stop" data-id="${esc(s.id)}" data-pid="${esc(s.pid || '')}" data-source="${esc(s.source)}"
                  ${isStopping ? 'disabled' : ''}>
                  ${isStopping ? '停止中…' : (isConfirmStop ? '确认停止?' : '停止')}
                </button>
              ` : ''}
            </div>
          </div>
        </article>
      `);
    }

    const nextHtml = htmlParts.join('');
    if (nextHtml !== lastCardsRenderKey) {
      els.servicesList.innerHTML = nextHtml;
      lastCardsRenderKey = nextHtml;
    }
    syncLogConsoleLayout();
  }

  els.servicesList.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const id = btn.getAttribute('data-id') || '';
    const pid = btn.getAttribute('data-pid') || '';

    if (action === 'copy-url') {
      copyText(btn.getAttribute('data-url'), btn.classList.contains('act-btn') ? btn : null);
      return;
    }

    if (action === 'toggle-logs') {
      await openOrToggleLog(id, btn.getAttribute('data-logfile') || '');
      return;
    }

    if (action === 'restart' || action === 'quick-restart') {
      const ws = btn.getAttribute('data-ws') || '';
      try {
        await apiJson('/api/restart', { id, workspace: ws, noBuild: action === 'quick-restart' });
        showBanner('info', `已触发重启 ${id}${action === 'quick-restart' ? ' (跳过编译)' : ''}`);
        if (openLogs.has(id) || !userDismissedAutoLog) {
          focusLog(id, '', { waitForNewFile: true });
        }
        await pollSnapshot(false);
        burstPoll();
      } catch (err) {
        showBanner('err', `重启失败: ${err.message}`);
      }
      return;
    }

    if (action === 'stop') {
      const key = `${id}::${pid}`;
      const exp = confirmStopMap.get(key) || 0;
      if (Date.now() > exp) {
        confirmStopMap.set(key, Date.now() + 3500);
        if (latestSnap) renderServices(latestSnap);
        setTimeout(() => {
          if (latestSnap) renderServices(latestSnap);
        }, 3600);
        return;
      }
      confirmStopMap.delete(key);
      const source = btn.getAttribute('data-source');
      const target = source === 'skill' ? id : (pid || id);
      try {
        await apiJson('/api/stop', { target, id, pid });
        showBanner('info', `正在优雅停止 ${id}…`);
        await pollSnapshot(false);
        burstPoll();
      } catch (err) {
        showBanner('err', `停止失败: ${err.message}`);
      }
    }
  });

  els.quickWsPills.addEventListener('click', (e) => {
    const pill = e.target.closest('[data-quick-ws]');
    if (!pill) return;
    setLauncherOpen(true, pill.getAttribute('data-quick-ws'));
  });

  els.chkShowAll.addEventListener('change', () => {
    showAllJvms = els.chkShowAll.checked;
    pollSnapshot(true);
  });

  els.btnRefresh.addEventListener('click', async () => {
    els.btnRefresh.disabled = true;
    try {
      await pollSnapshot(true);
    } finally {
      els.btnRefresh.disabled = false;
    }
  });

  // ============================================================
  // Polling Loop
  // ============================================================
  async function pollSnapshot(forceOsRefresh = false) {
    try {
      const url = forceOsRefresh ? '/api/refresh' : '/api/snapshot';
      const data = await apiJson(url, { includeAll: showAllJvms });
      if (data.assetVersion) {
        if (knownAssetVersion && knownAssetVersion !== data.assetVersion) {
          window.location.reload();
          return;
        }
        knownAssetVersion = data.assetVersion;
      }
      latestSnap = data;

      // Rebind any open log tabs to newly created logFile (e.g. after start/restart)
      reconcileOpenLogsWithSnapshot(data.services || []);

      // Default auto-expand log console for the first service with a log file (unless user explicitly closed it)
      if (!userDismissedAutoLog && openLogs.size === 0 && Array.isArray(data.services)) {
        const firstWithLog = data.services.find((s) => s.logFile);
        if (firstWithLog) {
          openLogs.set(firstWithLog.id, {
            id: firstWithLog.id,
            logFile: firstWithLog.logFile,
            errOnly: false,
            query: '',
            text: '加载日志中…',
            totalLines: 0,
            sizeBytes: 0,
            lastFetch: 0
          });
          activeLogId = firstWithLog.id;
          lastLogTextRendered = '';
        }
      }

      renderServices(data);

      if (data.lastScanAtMs) {
        const t = new Date(data.lastScanAtMs).toTimeString().slice(0, 8);
        els.scanMeta.textContent = `最近扫描 ${t} · 自动刷新`;
      }

      if (activeLogId && openLogs.has(activeLogId)) {
        const st = openLogs.get(activeLogId);
        const liveSvc = (data.services || []).find((s) => s.id === activeLogId);
        const isActiveTransition = st.pendingNewSince || (liveSvc && ['BUILDING', 'STARTING', 'RESTARTING', 'STOPPING'].includes(liveSvc.status));
        const minGap = isActiveTransition ? 500 : 1200;
        if (Date.now() - st.lastFetch >= minGap) {
          fetchLogsFor(activeLogId);
        }
      }
    } catch {
      els.scanMeta.textContent = '连接 Sidecar 重试中…';
    }
  }

  function burstPoll() {
    [400, 900, 1500, 2200, 3200, 4500, 6000].forEach((ms) => {
      setTimeout(() => pollSnapshot(false), ms);
    });
  }

  // Dedicated lightweight log tail loop (650ms while starting/building, 1500ms while steady UP)
  setInterval(() => {
    if (!activeLogId || !openLogs.has(activeLogId)) return;
    const st = openLogs.get(activeLogId);
    if (st.pendingNewSince) {
      pollSnapshot(false);
      return;
    }
    const liveSvc = latestSnap && Array.isArray(latestSnap.services)
      ? latestSnap.services.find((s) => s.id === activeLogId)
      : null;
    const fast = liveSvc && ['BUILDING', 'STARTING', 'RESTARTING', 'STOPPING'].includes(liveSvc.status);
    const gap = fast ? 600 : 1500;
    if (Date.now() - st.lastFetch >= gap) {
      fetchLogsFor(activeLogId);
    }
  }, 650);

  pollSnapshot(true);
  setInterval(() => pollSnapshot(false), 1800);
})();
