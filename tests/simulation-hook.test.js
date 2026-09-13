const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const SSEParser = require("../sse-parser.js");

class FakeEventSource extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  constructor(url) {
    super();
    this.url = new URL(url, "https://example.test/app").href;
    this.readyState = FakeEventSource.OPEN;
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

class FakeWindow extends EventTarget {
  constructor() {
    super();
    this.EventSource = FakeEventSource;
    this.EventStreamStudioSSEParser = SSEParser;
    this.location = { href: "https://example.test/app", origin: "https://example.test" };
    this.messages = [];
  }

  postMessage(data) {
    this.messages.push(data);
    const event = new Event("message");
    Object.defineProperties(event, {
      data: { value: data },
      source: { value: this },
    });
    this.dispatchEvent(event);
  }
}

test("injects a constructed event into an existing EventSource without duplicate capture", async () => {
  const window = new FakeWindow();
  const sourceText = fs.readFileSync(require.resolve("../inject-main.js"), "utf8");
  vm.runInNewContext(sourceText, {
    window,
    location: window.location,
    URL,
    Request,
    TextDecoder,
    MessageEvent,
    Event,
    EventTarget,
    Proxy,
    Promise,
    setTimeout,
  });

  const source = new window.EventSource("/events");
  const receivedByPage = [];
  source.addEventListener("order.updated", event => receivedByPage.push(event.data));
  const openMessage = window.messages.find(message => message.payload?.kind === "connection-open");

  window.postMessage({
    source: "eventstream-studio-extension",
    command: "simulate",
    targetConnectionId: openMessage.payload.connectionId,
    events: [{ event: "order.updated", id: "test-1", data: "{\"status\":\"ready\"}", delay: 0 }],
  });
  await Promise.resolve();

  const captured = window.messages.filter(message => message.payload?.kind === "event");
  assert.deepEqual(receivedByPage, ['{"status":"ready"}']);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].payload.synthetic, true);
  assert.equal(captured[0].payload.eventType, "order.updated");
  assert.equal(captured[0].payload.eventId, "test-1");
});
