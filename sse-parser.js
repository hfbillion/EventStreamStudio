(function (root, factory) {
  const Parser = factory();
  if (typeof window === "undefined" && typeof module === "object" && module.exports) module.exports = Parser;
  else Object.defineProperty(root, "EventStreamStudioSSEParser", {
    value: Parser,
    configurable: true,
  });
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  class SSEParser {
    constructor(onEvent, onComment) {
      this.onEvent = onEvent;
      this.onComment = onComment || function () {};
      this.buffer = "";
      this.data = [];
      this.event = "";
      this.id = undefined;
      this.retry = undefined;
      this.pendingCR = false;
    }

    feed(chunk) {
      if (this.pendingCR) {
        if (chunk[0] === "\n") chunk = chunk.slice(1);
        this.pendingCR = false;
      }
      this.buffer += chunk;
      let start = 0;
      for (let index = 0; index < this.buffer.length; index += 1) {
        if (this.buffer[index] !== "\n" && this.buffer[index] !== "\r") continue;
        const line = this.buffer.slice(start, index);
        if (this.buffer[index] === "\r") {
          if (this.buffer[index + 1] === "\n") index += 1;
          else if (index === this.buffer.length - 1) this.pendingCR = true;
        }
        start = index + 1;
        this.processLine(line);
      }
      this.buffer = this.buffer.slice(start);
    }

    end() {
      if (this.buffer) this.processLine(this.buffer);
      this.buffer = "";
      this.dispatch();
    }

    processLine(line) {
      if (line === "") {
        this.dispatch();
        return;
      }
      if (line[0] === ":") {
        this.onComment(line.slice(1).replace(/^ /, ""));
        return;
      }
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value[0] === " ") value = value.slice(1);

      if (field === "data") this.data.push(value);
      else if (field === "event") this.event = value;
      else if (field === "id" && !value.includes("\0")) this.id = value;
      else if (field === "retry" && /^\d+$/.test(value)) this.retry = Number(value);
    }

    dispatch() {
      if (this.data.length === 0) {
        this.event = "";
        this.retry = undefined;
        return;
      }
      this.onEvent({
        data: this.data.join("\n"),
        event: this.event || "message",
        id: this.id,
        retry: this.retry,
      });
      this.data = [];
      this.event = "";
      this.retry = undefined;
    }
  }

  return SSEParser;
});
