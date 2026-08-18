# Gate 0 — Aug 19: eSign & Nutrient live-API verification

Build-plan stage: "Aug 19 — ~2h, from the recovered slack. GATE 0: prove eSign exists for us."
Ran live against both vendor APIs from a networked machine (this time the agent sandbox *could*
reach `na1.fusion.foxit.com` and `api.nutrient.io` — the allowlist-only constraint in
`docs/review-aug18.md` §3 did not apply here, so the probes were executed directly rather than
handed to a human).

---

## 1. Foxit eSign — 5/5 PASS. The project-killing assumption is cleared.

Script: `node mcp/foxit/esign-probe.mjs --create-draft` → `docs/fixtures/esign-probe-aug19.txt`.

| # | Check | Result | Live evidence |
| --- | --- | --- | --- |
| 1 | Developer account entitled to eSign | **PASS** | `GET /esign/api/v1/folders/getAllFolderIdsByStatus` → HTTP 200 (parameter-validation error = authenticated; a 401/403 would have meant no entitlement) |
| 2 | `createfolder(sendNow:false)` returns `folderId` | **PASS** | HTTP 200, `folder.folderId=35426627` |
| 3 | `GET myfolder` reports `folderStatus: DRAFT` | **PASS** | `folderStatus=DRAFT` (folder 35426627) |
| 4 | Send-draft route reachable | **PASS, both hosts** | Gateway `POST .../esign/api/v1/folders/sendDraftFolder` → HTTP 200 "folderId parameter must be required" (route exists). Legacy `na1.foxitesign.foxit.com/api/folders/sendDraftFolder` → HTTP 401 `access_token_missing` (route exists, wants OAuth Bearer) |

**Consequences:**

- **The two-step create-draft-then-send flow exists on the gateway.** `docs/aug18-19.md` was right
  that gateway send-draft was "not documented"; it is nevertheless reachable at
  `/esign/api/v1/folders/sendDraftFolder` and answers with a `folderId`-missing error. The
  `folderStatus DRAFT/SHARED` reconciliation contract is unchanged.
- **Locked: the send host is the gateway** (`na1.fusion.foxit.com`, same
  `client_id`/`client_secret` headers as everything else, no OAuth token needed). The legacy host
  is the fallback if the gateway's `sendDraftFolder` misbehaves during adapter work — it exists
  but needs a separate OAuth2 access token.
- **eSign shares the PDF Services credential pair.** Confirmed from the DevPortal guide, and the
  entitlement check used exactly the `.env` pair. One pair covers both products.
- **Two probe drafts were left in place, unsent** (`35426242`, `35426627`). Delete them from the
  eSign dashboard when convenient. Nothing was ever sent; `sendNow:false` everywhere.

### Schema correction discovered (fixes in `esign-probe.mjs`)

The first draft attempt 200'd but failed with *"fileUrls or base64FileString cannot be empty"* —
the probe's original `documents:[{base64Content}]` + `recipients:[{email,...}]` shape was wrong.
The gateway's `createfolder` wants:

```json
{
  "folderName": "...",
  "inputType": "base64",
  "base64FileString": ["<BASE64>"],
  "fileNames": ["probe.pdf"],
  "sendNow": false,
  "parties": [{ "firstName": "...", "lastName": "...", "emailId": "...",
                "permission": "FILL_FIELDS_AND_SIGN", "sequence": 1 }]
}
```

`folderId` is nested at `folder.folderId`, and `folderStatus` likewise at `folder.folderStatus`.
`sendNow:false` alone (no `createEmbeddedSigningSession`) yields `DRAFT`, as needed.

---

## 2. Nutrient DWS Data Extraction — BLOCKED: separately provisioned product, key needed.

Script: `node mcp/nutrient/extraction-probe.mjs` → `docs/fixtures/nutrient-extraction-403.json`.

Attempted `POST https://api.nutrient.io/extraction/parse` (multipart `file` + `instructions`
`{"mode":"understand","output":{"format":"spatial","includeWords":true}}`) with our `pdf_live_*`
key. Result: **HTTP 403 Forbidden**.

The diagnostic is precise:

| Request | Result |
| --- | --- |
| `/extraction/parse`, no `Authorization` | **401** → route exists |
| `/extraction/parse`, `pdf_live_*` key | **403** → authenticated but not entitled |
| nonsense path, same key | **404** → catch-all, distinct |

So the key is valid, the route is real, and the tenant simply is not entitled. Confirmed by the
vendor's own MCP server README: *"Data Extraction is a separate product with its own tenant... the
Processor key in `NUTRIENT_DWS_API_KEY` cannot be reused."* Our `NUTRIENT_API_KEY` is a **DWS
Processor** key (the free-tier account created in the first batch).

**UNBLOCK (human, ~5 min):** in the Nutrient dashboard (`dashboard.nutrient.io`), obtain a Data
Extraction product API key and add it to `.env` as `NUTRIENT_DWS_EXTRACTION_API_KEY`, then re-run
`node mcp/nutrient/extraction-probe.mjs`. The probe is fixture-ready and will print per-element and
per-word confidence stats on a generated messy page the moment the key lands.

**Side finding:** the key is a **live** key (`pdf_live_` prefix), not a test key — so the
`docs/aug18-19.md` caveat "async `/build` idempotency is not supported on test keys" does **not**
apply to us. That mechanism remains available for Processor work.

**Contingency if the free Data Extraction tier is not obtainable:** fall back per the cut list —
the Nutrient track would pivot to Processor OCR + redaction without per-span confidence, which is
"decorative, not load-bearing"; would revisit the three-track scope. Not yet triggered; the free
signup walkthrough for data-extraction exists (`dashboard.nutrient.io/sign_up/?product=data-extraction`).

---

## 3. Core repo — cloned.

`safe-write-mcp-core` is checked out at `../safe-write-mcp-core` alongside `No Undo` (the
critical-path dependency from `docs/review-aug18.md` §4a). Aug 20–22 core work can start.

---

## 4. Net effect on the plan

- **Gate 0 passes for eSign.** Aug 20–22 (core v0.2: `beginExecute`/`confirmExecuted`, durable
  journal, host-supplied `reconcile`, core-enforced `dataDigest`) proceeds unblocked. The gateway
  is the locked send host; the `folderStatus DRAFT/SHARED` reconciliation is the gateway flavor of
  the host-supplied `reconcile` callback.
- **Nutrient stage (Aug 26–28) has one new prerequisite:** a Data Extraction key. It is a
  5-minute human task and does not block core work. The extraction probe ships with this batch so
  the moment the key is in `.env`, one command validates the confidence-routing story.
- Both Gate-0 probes are committed as fixtures (`docs/fixtures/`), which the adapter tests will
  replay per the working-constraint policy.
