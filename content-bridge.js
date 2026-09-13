(function () {
  "use strict";

  const SOURCE = "eventstream-studio-page";

  window.addEventListener("message", function (event) {
    if (event.source !== window || !event.data || event.data.source !== SOURCE) return;
    const payload = event.data.payload;
    if (!payload || payload.version !== 1 || typeof payload.kind !== "string") return;
    chrome.runtime.sendMessage({ type: "EVENTSTREAM_STUDIO_EVENT", payload }).catch(function () {});
  });

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "EVENTSTREAM_STUDIO_SIMULATE") return;
    window.postMessage({
      source: "eventstream-studio-extension",
      command: "simulate",
      targetConnectionId: message.targetConnectionId,
      events: message.events,
    }, "*");
  });

  chrome.runtime.sendMessage({ type: "EVENTSTREAM_STUDIO_READY" }).catch(function () {});
})();
