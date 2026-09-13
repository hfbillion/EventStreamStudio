(function () {
  "use strict";

  const elements = {
    captureState: document.querySelector("#captureState"),
    captureLabel: document.querySelector("#captureLabel"),
    pauseButton: document.querySelector("#pauseButton"),
    clearButton: document.querySelector("#clearButton"),
    builderButton: document.querySelector("#builderButton"),
    exportButton: document.querySelector("#exportButton"),
    connectionCount: document.querySelector("#connectionCount"),
    connectionSearch: document.querySelector("#connectionSearch"),
    connectionList: document.querySelector("#connectionList"),
    allEventCount: document.querySelector("#allEventCount"),
    eventSearch: document.querySelector("#eventSearch"),
    typeFilter: document.querySelector("#typeFilter"),
    summary: document.querySelector("#summary"),
    eventList: document.querySelector("#eventList"),
    jumpLatestButton: document.querySelector("#jumpLatestButton"),
    jumpLatestLabel: document.querySelector("#jumpLatestLabel"),
    emptyState: document.querySelector("#emptyState"),
    toast: document.querySelector("#toast"),
    builderDialog: document.querySelector("#builderDialog"),
    builderTarget: document.querySelector("#builderTarget"),
    sequenceEditor: document.querySelector("#sequenceEditor"),
    sequenceStatus: document.querySelector("#sequenceStatus"),
    builderSummary: document.querySelector("#builderSummary"),
    runSequenceButton: document.querySelector("#runSequenceButton"),
  };

  const state = {
    connections: new Map(),
    events: [],
    selectedConnection: "all",
    paused: false,
    pending: [],
    expanded: new Set(),
    renderQueued: false,
    renderTimer: null,
    followTail: true,
    unseenCount: 0,
    renderedEventIds: [],
    forceEventRender: false,
    nextEventId: 1,
    port: null,
  };

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
  }

  if (globalThis.chrome && chrome.devtools && chrome.devtools.panels) {
    setTheme(chrome.devtools.panels.themeName);
    if (chrome.devtools.panels.onThemeChanged) {
      chrome.devtools.panels.onThemeChanged.addListener(setTheme);
    }
  } else {
    setTheme(matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }

  function connect() {
    if (!globalThis.chrome || !chrome.runtime || !chrome.devtools) return;
    const tabId = chrome.devtools.inspectedWindow.tabId;
    state.port = chrome.runtime.connect({ name: `eventstream-studio-panel:${tabId}` });
    state.port.onMessage.addListener(function (message) {
      if (message.type === "backlog") {
        for (const payload of message.payload) ingest(payload);
      } else if (message.type === "reset") {
        resetCapturedState();
      } else if (message.type === "event") {
        if (state.paused) {
          state.pending.push(message.payload);
          updateCaptureLabel();
        } else ingest(message.payload);
      } else if (message.type === "simulation-error") {
        showToast("注入失败：目标页面不可用");
      }
    });
    state.port.onDisconnect.addListener(function () {
      state.port = null;
      elements.captureLabel.textContent = "连接已断开";
      elements.captureState.classList.add("paused");
    });
  }

  function ensureConnection(payload) {
    if (!state.connections.has(payload.connectionId)) {
      state.connections.set(payload.connectionId, {
        id: payload.connectionId,
        url: payload.url || "未知地址",
        transport: payload.transport || "SSE",
        status: "connecting",
        openedAt: payload.timestamp,
        eventCount: 0,
      });
    }
    return state.connections.get(payload.connectionId);
  }

  function ingest(payload) {
    if (!payload || !payload.connectionId) return;
    if (payload.kind === "simulation-result") {
      if (payload.status === "complete") showToast(`模拟发送完成 · ${payload.count || 0} 个事件`);
      else if (payload.status === "error") showToast(payload.error || "模拟发送失败");
      return;
    }
    const connection = ensureConnection(payload);
    connection.url = payload.url || connection.url;
    connection.transport = payload.transport || connection.transport;
    connection.frameId = payload.frameId ?? connection.frameId ?? 0;
    connection.lastAt = payload.timestamp;

    if (payload.kind === "connection-open") {
      connection.status = "connecting";
      connection.statusCode = payload.statusCode;
    } else if (payload.kind === "connection-state") {
      connection.status = payload.status || connection.status;
      connection.error = payload.error;
    } else if (payload.kind === "event") {
      const event = Object.assign({}, payload, {
        localId: state.nextEventId++,
        size: byteSize(payload.data || ""),
      });
      state.events.push(event);
      if (!state.followTail) state.unseenCount += 1;
      connection.eventCount += 1;
      if (state.events.length > 3000) {
        const removed = state.events.splice(0, state.events.length - 3000);
        for (const item of removed) state.expanded.delete(item.localId);
        recountConnections();
      }
    }
    scheduleRender();
  }

  function recountConnections() {
    for (const connection of state.connections.values()) connection.eventCount = 0;
    for (const event of state.events) {
      const connection = state.connections.get(event.connectionId);
      if (connection) connection.eventCount += 1;
    }
  }

  function byteSize(text) {
    return new TextEncoder().encode(text).length;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function formatTime(timestamp) {
    const date = new Date(timestamp);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}.${String(date.getMilliseconds()).padStart(3, "0")}`;
  }

  function shortUrl(value) {
    try {
      const url = new URL(value);
      return `${url.pathname}${url.search}` || url.host;
    } catch (_) {
      return value;
    }
  }

  function scheduleRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    state.renderTimer = setTimeout(function () {
      requestAnimationFrame(function () {
        state.renderQueued = false;
        state.renderTimer = null;
        render();
      });
    }, 40);
  }

  function filteredEvents() {
    const query = elements.eventSearch.value.trim().toLowerCase();
    const type = elements.typeFilter.value;
    return state.events.filter(function (event) {
      if (state.selectedConnection !== "all" && event.connectionId !== state.selectedConnection) return false;
      if (type !== "all" && event.eventType !== type) return false;
      if (!query) return true;
      return `${event.eventType || "message"}\n${event.data || ""}`.toLowerCase().includes(query);
    });
  }

  function render() {
    renderConnections();
    renderTypeOptions();
    renderEvents();
  }

  function renderConnections() {
    const search = elements.connectionSearch.value.trim().toLowerCase();
    const allButton = elements.connectionList.querySelector('[data-connection-id="all"]');
    allButton.classList.toggle("active", state.selectedConnection === "all");
    elements.allEventCount.textContent = String(state.events.length);
    elements.connectionList.querySelectorAll('.connection-item:not([data-connection-id="all"])').forEach(node => node.remove());

    const connections = Array.from(state.connections.values()).filter(connection =>
      connection.url.toLowerCase().includes(search) || connection.transport.toLowerCase().includes(search),
    );
    connections.sort((a, b) => (b.lastAt || b.openedAt) - (a.lastAt || a.openedAt));

    for (const connection of connections) {
      const button = document.createElement("button");
      button.className = `connection-item${state.selectedConnection === connection.id ? " active" : ""}`;
      button.dataset.connectionId = connection.id;
      button.title = connection.url;

      const icon = document.createElement("span");
      icon.className = "connection-icon";
      const status = document.createElement("span");
      status.className = `connection-status ${connection.status || "connecting"}`;
      icon.append(status);

      const copy = document.createElement("span");
      copy.className = "connection-copy";
      const name = document.createElement("span");
      name.className = "connection-name";
      name.textContent = shortUrl(connection.url);
      const subtitle = document.createElement("span");
      subtitle.className = "connection-url";
      subtitle.textContent = `${connection.transport} · ${connection.status || "connecting"}`;
      copy.append(name, subtitle);

      const count = document.createElement("span");
      count.className = "event-count";
      count.textContent = String(connection.eventCount);
      button.append(icon, copy, count);
      elements.connectionList.append(button);
    }

    elements.connectionCount.textContent = String(state.connections.size);
  }

  function renderTypeOptions() {
    const previous = elements.typeFilter.value;
    const types = Array.from(new Set(state.events.map(event => event.eventType || "message"))).sort();
    elements.typeFilter.replaceChildren(new Option("全部类型", "all"));
    for (const type of types) elements.typeFilter.append(new Option(type, type));
    elements.typeFilter.value = types.includes(previous) ? previous : "all";
  }

  function renderEvents() {
    const events = filteredEvents();
    const previousScrollTop = elements.eventList.scrollTop;
    elements.emptyState.classList.toggle("hidden", state.events.length > 0);

    const eventIds = events.map(event => event.localId);
    const canAppend = !state.forceEventRender
      && !elements.eventList.querySelector(".no-results")
      && state.renderedEventIds.length <= eventIds.length
      && state.renderedEventIds.every((id, index) => id === eventIds[index]);

    if (state.events.length > 0 && events.length === 0) {
      elements.eventList.replaceChildren();
      const noResults = document.createElement("div");
      noResults.className = "no-results";
      noResults.textContent = "没有符合当前筛选条件的事件";
      elements.eventList.append(noResults);
    } else if (canAppend) {
      const fragment = document.createDocumentFragment();
      for (const event of events.slice(state.renderedEventIds.length)) fragment.append(createEventRow(event));
      elements.eventList.append(fragment);
    } else {
      elements.eventList.replaceChildren();
      const fragment = document.createDocumentFragment();
      for (const event of events) fragment.append(createEventRow(event));
      elements.eventList.append(fragment);
    }

    state.renderedEventIds = eventIds;
    state.forceEventRender = false;

    const bytes = events.reduce((sum, event) => sum + event.size, 0);
    elements.summary.textContent = `${events.length} 个事件 · ${formatBytes(bytes)}`;

    if (state.followTail) {
      elements.eventList.scrollTop = elements.eventList.scrollHeight;
      state.unseenCount = 0;
    } else {
      elements.eventList.scrollTop = previousScrollTop;
    }
    updateJumpLatest();
  }

  function updateJumpLatest() {
    const canScroll = elements.eventList.scrollHeight > elements.eventList.clientHeight + 2;
    const visible = canScroll && !state.followTail;
    elements.jumpLatestButton.classList.toggle("visible", visible);
    elements.jumpLatestLabel.textContent = state.unseenCount > 0
      ? `${state.unseenCount} 条新事件`
      : "回到最新";
  }

  function followLatest() {
    state.followTail = true;
    state.unseenCount = 0;
    elements.eventList.scrollTop = elements.eventList.scrollHeight;
    updateJumpLatest();
  }

  function createEventRow(event) {
    const row = document.createElement("article");
    row.className = `event-row${state.expanded.has(event.localId) ? " expanded" : ""}`;
    row.dataset.eventId = String(event.localId);

    const summary = document.createElement("button");
    summary.className = "event-summary";
    const time = span("event-time", formatTime(event.timestamp));
    const type = span("event-type");
    type.append(span("type-dot"), span("event-type-label", event.eventType || "message"));
    if (event.synthetic) type.append(span("synthetic-badge", "模拟"));
    const preview = span("event-preview", oneLinePreview(event.data));
    const size = span("event-size", formatBytes(event.size));
    summary.append(time, type, preview, size);

    const detail = document.createElement("div");
    detail.className = "event-detail";
    if (state.expanded.has(event.localId)) fillDetail(detail, event);
    row.append(summary, detail);
    return row;
  }

  function span(className, text) {
    const node = document.createElement("span");
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function oneLinePreview(data) {
    return String(data || "").replace(/\s+/g, " ").trim() || "（空数据）";
  }

  function parseJson(data) {
    const text = String(data || "").trim();
    if (!text || (!text.startsWith("{") && !text.startsWith("["))) return { valid: false };
    try {
      return { valid: true, value: JSON.parse(text) };
    } catch (_) {
      return { valid: false };
    }
  }

  function fillDetail(container, event) {
    const parsed = parseJson(event.data);
    const toolbar = document.createElement("div");
    toolbar.className = "detail-toolbar";
    const label = span("format-label", parsed.valid ? "已识别 JSON" : "原始文本");
    if (parsed.valid) label.classList.add("json-valid");
    const actions = document.createElement("div");
    actions.className = "detail-actions";

    if (parsed.valid) {
      const pretty = miniButton("格式化", "pretty", true);
      const raw = miniButton("原始", "raw");
      actions.append(pretty, raw);
    }
    const copy = miniButton("复制", "copy");
    actions.append(copy);
    toolbar.append(label, actions);

    const content = document.createElement("div");
    content.className = "detail-content";
    if (parsed.valid) content.append(createJsonTree(parsed.value));
    else content.append(createRaw(event.data));
    container.append(toolbar, content);

    actions.addEventListener("click", async function (clickEvent) {
      const action = clickEvent.target.dataset.action;
      if (!action) return;
      clickEvent.stopPropagation();
      if (action === "copy") {
        await copyText(parsed.valid ? JSON.stringify(parsed.value, null, 2) : event.data);
        showToast("报文已复制");
      } else if (action === "raw") {
        actions.querySelector('[data-action="pretty"]').classList.remove("active");
        clickEvent.target.classList.add("active");
        content.replaceChildren(createRaw(event.data));
      } else if (action === "pretty") {
        actions.querySelector('[data-action="raw"]').classList.remove("active");
        clickEvent.target.classList.add("active");
        content.replaceChildren(createJsonTree(parsed.value));
      }
    });
  }

  function miniButton(label, action, active) {
    const button = document.createElement("button");
    button.className = `mini-button${active ? " active" : ""}`;
    button.dataset.action = action;
    button.textContent = label;
    return button;
  }

  function createRaw(data) {
    const pre = document.createElement("pre");
    pre.className = "raw-data";
    pre.textContent = data || "";
    return pre;
  }

  function createJsonTree(value) {
    const tree = document.createElement("div");
    tree.className = "json-tree";
    tree.append(createJsonNode(value, null, true));
    tree.addEventListener("click", function (event) {
      if (!event.target.classList.contains("json-toggle")) return;
      event.target.closest(".json-node").classList.toggle("collapsed");
    });
    return tree;
  }

  function createJsonNode(value, key, root) {
    if (value === null || typeof value !== "object") {
      const line = document.createElement("div");
      line.className = `json-line${root ? "" : " nested"}`;
      appendKey(line, key);
      line.append(primitiveNode(value));
      return line;
    }

    const isArray = Array.isArray(value);
    const entries = Object.entries(value);
    const wrapper = document.createElement("div");
    wrapper.className = "json-node";
    const line = document.createElement("div");
    line.className = `json-line${root ? "" : " nested"}`;
    const toggle = document.createElement("button");
    toggle.className = "json-toggle";
    toggle.tabIndex = -1;
    const open = span("json-open json-punctuation", isArray ? "[" : "{");
    open.dataset.count = String(entries.length);
    line.append(toggle);
    appendKey(line, key);
    line.append(open);

    const children = document.createElement("div");
    children.className = "json-children";
    entries.forEach(function ([childKey, childValue], index) {
      const child = createJsonNode(childValue, isArray ? null : childKey, false);
      if (index < entries.length - 1) {
        const lastLine = child.classList && child.classList.contains("json-node")
          ? child.querySelector(":scope > .json-close")
          : child;
        lastLine.append(span("json-punctuation", ","));
      }
      children.append(child);
    });
    const close = document.createElement("div");
    close.className = `json-line json-close${root ? "" : " nested"}`;
    close.textContent = isArray ? "]" : "}";
    wrapper.append(line, children, close);
    return wrapper;
  }

  function appendKey(line, key) {
    if (key === null) return;
    line.append(span("json-key", JSON.stringify(key)), span("json-punctuation", ": "));
  }

  function primitiveNode(value) {
    if (value === null) return span("json-null", "null");
    if (typeof value === "string") return span("json-string", JSON.stringify(value));
    if (typeof value === "number") return span("json-number", String(value));
    if (typeof value === "boolean") return span("json-boolean", String(value));
    return span("json-null", String(value));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
  }

  let toastTimer;
  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 1600);
  }

  function updateCaptureLabel() {
    if (state.paused) {
      elements.captureLabel.textContent = state.pending.length ? `已暂停 · ${state.pending.length} 条待显示` : "已暂停";
    } else {
      elements.captureLabel.textContent = "正在捕获";
    }
  }

  function resetCapturedState() {
    state.connections.clear();
    state.events = [];
    state.pending = [];
    state.expanded.clear();
    state.selectedConnection = "all";
    state.followTail = true;
    state.unseenCount = 0;
    state.renderedEventIds = [];
    state.forceEventRender = true;
    render();
    updateCaptureLabel();
  }

  elements.connectionList.addEventListener("click", function (event) {
    const item = event.target.closest(".connection-item");
    if (!item) return;
    state.selectedConnection = item.dataset.connectionId;
    state.followTail = true;
    state.unseenCount = 0;
    state.forceEventRender = true;
    scheduleRender();
  });
  elements.connectionSearch.addEventListener("input", scheduleRender);
  elements.eventSearch.addEventListener("input", function () {
    state.followTail = true;
    state.unseenCount = 0;
    state.forceEventRender = true;
    scheduleRender();
  });
  elements.typeFilter.addEventListener("change", function () {
    state.followTail = true;
    state.unseenCount = 0;
    state.forceEventRender = true;
    scheduleRender();
  });

  elements.eventList.addEventListener("scroll", function () {
    const distanceToBottom = elements.eventList.scrollHeight
      - elements.eventList.clientHeight
      - elements.eventList.scrollTop;
    const wasFollowing = state.followTail;
    state.followTail = distanceToBottom <= 48;
    if (state.followTail) state.unseenCount = 0;
    if (wasFollowing !== state.followTail || state.followTail) updateJumpLatest();
  }, { passive: true });

  elements.jumpLatestButton.addEventListener("click", followLatest);

  elements.eventList.addEventListener("click", function (event) {
    const summary = event.target.closest(".event-summary");
    if (!summary) return;
    const row = summary.closest(".event-row");
    const id = Number(row.dataset.eventId);
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    state.forceEventRender = true;
    scheduleRender();
  });

  elements.pauseButton.addEventListener("click", function () {
    state.paused = !state.paused;
    elements.pauseButton.classList.toggle("paused", state.paused);
    elements.captureState.classList.toggle("paused", state.paused);
    elements.pauseButton.title = state.paused ? "继续界面更新" : "暂停界面更新";
    if (!state.paused && state.pending.length) {
      const pending = state.pending.splice(0);
      for (const payload of pending) ingest(payload);
    }
    updateCaptureLabel();
  });

  elements.clearButton.addEventListener("click", function () {
    resetCapturedState();
    if (state.port) state.port.postMessage({ type: "clear" });
    showToast("事件已清空");
  });

  elements.exportButton.addEventListener("click", function () {
    const events = filteredEvents();
    if (!events.length) {
      showToast("当前没有可导出的事件");
      return;
    }
    const output = events.map(function (event) {
      const parsed = parseJson(event.data);
      return {
        timestamp: new Date(event.timestamp).toISOString(),
        connectionId: event.connectionId,
        transport: event.transport,
        url: event.url,
        event: event.eventType,
        id: event.eventId,
        data: parsed.valid ? parsed.value : event.data,
      };
    });
    const blob = new Blob([JSON.stringify(output, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `eventstream-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    showToast(`已导出 ${events.length} 个事件`);
  });

  const presets = {
    basic: [
      { event: "message", id: "test-001", data: { status: "ready", message: "hello EventStream" }, delay: 0 },
      { event: "message", id: "test-002", data: { status: "processing", progress: 0.5 }, delay: 800 },
      { event: "message", id: "test-003", data: { status: "complete", progress: 1 }, delay: 800 },
    ],
    order: [
      { event: "order.created", id: "order-001", data: { orderId: "ORD-TEST-001", status: "created", total: 699 }, delay: 0 },
      { event: "order.updated", id: "order-002", data: { orderId: "ORD-TEST-001", status: "processing", progress: 0.6 }, delay: 1000 },
      { event: "order.updated", id: "order-003", data: { orderId: "ORD-TEST-001", status: "shipped", progress: 1 }, delay: 1200 },
    ],
  };

  function openBuilder() {
    renderBuilderTargets();
    if (!elements.sequenceEditor.value) setPreset("basic");
    validateSequence();
    elements.builderDialog.showModal();
  }

  function renderBuilderTargets() {
    const previous = elements.builderTarget.value;
    elements.builderTarget.replaceChildren(new Option("仅在 EventStream 面板中预览", "__virtual__"));
    const sources = Array.from(state.connections.values()).filter(connection =>
      connection.transport === "EventSource" && connection.status !== "closed" && connection.status !== "error",
    );
    for (const connection of sources) {
      const option = new Option(`注入页面 · ${shortUrl(connection.url)}`, connection.id);
      elements.builderTarget.append(option);
    }
    if (sources.some(connection => connection.id === state.selectedConnection)) {
      elements.builderTarget.value = state.selectedConnection;
    } else if (Array.from(elements.builderTarget.options).some(option => option.value === previous)) {
      elements.builderTarget.value = previous;
    } else if (sources.length) {
      elements.builderTarget.value = sources[0].id;
    }
  }

  function setPreset(name) {
    elements.sequenceEditor.value = JSON.stringify(presets[name], null, 2);
    validateSequence();
  }

  function normalizedSequence() {
    const value = JSON.parse(elements.sequenceEditor.value);
    if (!Array.isArray(value) || value.length === 0) throw new Error("请输入至少一个事件");
    if (value.length > 100) throw new Error("一次最多发送 100 个事件");
    return value.map(function (item, index) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`第 ${index + 1} 项必须是对象`);
      if (!("data" in item)) throw new Error(`第 ${index + 1} 项缺少 data`);
      if (item.event != null && (typeof item.event !== "string" || !item.event.trim())) throw new Error(`第 ${index + 1} 项 event 无效`);
      const delay = item.delay == null ? 0 : Number(item.delay);
      if (!Number.isFinite(delay) || delay < 0 || delay > 60000) throw new Error(`第 ${index + 1} 项 delay 需为 0–60000`);
      return {
        event: item.event || "message",
        id: item.id == null ? undefined : String(item.id),
        data: typeof item.data === "string" ? item.data : JSON.stringify(item.data),
        delay: Math.round(delay),
      };
    });
  }

  function validateSequence() {
    try {
      const events = normalizedSequence();
      const duration = events.reduce((sum, event) => sum + event.delay, 0);
      elements.sequenceStatus.className = "valid";
      elements.sequenceStatus.textContent = "JSON 有效";
      elements.builderSummary.textContent = `${events.length} 个事件 · 约 ${(duration / 1000).toFixed(1)} 秒`;
      elements.runSequenceButton.disabled = false;
      return events;
    } catch (error) {
      elements.sequenceStatus.className = "invalid";
      elements.sequenceStatus.textContent = error.message;
      elements.builderSummary.textContent = "请修正事件序列";
      elements.runSequenceButton.disabled = true;
      return null;
    }
  }

  function runVirtualSequence(events) {
    const connectionId = `mock-${Date.now().toString(36)}`;
    const base = {
      version: 1,
      connectionId,
      transport: "模拟",
      url: "mock://eventstream/manual",
    };
    ingest(Object.assign({}, base, { kind: "connection-open", timestamp: Date.now() }));
    ingest(Object.assign({}, base, { kind: "connection-state", status: "open", timestamp: Date.now() }));
    let elapsed = 0;
    events.forEach(function (event, index) {
      elapsed += event.delay;
      setTimeout(function () {
        ingest(Object.assign({}, base, event, {
          kind: "event",
          eventType: event.event,
          eventId: event.id,
          synthetic: true,
          timestamp: Date.now(),
        }));
        if (index === events.length - 1) {
          ingest(Object.assign({}, base, { kind: "connection-state", status: "closed", timestamp: Date.now() }));
          showToast(`模拟发送完成 · ${events.length} 个事件`);
        }
      }, elapsed);
    });
  }

  elements.builderButton.addEventListener("click", openBuilder);
  elements.sequenceEditor.addEventListener("input", validateSequence);
  document.querySelectorAll("[data-preset]").forEach(button => {
    button.addEventListener("click", () => setPreset(button.dataset.preset));
  });
  elements.runSequenceButton.addEventListener("click", function () {
    const events = validateSequence();
    if (!events) return;
    const target = elements.builderTarget.value;
    elements.builderDialog.close();
    if (target === "__virtual__") {
      runVirtualSequence(events);
    } else {
      const connection = state.connections.get(target);
      if (!connection || !state.port) {
        showToast("目标 EventSource 当前不可用");
        return;
      }
      state.port.postMessage({
        type: "simulate",
        targetConnectionId: target,
        frameId: connection.frameId || 0,
        events,
      });
      showToast(`开始向页面注入 ${events.length} 个事件`);
    }
  });

  document.addEventListener("keydown", function (event) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      elements.eventSearch.focus();
    }
  });

  function loadDemoIfRequested() {
    if (!new URLSearchParams(location.search).has("demo")) return;
    const id = "demo-orders";
    const base = { version: 1, connectionId: id, transport: "EventSource", url: "http://localhost:4173/api/orders/stream" };
    ingest(Object.assign({}, base, { kind: "connection-open", timestamp: Date.now() - 8000 }));
    ingest(Object.assign({}, base, { kind: "connection-state", status: "open", timestamp: Date.now() - 7900 }));
    [
      ["connected", { status: "ready", clientId: "web_a8f2" }],
      ["order.updated", { orderId: "ORD-20260913-0842", status: "processing", customer: { name: "林晓", tier: "pro" }, items: [{ sku: "KEY-75", quantity: 1 }], progress: 0.64 }],
      ["metrics", { active: 128, latencyMs: 42, regions: ["cn-east", "ap-southeast"] }],
    ].forEach(function ([eventType, data], index) {
      ingest(Object.assign({}, base, { kind: "event", eventType, data: JSON.stringify(data), timestamp: Date.now() - 6200 + index * 2200 }));
    });
    state.expanded.add(2);
  }

  connect();
  loadDemoIfRequested();
  render();
})();
