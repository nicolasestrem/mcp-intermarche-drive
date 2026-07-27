import test from "node:test";
import assert from "node:assert/strict";

import type { IntermarcheConfig } from "../src/config.js";
import { IntermarcheClient } from "../src/intermarche/client.js";
import type { BrowserPort, FetchResponse } from "../src/types.js";

const baseConfig: IntermarcheConfig = {
  chromeProfileDir: "/tmp/test",
  chromePort: 9222,
  headless: false,
  autoLaunch: false,
  catalogId: "641",
  minIntervalMs: 0,
  jitterMs: 0,
  maxRetries: 0,
  backoffBaseMs: 0,
  cdpTimeoutMs: 1000,
};

class FakeBrowser implements BrowserPort {
  calls: Array<{ url: string; method: string; body?: string; headers?: Record<string, string> }> = [];
  quantity = 1;
  acceptSubstitution = true;

  async status() {
    return { connected: true, url: "https://www.intermarche.com/drive-catalogue", title: "Intermarché" };
  }

  async evaluate<T>(expression: string): Promise<T> {
    if (expression === "navigator.userAgent") return "Test Browser" as T;
    if (expression.includes("itm_device_id")) {
      return { deviceFp: "device-test", sessionId: "session-test" } as T;
    }
    if (expression.includes("url:location.href")) {
      return {
        url: "https://www.intermarche.com/drive-catalogue",
        title: "Intermarché",
        session: {
          "itm-cart-id": "cart-1",
          "itm-delivery-mode": "DRIVE",
          "itm-store": JSON.stringify({ reference: "10686", catalogId: "641" }),
        },
        local: {},
      } as T;
    }
    throw new Error(`Unexpected evaluate: ${expression}`);
  }

  async fetch(
    _base: string,
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<FetchResponse> {
    const method = options.method ?? "GET";
    this.calls.push({ url, method, body: options.body, headers: options.headers });
    if (url.includes("byKeywordAndCategory")) {
      return response({
        produits: [
          {
            itemId: "P1",
            idProduit: "EAN1",
            libelle: "Orangina",
            marque: "Orangina",
            prix: 1.9,
            stock: 12,
            dispoCataloguePdv: true,
            tracking: { code: "tracking-1" },
          },
        ],
      });
    }
    const payload = JSON.parse(options.body ?? "{}") as {
      events: Array<{ type: string; itemId?: string; quantity?: number; acceptSubstitution?: boolean }>;
    };
    for (const event of payload.events) {
      if (event.type === "QUANTITY" && event.itemId === "P1") this.quantity = event.quantity ?? 0;
      if (event.type === "PRODUCT_SUBSTITUTION" && event.itemId === "P1") {
        this.acceptSubstitution = event.acceptSubstitution ?? false;
      }
    }
    return response({
      id: "cart-1",
      synchronizeDateTime: new Date().toISOString(),
      amount: this.quantity * 1.9,
      itemsNumber: this.quantity,
      carts:
        this.quantity === 0
          ? []
          : [
              {
                catalog: "PDV",
                amount: this.quantity * 1.9,
                itemsNumber: this.quantity,
                items: [
                  {
                    id: "P1",
                    quantity: this.quantity,
                    amount: this.quantity * 1.9,
                    acceptSubstitution: this.acceptSubstitution,
                    item: { itemId: "P1", idProduit: "EAN1", libelle: "Orangina", marque: "Orangina", prix: 1.9 },
                  },
                ],
              },
            ],
    });
  }

  async close() {}
}

test("search sends the current v4 product request with browser identifiers", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  const products = await client.searchProducts("orangina", { pageSize: 3 });
  assert.equal(products[0].id, "P1");
  assert.match(browser.calls[0].url, /\/produits\/v4\/pdvs\/10686\/products\/byKeywordAndCategory$/);
  const payload = JSON.parse(browser.calls[0].body!);
  assert.deepEqual(payload, {
    keyword: "orangina",
    page: 1,
    size: 3,
    filtres: [],
    tri: "pertinence",
    ordreTri: null,
    catalog: ["PDV"],
  });
  assert.equal(browser.calls[0].headers?.["x-itm-device-fp"], "device-test");
});

test("add sends absolute quantity and explicit substitution events", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  const cart = await client.addToCart("P1", 2, false);
  assert.equal(cart.quantityTotal, 3);
  const write = browser.calls.at(-1);
  assert.ok(write);
  const payload = JSON.parse(write.body!) as { events: Array<Record<string, unknown>> };
  assert.equal(payload.events[0].type, "QUANTITY");
  assert.equal(payload.events[0].quantity, 3);
  assert.equal(payload.events[0].trackingCode, undefined);
  assert.equal(payload.events[1].type, "PRODUCT_SUBSTITUTION");
  assert.equal(payload.events[1].acceptSubstitution, false);
});

test("concurrent cart mutations serialize the full read-modify-write cycle", async () => {
  const browser = new FakeBrowser();
  const client = new IntermarcheClient(baseConfig, browser);
  const [first, second] = await Promise.all([
    client.addToCart("P1", 2, false),
    client.addToCart("P1", 2, false),
  ]);
  assert.equal(first.quantityTotal, 3);
  assert.equal(second.quantityTotal, 5);
  assert.equal(browser.quantity, 5);
});

function response(body: unknown): FetchResponse {
  const text = JSON.stringify(body);
  return { status: 200, ok: true, statusText: "OK", text: () => text, json: () => body };
}
