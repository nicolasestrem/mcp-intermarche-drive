export interface Product {
  id: string;
  label: string;
  brand?: string;
  price?: number;
  pricePerUnit?: string;
  available: boolean;
  imageUrl?: string;
  ean?: string;
}

export interface CartItem {
  product: Product;
  quantity: number;
  acceptSubstitution: boolean;
  lineTotal?: number;
}

export interface Cart {
  id: string;
  items: CartItem[];
  itemCount: number;
  quantityTotal: number;
  total?: number;
  pdvRef: string;
  deliveryMode: string;
}

export interface BrowserContext {
  url: string;
  title: string;
  cartId?: string;
  pdvRef?: string;
  catalogId?: string;
  deliveryMode: string;
  authenticated?: boolean;
  /** Redux-persist basket state; cart data only, never auth/cookies. */
  persistedCart?: unknown;
}

export interface FetchResponse {
  status: number;
  ok: boolean;
  statusText: string;
  text(): string;
  json(): unknown;
}

export interface BrowserPort {
  fetch(
    baseUrl: string,
    url: string,
    options?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<FetchResponse>;
  evaluate<T>(expression: string): Promise<T>;
  status(): Promise<{ connected: boolean; url?: string; title?: string }>;
  close(): Promise<void>;
}
