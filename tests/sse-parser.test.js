const test = require("node:test");
const assert = require("node:assert/strict");
const SSEParser = require("../sse-parser.js");

test("parses standard SSE fields and joins multi-line data", () => {
  const events = [];
  const parser = new SSEParser(event => events.push(event));
  parser.feed("id: 42\nevent: order.updated\ndata: {\"id\":42,\ndata: \"ok\":true}\nretry: 3000\n\n");

  assert.deepEqual(events, [{
    data: "{\"id\":42,\n\"ok\":true}",
    event: "order.updated",
    id: "42",
    retry: 3000,
  }]);
});

test("handles arbitrary chunks and split CRLF boundaries", () => {
  const events = [];
  const parser = new SSEParser(event => events.push(event));
  ["event: met", "ric\r", "\ndata: {\"v\"", ":1}\r", "\n\r", "\n"].forEach(chunk => parser.feed(chunk));

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "metric");
  assert.equal(events[0].data, "{\"v\":1}");
});

test("ignores comments, unknown fields, invalid retry and null-containing ids", () => {
  const events = [];
  const comments = [];
  const parser = new SSEParser(event => events.push(event), comment => comments.push(comment));
  parser.feed(": keep-alive\nretry: later\nunknown: value\nid: bad\0id\ndata: hello\n\n");

  assert.deepEqual(comments, ["keep-alive"]);
  assert.deepEqual(events, [{ data: "hello", event: "message", id: undefined, retry: undefined }]);
});

test("flushes a final unterminated event", () => {
  const events = [];
  const parser = new SSEParser(event => events.push(event));
  parser.feed("data: final");
  parser.end();
  assert.equal(events[0].data, "final");
});
