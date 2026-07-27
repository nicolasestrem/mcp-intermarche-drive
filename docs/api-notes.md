# Intermarché web adapter notes

Live-validated on 2026-07-27 against the current Intermarché Courses frontend. These endpoints are private and undocumented; all assumptions stay isolated in `src/intermarche/`.

## Execution model

Requests run through `window.fetch` in one visible `https://www.intermarche.com` tab attached over CDP. The browser applies its own same-origin cookies and DataDome state through `credentials: "include"`.

The adapter never reads authentication cookies or tokens. It reads only the first-party, non-auth `itm_device_id` and `itm_usid` identifiers so MCP requests match the browser's own web requests. Those values remain in memory and never appear in tool results, logs or files.

Common request headers mirror the current frontend:

```text
Content-Type: application/json
X-ITM-DEVICE-FP: <browser device identifier>
X-ITM-SESSION-ID: <browser session identifier>
X-ITM-USER-AGENT: <visible browser user agent>
X-RED-VERSION: 3
X-RED-DEVICE: red_fo_desktop
X-IS-SERVER: false
X-CALL-TRACE: web
X-B3-TRACEID: <per-request trace id>
X-B3-SPANID: <per-request span id>
```

## Catalogue search

```text
POST /api/service/produits/v4/pdvs/{pdvRef}/products/byKeywordAndCategory
```

Payload:

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

The website uses one-based pages. MCP exposes zero-based pages and translates them.

Products are returned in `produits[]`. Stable cart identifiers use `itemId`; EAN is kept separately. Important fields include `libelle`, `marque`, `prix`, `prixKg`, `unitePrixVente.value`, `images[]`, `stock`, `dispoCataloguePdv`, `produitEan13` and `tracking.code`.

## Basket API

```text
POST /api/service/panier/v1/stores/{pdvRef}/carts
  ?actions=VALUATION%2CANIMATIONS
  &isActiveAnonymousPersistence=true
  [&anonymousCartId=<id>]
```

The current API is event-based. Reads send no events; mutations send absolute-state events. Every request also includes the last synchronized basket snapshot.

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

Quantity event:

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

Substitution event:

```json
{
  "catalog": "PDV",
  "itemId": "41754",
  "acceptSubstitution": false,
  "dateTime": "2026-07-27T12:00:00.000Z",
  "type": "PRODUCT_SUBSTITUTION"
}
```

A quantity event is absolute, so retries are idempotent. New items get an explicit substitution event and default to `false`; consent is never enabled implicitly.

Current responses contain root totals plus `carts[].items[]`. The client keeps the latest response as its synchronization baseline. On startup it reconstructs the baseline from the site's non-secret `persist:cart` Redux state so it does not discard an existing anonymous basket.

## Browser state

Only these non-secret storage keys are inspected:

- `itm-store`
- `itm-delivery-mode`
- `persist:analytic` (store reference)
- `persist:cart` (basket state)

The adapter no longer dumps all local/session storage. Auth storage, cookies and tokens are outside the browser-state snapshot.

## Anti-bot behavior

- Calls are serialized and spaced by 1.1–1.6 seconds by default.
- HTTP 403/429 receives bounded exponential backoff.
- CDP commands are time-bounded.
- A DataDome interstitial becomes a clear action-required error.
- No CAPTCHA solver, fingerprint spoofing or auth-cookie replay is implemented.
- One existing Intermarché tab is reused; unrelated tabs are never commandeered.
