import type { BrowserContext, Cart, CartItem, Product } from "../types.js";

type RawObject = Record<string, unknown>;

export interface CartState {
  cart: Cart;
  rawItems: RawObject[];
}

export interface CartChange {
  productId: string;
  quantity: number;
  acceptSubstitution?: boolean;
}

export function normalizeSearchResponse(raw: unknown): Product[] {
  return findProductArray(raw).map(normalizeProduct).filter((product): product is Product => Boolean(product));
}

export function normalizeCartResponse(
  raw: unknown,
  context: BrowserContext,
  cartId: string,
): CartState {
  const root = objectFrom(raw) ?? {};
  const rootData = objectFrom(root.data) ?? root;
  const carts = arrayOfObjects(rootData.carts);
  const envelope = carts.length > 0 ? rootData : findCartEnvelope(raw);
  const rawItems =
    carts.length > 0
      ? carts.flatMap((cart) => arrayOfObjects(cart.items ?? cart.cartItems ?? cart.lines))
      : arrayOfObjects(envelope?.cartItems ?? envelope?.items ?? envelope?.lines);
  const items = rawItems.map(normalizeCartItem).filter((item): item is CartItem => Boolean(item));
  const total =
    numberFrom(rootData, ["amount", "total", "totalPrice", "price"]) ??
    numberFrom(envelope, ["amount", "total", "totalPrice", "price"]);
  return {
    rawItems,
    cart: {
      id: stringFrom(rootData, ["id", "cartId"]) || stringFrom(envelope, ["id", "cartId"]) || cartId,
      items,
      itemCount: items.length,
      quantityTotal: items.reduce((sum, item) => sum + item.quantity, 0),
      total,
      pdvRef: context.pdvRef ?? "",
      deliveryMode: context.deliveryMode,
    },
  };
}

export function buildCartItemsPayload(rawItems: RawObject[], change?: CartChange): Array<{
  ipeas: string[];
  quantity: number;
  acceptSubstitution: boolean;
}> {
  const items = new Map<string, { ipeas: string[]; quantity: number; acceptSubstitution: boolean }>();
  for (const raw of rawItems) {
    const ipeas = extractIpeas(raw);
    if (ipeas.length === 0) continue;
    const quantity = integerFrom(raw, ["quantity", "qty", "count"]) ?? 0;
    items.set(ipeas[0], {
      ipeas,
      quantity,
      acceptSubstitution: booleanFrom(raw, ["acceptSubstitution", "substitutionAccepted"]) ?? false,
    });
  }
  if (change) {
    const existing = items.get(change.productId);
    if (change.quantity <= 0) {
      items.delete(change.productId);
    } else {
      items.set(change.productId, {
        ipeas: existing?.ipeas ?? [change.productId],
        quantity: change.quantity,
        acceptSubstitution: change.acceptSubstitution ?? existing?.acceptSubstitution ?? false,
      });
    }
  }
  return [...items.values()].filter((item) => item.quantity > 0);
}

function normalizeProduct(raw: RawObject): Product | null {
  const descriptor = objectFrom(raw.descriptor) ?? {};
  const pricing = objectFrom(raw.pricing) ?? {};
  const currentPrice = objectFrom(pricing.currentPrice) ?? objectFrom(raw.currentPrice) ?? {};
  const id = stringFrom(raw, ["itemId", "objectRef", "ipea", "identifier", "id", "productId", "ean"]);
  const label =
    stringFrom(raw, ["libelle"]) ||
    stringFrom(descriptor, ["name", "label", "title"]) ||
    stringFrom(raw, ["name", "label", "title", "displayName"]);
  if (!id || !label) return null;
  const brandObject = objectFrom(raw.brand) ?? objectFrom(descriptor.brand);
  const brand =
    stringFrom(raw, ["marque"]) ||
    (brandObject ? stringFrom(brandObject, ["label", "name"]) : undefined) ||
    (typeof raw.brand === "string" ? raw.brand : undefined);
  const price =
    numberFrom(raw, ["prix"]) ??
    numberFrom(currentPrice, ["price", "value", "amount"]) ??
    numberFrom(pricing, ["price", "value", "amount"]) ??
    numberFrom(raw, ["price", "unitPrice"]);
  const media = arrayOfObjects(raw.media);
  const imageStrings = Array.isArray(raw.images)
    ? raw.images.filter((value): value is string => typeof value === "string")
    : [];
  const imageUrl =
    imageStrings[0] ||
    stringFrom(media[0], ["url", "src", "href"]) ||
    stringFrom(raw, ["imageUrl", "image", "thumbnail"]);
  const pricePerUnit =
    stringFrom(pricing, ["unitPriceLabel", "pricePerUnit", "unitPrice"]) ||
    stringFrom(raw, ["pricePerUnit"]) ||
    formatUnitPrice(raw);
  const offline = booleanFrom(raw, ["offline", "disabled", "unavailable"]);
  const listedAvailable = booleanFrom(raw, ["dispoCataloguePdv", "available", "orderable", "inStock"]);
  const stock = numberFrom(raw, ["stock"]);
  const available = listedAvailable === false || stock === 0 ? false : listedAvailable ?? !offline;
  const ean = stringFrom(raw, ["produitEan13", "idProduit", "ean", "gtin"]);
  return { id, label, brand, price, pricePerUnit, available, imageUrl, ean };
}

function normalizeCartItem(raw: RawObject): CartItem | null {
  const nested = objectFrom(raw.item) ?? objectFrom(raw.product) ?? objectFrom(raw.productData);
  const product = nested ? normalizeProduct(nested) : normalizeProduct({ ...raw, objectRef: extractIpeas(raw)[0] });
  if (!product) return null;
  const quantity = integerFrom(raw, ["quantity", "qty", "count"]) ?? 0;
  const acceptSubstitution = booleanFrom(raw, ["acceptSubstitution", "substitutionAccepted"]) ?? false;
  const lineTotal =
    numberFrom(raw, ["lineTotal", "total", "totalPrice", "amount"]) ??
    (product.price === undefined ? undefined : roundMoney(product.price * quantity));
  return { product, quantity, acceptSubstitution, lineTotal };
}

function findProductArray(raw: unknown): RawObject[] {
  const root = objectFrom(raw);
  if (!root) return [];
  const direct = arrayOfObjects(root.produits ?? root.products ?? root.items ?? root.results);
  if (direct.length > 0) return direct;
  const data = objectFrom(root.data);
  if (data) {
    const inData = findProductArray(data);
    if (inData.length > 0) return inData;
    for (const catalog of arrayOfObjects(data.catalogs)) {
      const found = findProductArray(catalog);
      if (found.length > 0) return found;
    }
  }
  for (const value of Object.values(root)) {
    if (value && typeof value === "object") {
      const found = findProductArray(value);
      if (found.length > 0) return found;
    }
  }
  return [];
}

function findCartEnvelope(raw: unknown, depth = 0): RawObject | undefined {
  const root = objectFrom(raw);
  if (!root || depth > 8) return undefined;
  if (Array.isArray(root.cartItems) || Array.isArray(root.items) || Array.isArray(root.lines)) return root;
  for (const preferred of ["cart", "basket", "data", "result"]) {
    const nested = findCartEnvelope(root[preferred], depth + 1);
    if (nested) return nested;
  }
  for (const value of Object.values(root)) {
    const nested = findCartEnvelope(value, depth + 1);
    if (nested) return nested;
  }
  return root;
}

function extractIpeas(raw: RawObject): string[] {
  if (Array.isArray(raw.ipeas)) return raw.ipeas.map(String).filter(Boolean);
  const product = objectFrom(raw.item) ?? objectFrom(raw.product) ?? objectFrom(raw.productData);
  const id =
    stringFrom(raw, ["itemId", "objectRef", "ipea", "productId", "id", "ean"]) ||
    (product
      ? stringFrom(product, ["itemId", "objectRef", "ipea", "productId", "id", "ean"])
      : undefined);
  return id ? [id] : [];
}

function objectFrom(value: unknown): RawObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RawObject) : undefined;
}

function arrayOfObjects(value: unknown): RawObject[] {
  return Array.isArray(value) ? value.filter((item): item is RawObject => Boolean(objectFrom(item))) : [];
}

function stringFrom(object: RawObject | undefined, keys: string[]): string | undefined {
  if (!object) return undefined;
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function numberFrom(object: RawObject | undefined, keys: string[]): number | undefined {
  if (!object) return undefined;
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value.replace(",", ".").replace(/[^\d.-]/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
    const nested = objectFrom(value);
    if (nested) {
      const amount = numberFrom(nested, ["price", "value", "amount"]);
      if (amount !== undefined) return amount;
    }
  }
  return undefined;
}

function integerFrom(object: RawObject, keys: string[]): number | undefined {
  const value = numberFrom(object, keys);
  return value === undefined ? undefined : Math.max(0, Math.trunc(value));
}

function booleanFrom(object: RawObject, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && /^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  }
  return undefined;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function formatUnitPrice(raw: RawObject): string | undefined {
  const value = numberFrom(raw, ["prixKg", "unitPrice"]);
  if (value === undefined) return undefined;
  const unit = objectFrom(raw.unitePrixVente);
  const label = unit ? stringFrom(unit, ["value", "label"]) : undefined;
  return `${value.toFixed(2).replace(".", ",")} ${label ?? "€/unité"}`;
}
