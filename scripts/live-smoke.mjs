import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const child = spawn(process.execPath, ["dist/src/index.js"], {
  cwd: new URL("..", import.meta.url),
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, INTERMARCHE_AUTO_LAUNCH: "false" },
});
const lines = createInterface({ input: child.stdout });
let id = 0;
const pending = new Map();
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const waiter = pending.get(message.id);
  if (waiter) {
    pending.delete(message.id);
    waiter.resolve(message);
  }
});

function request(method, params = {}, timeoutMs = 45000) {
  const requestId = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), timeoutMs);
    pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject });
  });
}

async function callTool(name, args = {}) {
  const reply = await request("tools/call", { name, arguments: args });
  if (reply.error) throw new Error(JSON.stringify(reply.error));
  const text = reply.result?.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error(`No text result from ${name}`);
  const parsed = JSON.parse(text);
  if (reply.result.isError) throw new Error(`${name}: ${parsed.error ?? text}`);
  return parsed;
}

try {
  await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "live-smoke", version: "1.0.0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const status = await callTool("browser_status");
  if (!status.connected) throw new Error(`Browser unavailable: ${status.actionRequired ?? "unknown"}`);
  if (status.actionRequired) throw new Error(`Browser action required: ${status.actionRequired}`);
  const search = await callTool("search_product", { query: "orangina", page: 0, page_size: 3 });
  if (!Array.isArray(search.products) || search.products.length === 0) {
    throw new Error("Live search returned no products");
  }
  const cart = await callTool("get_cart");
  if (!Array.isArray(cart.items)) throw new Error("Live cart response has no items array");
  console.log(
    JSON.stringify(
      { ok: true, status, productCount: search.products.length, sample: search.products[0], cart },
      null,
      2,
    ),
  );
} finally {
  child.kill("SIGTERM");
}
