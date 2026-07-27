import { randomUUID } from "node:crypto";

import type { IntermarcheConfig } from "../config.js";
import { delay, Throttler } from "../throttle.js";
import type { BrowserContext, BrowserPort, Cart, Product } from "../types.js";
import { readBrowserContext } from "./context.js";
import {
  normalizeCartResponse,
  normalizeSearchResponse,
  type CartState,
} from "./normalize.js";

const ORIGIN = "https://www.intermarche.com";
const RETRYABLE = new Set([403, 429]);
const productEndpoint = (pdvRef: string) =>
  `${ORIGIN}/api/service/produits/v4/pdvs/${encodeURIComponent(pdvRef)}/products/byKeywordAndCategory`;
const cartEndpoint = (pdvRef: string) =>
  `${ORIGIN}/api/service/panier/v1/stores/${encodeURIComponent(pdvRef)}/carts`;

interface ApiCartSnapshot {
  carts: unknown[];
  synchronizeDateTime: string;
}

interface CartEvent {
  catalog: "PDV";
  itemId?: string;
  quantity?: number;
  acceptSubstitution?: boolean;
  dateTime: string;
  type: "QUANTITY" | "PRODUCT_SUBSTITUTION";
  trackingCode?: string;
}

export interface SearchOptions {
  page?: number;
  pageSize?: number;
}

export interface BrowserStatus {
  connected: boolean;
  url?: string;
  title?: string;
  pdvRef?: string;
  catalogId?: string;
  deliveryMode?: string;
  cartReady?: boolean;
  authenticated?: boolean;
  actionRequired?: string;
}

export interface GroceryClient {
  browserStatus(): Promise<BrowserStatus>;
  searchProducts(query: string, options?: SearchOptions): Promise<Product[]>;
  getCart(): Promise<Cart>;
  addToCart(productId: string, quantity: number, acceptSubstitution?: boolean): Promise<Cart>;
  setQuantity(productId: string, quantity: number): Promise<Cart>;
  removeFromCart(productId: string): Promise<Cart>;
  setSubstitution(productId: string, accept: boolean): Promise<Cart>;
  close(): Promise<void>;
}

export class IntermarcheClient implements GroceryClient {
  private readonly throttler: Throttler;
  private readonly trackingCodes = new Map<string, string>();
  private cartMutationTail: Promise<void> = Promise.resolve();
  private lastCartSnapshot?: ApiCartSnapshot;
  private userAgent?: string;
  private identifiers?: { deviceFp: string; sessionId: string };

  constructor(
    private readonly config: IntermarcheConfig,
    private readonly browser: BrowserPort,
  ) {
    this.throttler = new Throttler(config);
  }

  async browserStatus(): Promise<BrowserStatus> {
    const status = await this.browser.status();
    if (!status.connected) {
      return {
        connected: false,
        actionRequired: `Démarre Chromium avec CDP sur le port ${this.config.chromePort}, puis ouvre Intermarché.`,
      };
    }
    try {
      const context = await this.context();
      const captcha = /captcha-delivery\.com|geo\.captcha-delivery\.com/i.test(context.url);
      return {
        connected: true,
        url: context.url,
        title: context.title,
        pdvRef: context.pdvRef,
        catalogId: context.catalogId,
        deliveryMode: context.deliveryMode,
        cartReady: Boolean(context.cartId),
        authenticated: context.authenticated,
        actionRequired: captcha
          ? "Résous le challenge DataDome dans l'unique onglet Chromium."
          : context.pdvRef
            ? undefined
            : "Sélectionne ton magasin et le mode Drive dans l'unique onglet Intermarché.",
      };
    } catch (error) {
      return { connected: true, url: status.url, title: status.title, actionRequired: errorMessage(error) };
    }
  }

  async searchProducts(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const trimmed = query.trim();
    if (!trimmed) throw new Error("La recherche ne peut pas être vide.");
    const context = await this.requireStoreContext();
    const page = Math.max(0, Math.trunc(options.page ?? 0));
    const pageSize = Math.min(50, Math.max(1, Math.trunc(options.pageSize ?? 20)));
    const raw = await this.request("produits", "POST", productEndpoint(context.pdvRef!), {
      keyword: trimmed,
      page: page + 1,
      size: pageSize,
      filtres: [],
      tri: "pertinence",
      ordreTri: null,
      catalog: ["PDV"],
    });
    const products = normalizeSearchResponse(raw);
    cacheTrackingCodes(raw, this.trackingCodes);
    return products;
  }

  async getCart(): Promise<Cart> {
    return (await this.readCart()).cart;
  }

  async addToCart(productId: string, quantity: number, acceptSubstitution = false): Promise<Cart> {
    if (!productId.trim()) throw new Error("product_id est requis.");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw new Error("quantity doit être un entier entre 1 et 99.");
    }
    return this.enqueueCartMutation(async () => {
      const state = await this.readCart();
      const current = state.cart.items.find((item) => item.product.id === productId)?.quantity ?? 0;
      return this.synchronizeQuantity(state, productId, current + quantity, acceptSubstitution);
    });
  }

  async setQuantity(productId: string, quantity: number): Promise<Cart> {
    if (!productId.trim()) throw new Error("product_id est requis.");
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 99) {
      throw new Error("quantity doit être un entier entre 0 et 99.");
    }
    return this.enqueueCartMutation(async () => {
      const state = await this.readCart();
      return this.synchronizeQuantity(state, productId, quantity);
    });
  }

  async removeFromCart(productId: string): Promise<Cart> {
    if (!productId.trim()) throw new Error("product_id est requis.");
    return this.enqueueCartMutation(async () => {
      const state = await this.readCart();
      return this.synchronizeQuantity(state, productId, 0);
    });
  }

  async setSubstitution(productId: string, accept: boolean): Promise<Cart> {
    if (!productId.trim()) throw new Error("product_id est requis.");
    return this.enqueueCartMutation(async () => {
      const state = await this.readCart();
      const item = state.cart.items.find((candidate) => candidate.product.id === productId);
      if (!item) throw new Error(`Le produit ${productId} n'est pas dans le panier.`);
      const now = new Date().toISOString();
      return this.synchronizeEvents(state, [
        {
          catalog: "PDV",
          itemId: productId,
          acceptSubstitution: accept,
          dateTime: now,
          type: "PRODUCT_SUBSTITUTION",
        },
      ]);
    });
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  private enqueueCartMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.cartMutationTail.then(operation);
    this.cartMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async context(): Promise<BrowserContext> {
    return readBrowserContext(this.browser, {
      pdvRef: this.config.pdvRef,
      catalogId: this.config.catalogId,
    });
  }

  private async requireStoreContext(): Promise<BrowserContext> {
    const context = await this.context();
    if (/captcha-delivery\.com/i.test(context.url)) {
      throw new Error("Challenge DataDome détecté. Résous-le manuellement dans l'unique onglet Chromium, puis réessaie.");
    }
    if (!context.pdvRef) {
      throw new Error(
        "Aucun magasin actif. Sélectionne ton magasin et le retrait Drive sur Intermarché, ou définis INTERMARCHE_PDV_REF.",
      );
    }
    return context;
  }

  private async readCart(): Promise<CartState> {
    const context = await this.requireStoreContext();
    this.lastCartSnapshot ??= snapshotFromPersistedCart(context.persistedCart);
    const raw = await this.cartRequest(context, context.cartId, []);
    this.lastCartSnapshot = snapshotFromResponse(raw);
    return normalizeCartResponse(raw, context, context.cartId ?? "");
  }

  private async synchronizeQuantity(
    state: CartState,
    productId: string,
    quantity: number,
    acceptSubstitution?: boolean,
  ): Promise<Cart> {
    const now = new Date().toISOString();
    const events: CartEvent[] = [
      {
        catalog: "PDV",
        itemId: productId,
        quantity,
        dateTime: now,
        type: "QUANTITY",
        trackingCode: this.trackingCodes.get(productId),
      },
    ];
    if (acceptSubstitution !== undefined) {
      events.push({
        catalog: "PDV",
        itemId: productId,
        acceptSubstitution,
        dateTime: now,
        type: "PRODUCT_SUBSTITUTION",
      });
    }
    return this.synchronizeEvents(state, events);
  }

  private async synchronizeEvents(state: CartState, events: CartEvent[]): Promise<Cart> {
    const context = await this.requireStoreContext();
    const raw = await this.cartRequest(context, state.cart.id || context.cartId, events);
    this.lastCartSnapshot = snapshotFromResponse(raw);
    return normalizeCartResponse(raw, context, state.cart.id).cart;
  }

  private cartRequest(
    context: BrowserContext,
    cartId: string | undefined,
    events: CartEvent[],
  ): Promise<unknown> {
    const params = new URLSearchParams({
      actions: "VALUATION,ANIMATIONS",
      isActiveAnonymousPersistence: "true",
    });
    if (cartId) params.set("anonymousCartId", cartId);
    return this.request("panier", "POST", `${cartEndpoint(context.pdvRef!)}?${params}`, {
      customerDateTime: new Date().toISOString(),
      events,
      lastSynchronizedCart:
        this.lastCartSnapshot ?? { carts: [], synchronizeDateTime: new Date().toISOString() },
    });
  }

  private async request(
    service: "produits" | "panier",
    method: "POST",
    url: string,
    body: unknown,
  ): Promise<unknown> {
    this.userAgent ??= await this.browser.evaluate<string>("navigator.userAgent");
    this.identifiers ??= await this.browser.evaluate<{ deviceFp: string; sessionId: string }>(
      `(()=>{
        const pick=name=>document.cookie.split('; ').find(v=>v.startsWith(name+'='))?.slice(name.length+1);
        const rawDevice=pick('itm_device_id');
        let deviceFp='';
        try{const parsed=JSON.parse(decodeURIComponent(rawDevice||''));deviceFp=String(parsed?.id||'')}catch{}
        if(!deviceFp)deviceFp=crypto.randomUUID();
        return {deviceFp,sessionId:decodeURIComponent(pick('itm_usid')||'')||deviceFp};
      })()`,
    );
    return this.throttler.run(async () => {
      let lastStatus = 0;
      for (let attempt = 0; attempt <= this.throttler.maxRetries; attempt++) {
        if (attempt > 0) await delay(this.throttler.backoff(attempt));
        const response = await this.browser.fetch(ORIGIN, url, {
          method,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "x-itm-session-id": this.identifiers!.sessionId,
            "x-itm-device-fp": this.identifiers!.deviceFp,
            "x-itm-user-agent": this.userAgent!,
            "x-call-trace": "web",
            "x-b3-traceid": randomUUID().replace(/-/g, ""),
            "x-b3-spanid": randomUUID().replace(/-/g, "").slice(0, 16),
            "x-b3-sampled": "1",
            "x-red-version": "3",
            "x-red-device": "red_fo_desktop",
            "x-is-server": "false",
            "x-service-name": service,
            ...(service === "produits"
              ? {
                  "x-optional-oauth": "true",
                  "x-itm-navigation-personalization-optout": "false",
                  "x-itm-sponsored-page": "true",
                }
              : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (RETRYABLE.has(response.status)) {
          lastStatus = response.status;
          continue;
        }
        if (!response.ok) {
          const detail = response.text().slice(0, 400);
          throw new Error(`Intermarché HTTP ${response.status} ${response.statusText}: ${detail}`);
        }
        return response.json();
      }
      throw new Error(
        `Intermarché bloque temporairement les requêtes (HTTP ${lastStatus}). ` +
          "Vérifie l'unique onglet Chromium, résous DataDome si demandé, puis attends avant de réessayer.",
      );
    });
  }
}

export function snapshotFromResponse(raw: unknown): ApiCartSnapshot {
  const root = asObject(raw);
  const data = asObject(root?.data) ?? root;
  return {
    carts: Array.isArray(data?.carts) ? data.carts : [],
    synchronizeDateTime:
      typeof data?.synchronizeDateTime === "string"
        ? data.synchronizeDateTime
        : new Date().toISOString(),
  };
}

export function snapshotFromPersistedCart(value: unknown): ApiCartSnapshot {
  const state = asObject(value);
  const subCarts = Array.isArray(state?.subCarts) ? state.subCarts : [];
  const carts = subCarts.flatMap((candidate) => {
    const cart = asObject(candidate);
    if (!cart) return [];
    const itemMap = asObject(cart.items) ?? {};
    const items = Object.values(itemMap).flatMap((candidateItem) => {
      const line = asObject(candidateItem);
      const product = asObject(line?.product);
      const prices = asObject(product?.prices);
      const productPrice = asObject(prices?.productPrice);
      const info = asObject(product?.informations);
      const id = scalar(product?.id);
      if (!line || !product || !id) return [];
      return [
        {
          id,
          itemParentId: scalar(product.itemParentId),
          quantity: numeric(line.qty) ?? 0,
          price: numeric(productPrice?.value),
          amount: numeric(line.total),
          acceptSubstitution: Boolean(line.acceptSubstitution),
          comment: scalar(line.comment),
          item: {
            itemId: id,
            itemParentId: scalar(product.itemParentId),
            idProduit: id,
            produitEan13: scalar(product.ean),
            pviIncrement: numeric(info?.pvi),
            prix: numeric(productPrice?.value),
            prixBarre: numeric(asObject(prices?.crossedOutPrice)?.value),
            privateData: product.privateData,
            poidsMinimum: numeric(info?.poidsMinimum),
            substituable: Boolean(product.allowSubstituable),
            dispoCataloguePdv: product.available !== false,
            stock: numeric(product.stock),
            catalog: scalar(product.type) ?? "PDV",
            libelle: scalar(info?.title),
            compatibleConsigne: Boolean(product.compatibleConsigne),
            marque: scalar(info?.brand),
            conditionnement: scalar(info?.packaging),
            qteMaxPanier: numeric(product.maxQty),
            isPresentAlcoholProduct: Boolean(info?.hasAlcohol),
          },
        },
      ];
    });
    if (items.length === 0 && numeric(cart.qty) === 0) return [];
    return [
      {
        items,
        catalog: scalar(cart.type) ?? "PDV",
        amount: numeric(cart.total) ?? 0,
        seller: {
          id: scalar(asObject(cart.seller)?.sellerId) ?? "",
          name: scalar(asObject(cart.seller)?.sellerName) ?? "",
        },
        acceptSubstitution: Boolean(cart.acceptSubstitution),
      },
    ];
  });
  return {
    carts,
    synchronizeDateTime:
      typeof state?.synchronizedAt === "string" ? state.synchronizedAt : new Date().toISOString(),
  };
}

function cacheTrackingCodes(raw: unknown, target: Map<string, string>): void {
  const root = asObject(raw);
  const products = Array.isArray(root?.produits) ? root.produits : [];
  for (const candidate of products) {
    const product = asObject(candidate);
    const id = scalar(product?.itemId);
    const code = scalar(asObject(product?.tracking)?.code);
    if (id && code) target.set(id, code);
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
