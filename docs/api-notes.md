# Intermarché web adapter notes

These notes describe the private web contract currently implemented under `src/intermarche/`. They are maintenance documentation, not a public API specification.

Last checked against the Intermarché Courses frontend on 2026-07-27:

- product search was replayed through the browser and returned live catalogue data;
- basket retrieval was replayed through the browser and returned the current cart;
- quantity and substitution event construction was verified in automated tests;
- the automated live smoke test did not mutate the basket.

Do not turn "last checked" into "supported forever." Intermarché can change any endpoint, header, storage key, or response field without notice.

## Request path

```text
MCP tool
  -> IntermarcheClient
  -> serialized Throttler queue
  -> ChromeSession over loopback CDP
  -> window.fetch in the Intermarché page
  -> https://www.intermarche.com/api/...
```

`ChromeSession.fetch()` first makes sure the selected page is on the Intermarché origin. It then evaluates a `fetch` call with `credentials: "include"`. Cookies, TLS behavior, and DataDome state remain browser concerns.

The browser adapter selects targets in this order:

1. an existing Intermarché page;
2. the only blank page;
3. a new blank page, but only when no page target exists.

It refuses to repurpose an unrelated page. When several Intermarché pages exist, CDP target ordering is not a user-facing selection mechanism; keep one tab.

## Browser data boundary

### Storage snapshot

`src/intermarche/context.ts` reads only these keys:

- `itm-cart-id` from session or local storage;
- `itm-store`;
- `itm-delivery-mode`;
- `persist:analytic`, used to recover the store reference;
- `persist:cart`, used to recover the anonymous basket id and synchronization baseline.

The adapter does not enumerate the rest of local or session storage. The `authenticated` value returned by `browser_status` is an inference and is often absent; callers must not use it as an authorization decision.

### Request identifiers

The frontend sends two values as request headers. The adapter's page helper extracts them from the first-party cookies named `itm_device_id` and `itm_usid`:

```text
X-ITM-DEVICE-FP: <derived device value>
X-ITM-SESSION-ID: <browser session value>
```

Only those extracted strings leave the page evaluation. The code does not call CDP's cookie APIs, return a cookie jar through MCP, or write the values to disk. Treat them as sensitive runtime identifiers anyway. Never paste real values into tests, issues, logs, or documentation.

Other request headers currently mirror the frontend:

```text
Accept: application/json
Content-Type: application/json
X-ITM-USER-AGENT: <visible browser user agent>
X-RED-VERSION: 3
X-RED-DEVICE: red_fo_desktop
X-IS-SERVER: false
X-CALL-TRACE: web
X-B3-TRACEID: <new trace id per attempt>
X-B3-SPANID: <new span id per attempt>
X-B3-SAMPLED: 1
X-SERVICE-NAME: produits | panier
```

Search calls also send the current frontend's optional OAuth, personalization, and sponsored-page headers. These are compatibility details, not part of the MCP contract.

## Store context

The store reference, `pdvRef`, is resolved in this order:

1. `INTERMARCHE_PDV_REF` when explicitly configured;
2. recognized fields in the selected storage keys;
3. a store reference in the current URL;
4. the numeric reference under `itm-store`.

The environment override wins. That makes it useful for diagnosing a changed storage shape, but dangerous as a store switch: the visible basket and browser session can still belong to another store. Only use an override that matches the website.

`INTERMARCHE_CATALOG_ID` is compatibility metadata used as a context fallback. Product requests currently select `catalog: ["PDV"]`; the configured catalogue id does not choose a remote catalogue.

## Catalogue search

```text
POST /api/service/produits/v4/pdvs/{pdvRef}/products/byKeywordAndCategory
```

Current payload:

```json
{
  "keyword": "orangina",
  "page": 1,
  "size": 20,
  "filtres": [],
  "tri": "pertinence",
  "ordreTri": null,
  "catalog": ["PDV"]
}
```

The website request is one-based. `search_product` exposes zero-based pages and adds one in the client.

The current response puts products in `produits[]`. The normalizer also accepts a few earlier nested shapes so response-envelope changes fail less abruptly. Fields in active use include:

| Remote field | Normalized use |
| --- | --- |
| `itemId` | `Product.id`; pass this to basket tools |
| `produitEan13` / `idProduit` | `Product.ean`; informational only |
| `libelle` | label |
| `marque` | brand |
| `prix` | unit price |
| `prixKg`, `unitePrixVente.value` | display price per unit |
| `images[]` | first image URL |
| `stock`, `dispoCataloguePdv` | availability |
| `tracking.code` | optional cart-event tracking code cached after search |

Do not substitute EAN for `itemId` in basket calls. They happen to look interchangeable for some products and are not the same identifier.

## Basket synchronization

```text
POST /api/service/panier/v1/stores/{pdvRef}/carts
  ?actions=VALUATION%2CANIMATIONS
  &isActiveAnonymousPersistence=true
  [&anonymousCartId=<id>]
```

Reads and writes use the same endpoint. A read sends no events. A write sends one or more events. Both include the last synchronized basket snapshot:

```json
{
  "customerDateTime": "2026-07-27T12:00:00.000Z",
  "events": [],
  "lastSynchronizedCart": {
    "carts": [],
    "synchronizeDateTime": "2026-07-27T11:59:00.000Z"
  }
}
```

The first baseline comes from the narrow `persist:cart` snapshot when available. Each successful response replaces that in-memory baseline. This matters because sending an empty or stale baseline can overwrite or lose basket state.

Current responses contain root totals and `carts[].items[]`. `normalizeCartResponse()` accepts the current shape and a small set of older envelope names. It returns one MCP cart containing the flattened lines across sub-carts.

### Quantity event

```json
{
  "catalog": "PDV",
  "itemId": "41754",
  "quantity": 2,
  "dateTime": "2026-07-27T12:00:00.000Z",
  "type": "QUANTITY",
  "trackingCode": "<search tracking code when available>"
}
```

`quantity` is the absolute target quantity. The MCP contracts differ:

- `add_to_cart(product_id, quantity)` reads the current cart and adds the requested delta;
- `update_quantity(product_id, quantity)` sends the requested absolute value;
- `remove_from_cart(product_id)` sends an absolute value of zero.

The client serializes the whole read/modify/write cycle with `cartMutationTail`. Without that queue, two simultaneous additions could read the same old quantity and one update would be lost.

### Substitution event

```json
{
  "catalog": "PDV",
  "itemId": "41754",
  "acceptSubstitution": false,
  "dateTime": "2026-07-27T12:00:00.000Z",
  "type": "PRODUCT_SUBSTITUTION"
}
```

Adding a product sends an explicit substitution event. The default is `false`. The adapter never turns substitution consent on because the argument was omitted.

Absolute quantity events make a repeated low-level request less risky than a delta event. They do not make `add_to_cart` idempotent at the MCP level, because that tool calculates a new target from a fresh cart read.

## Throttling and failure behavior

- All Intermarché calls share one serialized queue.
- The default gap is 1.1 seconds plus up to 0.5 seconds of jitter.
- HTTP 403 and 429 receive bounded exponential backoff.
- Browser fetches use `AbortController` and CDP calls have a timeout.
- A visible DataDome challenge URL becomes an action-required message.
- The adapter does not solve CAPTCHAs, spoof fingerprints, export cookies, or open several tabs to race requests.

Do not increase retries as a response to blocking. The correct recovery is to stop, inspect the one visible tab, complete any manual challenge, and wait.

## Expected failure modes

| Symptom | First check |
| --- | --- |
| `Aucun magasin actif` | Store and Drive mode in the visible tab; changed `persist:analytic` shape |
| Search returns no normalized products | `produits[]` envelope and `itemId` / `libelle` fields |
| Basket is unexpectedly empty | `persist:cart`, `anonymousCartId`, `carts[].items[]`, and selected store |
| HTTP 400 after a write | Event names, required headers, last-synchronized snapshot shape |
| HTTP 401/403 after login or reload | Restart the MCP process to rebuild cached request identifiers, then inspect DataDome state |
| HTTP 429 | Stop requests and wait; do not add parallelism |
| Wrong store or basket | Extra tabs or a stale `INTERMARCHE_PDV_REF` override |

## Revalidation procedure

1. Use the dedicated profile and one Intermarché tab.
2. Run `browser_status` and record only non-sensitive shape information.
3. Run a product search and compare its request with the catalogue contract above.
4. Run `get_cart` and compare the empty-event request and response shape.
5. Sanitize any fixtures before saving them. Remove account data, basket ids, request identifiers, cookies, and headers derived from them.
6. Run `npm run typecheck`, `npm test`, and `npm run smoke`.
7. Run `npm run smoke:live`; it is read-only.
8. If a release claims live write support, use a disposable basket to add one item, set a quantity, toggle substitution, remove the item, and confirm the final state in the website UI.

Keep raw Intermarché fields inside `src/intermarche/`. MCP handlers should continue to work with the normalized `Product` and `Cart` types rather than importing private API shapes.
