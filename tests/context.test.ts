import test from "node:test";
import assert from "node:assert/strict";

import { extractContext } from "../src/intermarche/context.js";

test("extractContext finds store, cart, mode and login without cookies", () => {
  const context = extractContext(
    {
      url: "https://www.intermarche.com/drive-catalogue",
      title: "Intermarché",
      session: {
        "itm-cart-id": "cart-123",
        "itm-delivery-mode": "drive",
        "itm-store": JSON.stringify({ reference: "10686", catalogId: "641" }),
      },
      local: { profile: JSON.stringify({ authenticated: true }) },
    },
    { catalogId: "fallback" },
  );
  assert.equal(context.cartId, "cart-123");
  assert.equal(context.pdvRef, "10686");
  assert.equal(context.catalogId, "641");
  assert.equal(context.deliveryMode, "DRIVE");
  assert.equal(context.authenticated, true);
});

test("explicit pdv override wins and catalog falls back", () => {
  const context = extractContext(
    { url: "about:blank", title: "", session: {}, local: {} },
    { pdvRef: "99999", catalogId: "641" },
  );
  assert.equal(context.pdvRef, "99999");
  assert.equal(context.catalogId, "641");
  assert.equal(context.deliveryMode, "DRIVE");
});

test("extracts current site Redux-persist store and anonymous cart id", () => {
  const context = extractContext(
    {
      url: "https://www.intermarche.com/recherche/orangina",
      title: "Intermarché",
      session: {},
      local: {
        "persist:analytic": JSON.stringify({
          dataLayer: JSON.stringify({ store_id_itm: "11327" }),
        }),
        "persist:cart": JSON.stringify({
          basketId: JSON.stringify("anonymous-cart-1"),
          synchronizedAt: JSON.stringify("2026-07-27T12:00:00Z"),
          subCarts: JSON.stringify([]),
        }),
      },
    },
    { catalogId: "641" },
  );
  assert.equal(context.pdvRef, "11327");
  assert.equal(context.cartId, "anonymous-cart-1");
  assert.deepEqual(context.persistedCart, {
    basketId: "anonymous-cart-1",
    synchronizedAt: "2026-07-27T12:00:00Z",
    subCarts: [],
  });
});
