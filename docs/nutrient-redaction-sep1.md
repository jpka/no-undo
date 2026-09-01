# Nutrient redaction in the single pipeline — probe findings (Sep 1, 2026)

Live probes against `https://api.nutrient.io/build` (`stageRedactions` /
`applyRedactions`) and `https://api.nutrient.io/extraction/parse`, run against a
Foxit-assembled invoice (`pdf_from_html`, `via=foxit-mcp`).

Artifacts: `docs/fixtures/probe-original.pdf`, `probe-staged.pdf`,
`probe-applied.pdf`. Every value in them is synthetic — `.example` domains and
`555-01xx` numbers are reserved for documentation and cannot route to a person.

Targets: `email-address`, `north-american-phone-number`, and a VIN regex.
(`preset: "vin"` was the original third target and was dropped — see Finding 4.)

## Finding 1 — the staged document is not redacted, and looks like it is

`stageRedactions` draws redaction annotations over content that is still
present. The adapter's docstring says so; this is the measurement.

Text recovered via `/extraction/parse` from each artifact:

| Artifact | Bytes | Emails recoverable | Phones recoverable | Signature tags |
| --- | --- | --- | --- | --- |
| `probe-original.pdf` | 66,463 | 2 | 2 | present |
| `probe-staged.pdf` | 74,777 | **2** | **2** | garbled |
| `probe-applied.pdf` | 76,196 | 0 | 0 | present |

Both `m.webb@acmefreight-drivers.example` and
`ap@kaniefsky-transport.example`, and both `(201) 555-0142` and
`(718) 555-0197`, are extractable from the staged PDF with a single API call.
The document renders with black boxes over them.

This is why the pipeline never lets staged bytes reach the signer: an operator
who eyeballs the staged PDF, sees the boxes, and forwards it has published every
value they believed they had removed. Only `applyRedactions` destroys content.

## Finding 2 — redaction boxes destroy Foxit Text Tags they overlap

The first assembly rendered each signer's own email address inside the signature
block, directly above the hidden `${signfield:N:y:____}` tag, and listed signer
emails in a "Signers" table.

Applying `email-address` redaction to that document destroyed both signature
tags. `createEsignFolder` then refuses the draft, and had it not, the Foxit
gateway would refuse the send with "Please assign a signature field."

Two changes, both of which are correct independently of the redaction question:

- The signature block no longer prints the signer's email. Foxit already carries
  recipient addresses in `parties`; printing them in the body created a
  redaction target on top of a signature field.
- The "Signers" table dropped its Email column, for the same reason.

Redacting a signer's own address out of the document that signer is being asked
to sign was never meaningful. The PII that matters here belongs to third
parties who are not in the signing flow.

## Finding 3 — the invoice had no PII to redact

The shared fixture (`mcp/fixtures/invoice-data.mjs`) carried no email, phone,
government ID, or vehicle identifier. The prompt says "redact the PII" and there
was nothing in the document to act on; the only matches were the signers' own
addresses, per Finding 2.

The fixture now carries the third-party PII a freight invoice actually carries —
driver name, mobile, and email; the tractor VIN; the payer's accounts-payable
contact — under `INVOICE.shipment`. These are the redaction targets, they sit in
a "Shipment contacts" block well away from the signature section, and they are
absent from the document that goes for signature.

## Finding 4 — the `vin` preset silently redacts nothing

`vin` is in `CONFIRMED_PRESETS` because it returned HTTP 200 when probed on
Aug 20. It does return 200. It also does not redact.

Isolated, one target at a time, against `probe-original.pdf`, which contains
`1FUJGLDR8CLBP8834` (a well-formed 17-character VIN):

| Target | HTTP | Output | `1FUJGLDR8CLBP8834` after apply |
| --- | --- | --- | --- |
| `preset: "vin"` | 200 | valid PDF, 67,142 bytes | **still present** |
| `regex: "[A-HJ-NPR-Z0-9]{17}"` | 200 | valid PDF, 69,467 bytes | removed |

Both calls succeeded. Both returned a document that opens. One of them did
nothing, and nothing in the response says so — the only difference visible to a
caller is a byte count, which is not a signal anyone thresholds on.

This is the failure the adapter's own docstring predicted: *"a preset that
matches nothing stages zero regions and still returns a valid PDF, so the
document looks processed and is not redacted."* It is now measured rather than
anticipated. `CONFIRMED_PRESETS` records which identifiers the API *accepts*,
which is a different question from which identifiers *match* — the name has
been carrying more weight than the probe behind it.

The pipeline therefore does not trust the apply call. It re-reads the redacted
document and confirms each target value is gone before the document can reach
the gate. A redaction that silently no-ops fails the run instead of shipping.

**Correction to an earlier reading of this data.** The parse output of the
original document also contains digit runs like `207453-1288` and `424313-2107`
that look phone-shaped. These vary between runs of the same deterministic input
and are consistent with a PDF creation timestamp being re-serialised by the
parser, not with document content. They are not evidence that
`north-american-phone-number` over-matched, and are not claimed as such. The two
real phone numbers, `(201) 555-0142` and `(718) 555-0197`, are redacted
correctly.

## Finding 5 — the enriched-PDF tag guard cannot see tags

`esign-adapter.mjs` guards the enriched-bytes path by scanning
`buf.toString("latin1")` for `${signfield:N:y:...}`. That scan finds nothing in
any real PDF from `pdf_from_html`, including one that provably contains both
tags: the text lives in FlateDecode streams under subset-font encoding.
Inflating the streams does not recover it either.

The guard therefore rejects every valid enriched PDF, which is why the
`enriched-source` path had never been exercised end to end. It is replaced by a
verification that reads the document rather than guessing from bytes — see
`verifySignatureTags`.
