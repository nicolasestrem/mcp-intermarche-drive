import type { BrowserContext, BrowserPort } from "../types.js";

interface StorageSnapshot {
  url: string;
  title: string;
  session: Record<string, string>;
  local: Record<string, string>;
}

interface ContextOverrides {
  pdvRef?: string;
  catalogId: string;
}

const SNAPSHOT_EXPRESSION = `(()=>({
  url:location.href,
  title:document.title,
  session:Object.fromEntries(['itm-cart-id','itm-store','itm-delivery-mode'].map(k=>[k,sessionStorage.getItem(k)??''])),
  local:Object.fromEntries(['itm-cart-id','itm-store','itm-delivery-mode','persist:cart','persist:analytic'].map(k=>[k,localStorage.getItem(k)??'']))
}))()`;

export async function readBrowserContext(
  browser: BrowserPort,
  overrides: ContextOverrides,
): Promise<BrowserContext> {
  const snapshot = await browser.evaluate<StorageSnapshot>(SNAPSHOT_EXPRESSION);
  return extractContext(snapshot, overrides);
}

export function extractContext(
  snapshot: StorageSnapshot,
  overrides: ContextOverrides,
): BrowserContext {
  const storage = { ...snapshot.local, ...snapshot.session };
  const parsed = Object.entries(storage).map(([key, value]) => [key, parseStorage(value)] as const);
  const persistedCart = decodeReduxPersist(storage["persist:cart"]);
  const cartId =
    scalarString(objectValue(persistedCart, "basketId")) ||
    firstString(storage, ["itm-cart-id", "cartId", "cart-id"]);
  const deliveryMode =
    firstString(storage, ["itm-delivery-mode", "deliveryMode", "delivery-mode"]) ||
    findByKey(parsed, /delivery.?mode/i) ||
    "DRIVE";
  const pdvRef =
    overrides.pdvRef ||
    findByKey(parsed, /^(pdvRef|pdvReference|pointDeVenteRef|storeRef|store_id_itm)$/i) ||
    parsePdvFromUrl(snapshot.url) ||
    numericStoreValue(storage["itm-store"]);
  const catalogId =
    findByKey(parsed, /^(catalogId|catalogRef|catalogueId|catalogueRef)$/i) || overrides.catalogId;
  const authenticated = inferAuthentication(parsed);

  return {
    url: snapshot.url,
    title: snapshot.title,
    cartId,
    pdvRef,
    catalogId,
    deliveryMode: deliveryMode.toUpperCase(),
    authenticated,
    persistedCart,
  };
}

export async function ensureCartId(browser: BrowserPort, current?: string): Promise<string> {
  if (current) return current;
  return browser.evaluate<string>(`(()=>{
    const id=crypto.randomUUID();
    sessionStorage.setItem('itm-cart-id',id);
    return id;
  })()`);
}

function firstString(storage: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const match = Object.entries(storage).find(([candidate]) => candidate.toLowerCase() === key.toLowerCase());
    if (match?.[1]?.trim()) return stripQuotes(match[1].trim());
  }
  return undefined;
}

function parseStorage(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function decodeReduxPersist(value?: string): unknown {
  if (!value) return undefined;
  const outer = parseStorage(value);
  if (!outer || typeof outer !== "object" || Array.isArray(outer)) return outer;
  return Object.fromEntries(
    Object.entries(outer as Record<string, unknown>).map(([key, nested]) => [
      key,
      typeof nested === "string" ? parseStorage(nested) : nested,
    ]),
  );
}

function objectValue(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function findByKey(entries: ReadonlyArray<readonly [string, unknown]>, pattern: RegExp): string | undefined {
  for (const [outerKey, value] of entries) {
    if (pattern.test(outerKey)) {
      const scalar = scalarString(value);
      if (scalar) return scalar;
    }
    const nested = walkObject(value, pattern);
    if (nested) return nested;
  }
  return undefined;
}

function walkObject(value: unknown, pattern: RegExp, depth = 0): string | undefined {
  if (typeof value === "string") {
    const parsed = parseStorage(value);
    if (parsed !== value) return walkObject(parsed, pattern, depth + 1);
  }
  if (!value || typeof value !== "object" || depth > 8) return undefined;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (pattern.test(key)) {
      const scalar = scalarString(nested);
      if (scalar) return scalar;
    }
    const found = walkObject(nested, pattern, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return stripQuotes(value.trim());
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

function numericStoreValue(value?: string): string | undefined {
  if (!value) return undefined;
  const parsed = parseStorage(value);
  const direct = scalarString(parsed);
  if (direct && /^\d{3,}$/.test(direct)) return direct;
  if (parsed && typeof parsed === "object") {
    return walkObject(parsed, /^(pdvRef|reference|ref)$/i);
  }
  return undefined;
}

function parsePdvFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    for (const key of ["pdvRef", "pdv", "store", "storeId"]) {
      const value = parsed.searchParams.get(key);
      if (value) return value;
    }
    const match = parsed.pathname.match(/(?:pdv|magasin|store)[/-](\d{3,})/i);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function inferAuthentication(entries: ReadonlyArray<readonly [string, unknown]>): boolean | undefined {
  const logged = findByKey(entries, /^(isClientLogged|isLogged|authenticated)$/i);
  if (logged) return ["true", "1", "yes"].includes(logged.toLowerCase());
  const tokenish = entries.some(([key, value]) =>
    /(client|customer|user).*(profile|account|identity)/i.test(key) && Boolean(value),
  );
  return tokenish ? true : undefined;
}
