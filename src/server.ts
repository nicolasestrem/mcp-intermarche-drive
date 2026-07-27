import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { GroceryClient } from "./intermarche/client.js";
import type { Cart, Product } from "./types.js";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const ADDITIVE_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const IDEMPOTENT_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function createServer(client: GroceryClient, version = "0.1.0"): McpServer {
  const server = new McpServer({ name: "mcp-intermarche-drive", version });

  server.registerTool(
    "browser_status",
    {
      description:
        "Vérifie la connexion à l'unique onglet Chromium Intermarché, le magasin actif et un éventuel challenge DataDome. À appeler avant les courses.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => run(() => client.browserStatus()),
  );

  server.registerTool(
    "search_product",
    {
      description:
        "Recherche dans le catalogue du magasin Intermarché actuellement sélectionné. Retourne les identifiants stables à passer aux outils panier.",
      inputSchema: {
        query: z.string().min(1).describe("Termes de recherche, ex. 'thon au naturel 80g'"),
        page: z.number().int().min(0).default(0).describe("Page, à partir de 0"),
        page_size: z.number().int().min(1).max(50).default(20).describe("Nombre de résultats (1 à 50)"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ query, page, page_size }) =>
      run(async () => ({ query, page, products: await client.searchProducts(query, { page, pageSize: page_size }) })),
  );

  server.registerTool(
    "get_cart",
    {
      description: "Lit le panier complet du magasin et du mode de retrait actifs.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => run(() => client.getCart()),
  );

  server.registerTool(
    "add_to_cart",
    {
      description:
        "Ajoute une quantité au produit. Les substitutions sont REFUSÉES par défaut; ne les accepte que sur demande explicite de l'utilisateur.",
      inputSchema: {
        product_id: z.string().min(1).describe("Identifiant retourné par search_product"),
        quantity: z.number().int().min(1).max(99).default(1).describe("Quantité à ajouter"),
        accept_substitution: z
          .boolean()
          .default(false)
          .describe("Autoriser un produit de substitution; false par défaut"),
      },
      annotations: ADDITIVE_WRITE_ANNOTATIONS,
    },
    async ({ product_id, quantity, accept_substitution }) =>
      run(() => client.addToCart(product_id, quantity, accept_substitution)),
  );

  server.registerTool(
    "update_quantity",
    {
      description: "Fixe la quantité absolue d'un produit du panier. Une quantité de 0 le retire.",
      inputSchema: {
        product_id: z.string().min(1).describe("Identifiant produit"),
        quantity: z.number().int().min(0).max(99).describe("Nouvelle quantité absolue"),
      },
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async ({ product_id, quantity }) => run(() => client.setQuantity(product_id, quantity)),
  );

  server.registerTool(
    "remove_from_cart",
    {
      description: "Retire complètement un produit du panier.",
      inputSchema: { product_id: z.string().min(1).describe("Identifiant produit") },
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async ({ product_id }) => run(() => client.removeFromCart(product_id)),
  );

  server.registerTool(
    "set_substitution",
    {
      description:
        "Active ou désactive explicitement les substitutions pour une ligne déjà présente dans le panier.",
      inputSchema: {
        product_id: z.string().min(1).describe("Identifiant produit déjà dans le panier"),
        accept: z.boolean().describe("true pour accepter, false pour refuser"),
      },
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async ({ product_id, accept }) => run(() => client.setSubstitution(product_id, accept)),
  );

  return server;
}

async function run(operation: () => Promise<unknown>) {
  try {
    const value = await operation();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value, jsonReplacer, 2) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
      isError: true,
    };
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

export function formatProduct(product: Product): string {
  const price = product.price === undefined ? "prix indisponible" : `${product.price.toFixed(2)} €`;
  return `${product.label} — ${price} (id=${product.id})`;
}

export function formatCart(cart: Cart): string {
  if (cart.items.length === 0) return "Panier vide.";
  const total = cart.total === undefined ? "total indisponible" : `${cart.total.toFixed(2)} €`;
  return `${cart.quantityTotal} article(s), ${total}`;
}
