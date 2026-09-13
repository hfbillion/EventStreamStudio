"use strict";

const MAX_BUFFER_PER_TAB = 1500;
const buffers = new Map();
const panelPorts = new Map();

function tabBuffer(tabId) {
  if (!buffers.has(tabId)) buffers.set(tabId, []);
  return buffers.get(tabId);
}

function tabPorts(tabId) {
  if (!panelPorts.has(tabId)) panelPorts.set(tabId, new Set());
  return panelPorts.get(tabId);
}

chrome.runtime.onMessage.addListener(function (message, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (!Number.isInteger(tabId)) return;

  if (message && message.type === "EVENTSTREAM_STUDIO_READY" && (sender.frameId || 0) === 0) {
    buffers.set(tabId, []);
    for (const port of panelPorts.get(tabId) || []) {
      try {
        port.postMessage({ type: "reset" });
      } catch (_) {}
    }
    return;
  }

  if (message && message.type === "EVENTSTREAM_STUDIO_EVENT") {
    const payload = Object.assign({}, message.payload, { frameId: sender.frameId || 0 });
    const list = tabBuffer(tabId);
    list.push(payload);
    if (list.length > MAX_BUFFER_PER_TAB) list.splice(0, list.length - MAX_BUFFER_PER_TAB);
    for (const port of panelPorts.get(tabId) || []) {
      try {
        port.postMessage({ type: "event", payload });
      } catch (_) {}
    }
  }
});

chrome.runtime.onConnect.addListener(function (port) {
  if (!port.name.startsWith("eventstream-studio-panel:")) return;
  const tabId = Number(port.name.split(":").pop());
  if (!Number.isInteger(tabId)) return;

  tabPorts(tabId).add(port);
  port.postMessage({ type: "backlog", payload: tabBuffer(tabId) });

  port.onMessage.addListener(function (message) {
    if (message && message.type === "clear") buffers.set(tabId, []);
    if (message && message.type === "simulate") {
      chrome.tabs.sendMessage(tabId, {
        type: "EVENTSTREAM_STUDIO_SIMULATE",
        targetConnectionId: message.targetConnectionId,
        events: message.events,
      }, { frameId: Number(message.frameId) || 0 }).catch(function (error) {
        try {
          port.postMessage({ type: "simulation-error", error: String(error) });
        } catch (_) {}
      });
    }
  });

  port.onDisconnect.addListener(function () {
    const ports = tabPorts(tabId);
    ports.delete(port);
    if (ports.size === 0) panelPorts.delete(tabId);
  });
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  buffers.delete(tabId);
  panelPorts.delete(tabId);
});
