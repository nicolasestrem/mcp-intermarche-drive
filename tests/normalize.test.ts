import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCartItemsPayload,
  normalizeCartResponse,
  normalizeSearchResponse,
} from "../src/intermarche/normalize.js";

const product = {
  objectRef: "P001",
  descriptor: { name: "Thon au naturel 80 g" },
  brand: { label: "Marque Test" },
  pricing: { currentPrice: { price: 1.49 }, unitPriceLabel: "18,63 €/kg" },
  media: [{ url: "https://img.example/P001.jpg" }],
  offline: false,
};

test("normalizes Intermarché catalog products", () => {
  const products = normalizeSearchResponse({
    data: { catalogs: [{ data: { products: [product] } }] },
  });
  assert.deepEqual(products, [
    {
      id: "P001",
      label: "Thon au naturel 80 g",
      brand: "Marque Test",
      price: 1.49,
      pricePerUnit: "18,63 €/kg",
      available: true,
      imageUrl: "https://img.example/P001.jpg",
      ean: undefined,
    },
  ]);
});

test("normalizes the current v4 product and panier APIs", () => {
  const [current] = normalizeSearchResponse({
    produits: [
      {
        itemId: "41754",
        idProduit: "3103220035580",
        produitEan13: "3103220035580",
        libelle: "Bonbons acidulés Orangina Pik",
        marque: "Haribo",
        prix: 1.73,
        prixKg: 6.92,
        unitePrixVente: { value: "€/Kg" },
        images: ["https://img.example/current.jpg"],
        stock: 21,
        dispoCataloguePdv: true,
      },
    ],
  });
  assert.equal(current.id, "41754");
  assert.equal(current.ean, "3103220035580");
  assert.equal(current.price, 1.73);
  assert.equal(current.pricePerUnit, "6,92 €/Kg");

  const state = normalizeCartResponse(
    {
      id: "cart-current",
      synchronizeDateTime: "2026-07-27T12:00:00Z",
      amount: 3.46,
      carts: [
        {
          catalog: "PDV",
          items: [
            {
              id: "41754",
              quantity: 2,
              amount: 3.46,
              acceptSubstitution: false,
              item: {
                itemId: "41754",
                produitEan13: "3103220035580",
                libelle: "Bonbons acidulés Orangina Pik",
                marque: "Haribo",
                prix: 1.73,
              },
            },
          ],
        },
      ],
    },
    { url: "", title: "", pdvRef: "11327", deliveryMode: "DRIVE" },
    "",
  );
  assert.equal(state.cart.id, "cart-current");
  assert.equal(state.cart.quantityTotal, 2);
  assert.equal(state.cart.total, 3.46);
  assert.equal(state.cart.items[0].product.id, "41754");
});

test("normalizes cart and preserves substitution flags", () => {
  const state = normalizeCartResponse(
    {
      data: {
        cart: {
          id: "cart-1",
          total: 2.98,
          cartItems: [{ product, ipeas: ["P001"], quantity: 2, acceptSubstitution: true }],
        },
      },
    },
    { url: "", title: "", pdvRef: "10686", deliveryMode: "DRIVE" },
    "fallback",
  );
  assert.equal(state.cart.items[0].quantity, 2);
  assert.equal(state.cart.items[0].acceptSubstitution, true);
  assert.equal(state.cart.total, 2.98);
  assert.deepEqual(buildCartItemsPayload(state.rawItems), [
    { ipeas: ["P001"], quantity: 2, acceptSubstitution: true },
  ]);
});

test("cart payload updates one line, keeps others, defaults new substitutions to false", () => {
  const raw = [
    { ipeas: ["A"], quantity: 2, acceptSubstitution: true },
    { ipeas: ["B"], quantity: 1, acceptSubstitution: false },
  ];
  assert.deepEqual(buildCartItemsPayload(raw, { productId: "A", quantity: 3 }), [
    { ipeas: ["A"], quantity: 3, acceptSubstitution: true },
    { ipeas: ["B"], quantity: 1, acceptSubstitution: false },
  ]);
  assert.deepEqual(buildCartItemsPayload(raw, { productId: "C", quantity: 1 }), [
    { ipeas: ["A"], quantity: 2, acceptSubstitution: true },
    { ipeas: ["B"], quantity: 1, acceptSubstitution: false },
    { ipeas: ["C"], quantity: 1, acceptSubstitution: false },
  ]);
  assert.deepEqual(buildCartItemsPayload(raw, { productId: "A", quantity: 0 }), [
    { ipeas: ["B"], quantity: 1, acceptSubstitution: false },
  ]);
});
