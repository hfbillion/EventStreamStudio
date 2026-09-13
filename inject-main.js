(function () {
  "use strict";

  if (window.__EVENTSTREAM_STUDIO_INSTALLED__) return;
  Object.defineProperty(window, "__EVENTSTREAM_STUDIO_INSTALLED__", { value: true });

  const Parser = window.EventStreamStudioSSEParser;
  try {
    delete window.EventStreamStudioSSEParser;
  } catch (_) {}

  const MESSAGE_SOURCE = "eventstream-studio-page";
  const COMMAND_SOURCE = "eventstream-studio-extension";
  const eventSources = new Map();
  const syntheticEvents = new WeakSet();
  let sequence = 0;

  function makeId(prefix) {
    sequence += 1;
    return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`;
  }

  function absoluteUrl(input) {
    try {
      if (input instanceof Request) return input.url;
      return new URL(String(input), location.href).href;
    } catch (_) {
      return String(input || "未知地址");
    }
  }

  function emit(payload) {
    window.postMessage({
      source: MESSAGE_SOURCE,
      payload: Object.assign({
        version: 1,
        timestamp: Date.now(),
        pageUrl: location.href,
      }, payload),
    }, "*");
  }

  function openConnection(id, transport, url, extra) {
    emit(Object.assign({ kind: "connection-open", connectionId: id, transport, url }, extra));
  }

  function streamEvent(id, transport, url, event) {
    emit({
      kind: "event",
      connectionId: id,
      transport,
      url,
      eventType: event.event || "message",
      eventId: event.id,
      retry: event.retry,
      data: typeof event.data === "string" ? event.data : String(event.data ?? ""),
      synthetic: Boolean(event.synthetic),
    });
  }

  function connectionState(id, transport, url, status, error) {
    emit({ kind: "connection-state", connectionId: id, transport, url, status, error });
  }

  function parseReadableStream(stream, metadata) {
    const decoder = new TextDecoder();
    const parser = new Parser(event => streamEvent(
      metadata.id,
      metadata.transport,
      metadata.url,
      event,
    ));
    const reader = stream.getReader();

    (async function read() {
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          parser.feed(decoder.decode(result.value, { stream: true }));
        }
        parser.feed(decoder.decode());
        parser.end();
        connectionState(metadata.id, metadata.transport, metadata.url, "closed");
      } catch (error) {
        connectionState(metadata.id, metadata.transport, metadata.url, "error", String(error));
      }
    })();
  }

  function installEventSourceHook() {
    const NativeEventSource = window.EventSource;
    if (typeof NativeEventSource !== "function") return;

    const EventSourceProxy = new Proxy(NativeEventSource, {
      construct(Target, args) {
        const source = Reflect.construct(Target, args, Target);
        const url = absoluteUrl(args[0]);
        const id = makeId("es");
        const capturedTypes = new Set(["message"]);
        const nativeAdd = source.addEventListener.bind(source);

        openConnection(id, "EventSource", url, {
          withCredentials: Boolean(args[1] && args[1].withCredentials),
        });
        eventSources.set(id, source);

        nativeAdd("open", function () {
          connectionState(id, "EventSource", url, "open");
        });
        nativeAdd("message", function (event) {
          if (syntheticEvents.has(event)) return;
          streamEvent(id, "EventSource", url, {
            event: event.type,
            id: event.lastEventId || undefined,
            data: event.data,
          });
        });
        nativeAdd("error", function () {
          const status = source.readyState === NativeEventSource.CLOSED ? "closed" : "reconnecting";
          connectionState(id, "EventSource", url, status);
          if (status === "closed") eventSources.delete(id);
        });

        const appAdd = source.addEventListener.bind(source);
        source.addEventListener = function (type, listener, options) {
          if (!capturedTypes.has(type) && type !== "open" && type !== "error") {
            capturedTypes.add(type);
            nativeAdd(type, function (event) {
              if (syntheticEvents.has(event)) return;
              streamEvent(id, "EventSource", url, {
                event: event.type,
                id: event.lastEventId || undefined,
                data: event.data,
              });
            });
          }
          return appAdd(type, listener, options);
        };

        const nativeClose = source.close.bind(source);
        source.close = function () {
          connectionState(id, "EventSource", url, "closed");
          eventSources.delete(id);
          return nativeClose();
        };
        return source;
      },
    });

    Object.defineProperty(window, "EventSource", {
      value: EventSourceProxy,
      configurable: true,
      writable: true,
    });
  }

  function installSimulationBridge() {
    window.addEventListener("message", function (message) {
      const command = message.data;
      if (message.source !== window || !command || command.source !== COMMAND_SOURCE || command.command !== "simulate") return;
      const source = eventSources.get(command.targetConnectionId);
      if (!source || !Array.isArray(command.events)) {
        emit({ kind: "simulation-result", connectionId: command.targetConnectionId || "unknown", status: "error", error: "目标 EventSource 已关闭或不在当前页面" });
        return;
      }

      (async function () {
        emit({ kind: "simulation-result", connectionId: command.targetConnectionId, status: "started", count: command.events.length });
        for (const item of command.events.slice(0, 100)) {
          const delay = Math.max(0, Math.min(60000, Number(item.delay) || 0));
          if (delay) await new Promise(resolve => setTimeout(resolve, delay));
          const eventType = typeof item.event === "string" && item.event ? item.event : "message";
          const data = typeof item.data === "string" ? item.data : JSON.stringify(item.data ?? null);
          const event = new MessageEvent(eventType, {
            data,
            lastEventId: item.id == null ? "" : String(item.id),
            origin: location.origin,
          });
          syntheticEvents.add(event);
          streamEvent(command.targetConnectionId, "EventSource", source.url, {
            event: eventType,
            id: item.id == null ? undefined : String(item.id),
            data,
            synthetic: true,
          });
          source.dispatchEvent(event);
        }
        emit({ kind: "simulation-result", connectionId: command.targetConnectionId, status: "complete", count: command.events.length });
      })();
    });
  }

  function installFetchHook() {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch !== "function") return;

    window.fetch = async function (...args) {
      const response = await nativeFetch.apply(this, args);
      const contentType = response.headers.get("content-type") || "";
      if (!/text\/event-stream/i.test(contentType) || !response.body) return response;

      const id = makeId("fetch");
      const url = response.url || absoluteUrl(args[0]);
      openConnection(id, "fetch", url, { statusCode: response.status });
      connectionState(id, "fetch", url, "open");
      try {
        const clone = response.clone();
        if (clone.body) parseReadableStream(clone.body, { id, transport: "fetch", url });
      } catch (error) {
        connectionState(id, "fetch", url, "error", String(error));
      }
      return response;
    };
  }

  function installXHRHook() {
    const NativeXHR = window.XMLHttpRequest;
    if (typeof NativeXHR !== "function") return;
    const nativeOpen = NativeXHR.prototype.open;
    const nativeSend = NativeXHR.prototype.send;
    const state = new WeakMap();

    NativeXHR.prototype.open = function (method, url) {
      state.set(this, { method, url: absoluteUrl(url), offset: 0, parser: null });
      return nativeOpen.apply(this, arguments);
    };

    NativeXHR.prototype.send = function () {
      const xhr = this;
      const meta = state.get(xhr);
      if (meta) {
        const consume = function () {
          let contentType = "";
          try {
            contentType = xhr.getResponseHeader("content-type") || "";
          } catch (_) {}
          if (!/text\/event-stream/i.test(contentType)) return;

          if (!meta.parser) {
            meta.id = makeId("xhr");
            meta.parser = new Parser(event => streamEvent(meta.id, "XHR", meta.url, event));
            openConnection(meta.id, "XHR", meta.url, { method: meta.method, statusCode: xhr.status });
            connectionState(meta.id, "XHR", meta.url, "open");
          }
          let responseText;
          try {
            responseText = xhr.responseText;
          } catch (_) {
            return;
          }
          if (typeof responseText !== "string") return;
          const chunk = responseText.slice(meta.offset);
          meta.offset = responseText.length;
          if (chunk) meta.parser.feed(chunk);
        };

        xhr.addEventListener("progress", consume);
        xhr.addEventListener("readystatechange", function () {
          if (xhr.readyState >= 2) consume();
        });
        xhr.addEventListener("loadend", function () {
          consume();
          if (meta.parser) {
            meta.parser.end();
            connectionState(meta.id, "XHR", meta.url, xhr.status ? "closed" : "error");
          }
        });
      }
      return nativeSend.apply(this, arguments);
    };
  }

  installEventSourceHook();
  installFetchHook();
  installXHRHook();
  installSimulationBridge();
})();
