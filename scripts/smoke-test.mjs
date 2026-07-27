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

function request(method, params = {}) {
  const requestId = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 5000);
    pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject });
  });
}

try {
  const initialized = await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "1.0.0" },
  });
  if (initialized.error) throw new Error(JSON.stringify(initialized.error));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await request("tools/list");
  if (listed.error) throw new Error(JSON.stringify(listed.error));
  const names = listed.result.tools.map((tool) => tool.name);
  const expected = [
    "browser_status",
    "search_product",
    "get_cart",
    "add_to_cart",
    "update_quantity",
    "remove_from_cart",
    "set_substitution",
  ];
  for (const name of expected) {
    if (!names.includes(name)) throw new Error(`Missing MCP tool: ${name}`);
  }
  const byName = Object.fromEntries(listed.result.tools.map((tool) => [tool.name, tool]));
  if (byName.search_product.annotations?.readOnlyHint !== true) {
    throw new Error("search_product must advertise readOnlyHint=true");
  }
  if (byName.add_to_cart.annotations?.destructiveHint !== false) {
    throw new Error("add_to_cart must advertise destructiveHint=false");
  }
  if (byName.remove_from_cart.annotations?.destructiveHint !== true) {
    throw new Error("remove_from_cart must advertise destructiveHint=true");
  }
  console.log(JSON.stringify({ ok: true, server: initialized.result.serverInfo, tools: names }, null, 2));
} finally {
  child.kill("SIGTERM");
}
