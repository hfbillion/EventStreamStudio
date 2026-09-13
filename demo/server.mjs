import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const pagePath = fileURLToPath(new URL("./index.html", import.meta.url));
const clients = new Set();
let counter = 840;

const server = createServer(async (request, response) => {
  if (request.url === "/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    response.write(": EventStream Studio demo\n\n");
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }

  if (request.url === "/" || request.url === "/index.html") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(await readFile(pagePath));
    return;
  }

  response.writeHead(404);
  response.end("Not found");
});

setInterval(() => {
  counter += 1;
  const data = {
    orderId: `ORD-20260913-${counter}`,
    status: ["created", "processing", "shipped"][counter % 3],
    customer: { name: "演示用户", tier: counter % 2 ? "pro" : "standard" },
    items: [{ sku: "KEY-75", quantity: 1 + (counter % 3), price: 699 }],
    progress: Number(((counter % 10) / 10).toFixed(1)),
    tags: ["demo", "realtime"],
  };
  const frame = `id: ${counter}\nevent: order.updated\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.write(frame);
}, 1500).unref();

server.listen(4173, "127.0.0.1", () => {
  console.log("EventStream demo: http://127.0.0.1:4173");
});
