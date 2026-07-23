# Requirements Model Extraction

This directory contains a Node.js tool that generates Requirements Model JSON
directly from the FOCUS specification markdown. It replaces manual authoring of
`model_rules/` files: the normative bullet list under each entity's
`## Requirements` heading is parsed and expanded into a family of machine-readable
rules, with stable Rule IDs carried forward across releases.

## Contents

| File | Role |
|---|---|
| `extract_rm.js` | The extractor. Reads spec markdown, writes `output/model_rules/`. |
| `verify.js` | Correctness audit of the generated output (structural + deep transformation). |
| `validate_markdown.js` | Pre-flight check that spec markdown is shaped as the extractor expects. |
| `markdown_util.js` | Shared helpers (inline rendering, entity decoding, path naming) used by all three. |
| `requirements_model_contract.json` | Declares where each entity type lives in the spec and which headings to read. |
| `*.test.js` | Node built-in test-runner tests for the utilities and verifier. |
| `output/` | Generated rule files (see `output/README.md`). |

The per-release sentence-to-check-function lookup lives outside this directory,
at `../releases/<version>/check_function_lookup.json`, alongside the baseline
rule files it is versioned with.

## Quick start

```bash
cd specification/requirements_model/extraction
npm install            # installs marked
npm run validate       # confirm the markdown is well-formed (optional but recommended)
npm run extract        # generate output/model_rules/
npm run verify         # audit the generated output
npm test               # run the unit tests
```

By default the extractor diffs the `1.4` baseline into a `1.5` output. Override
with environment variables:

```bash
PREVIOUS_VERSION=1.4 NEW_VERSION=1.5 npm run extract
DATASET_FOLDERS=billing_period npm run extract   # limit to specific dataset folders
```

## What the extraction does, step by step

The extractor (`extract_rm.js`, `main()`) runs the following pipeline. Every step
is driven by `requirements_model_contract.json` so that file locations and
heading names are never hard-coded.

### 1. Load the contract and per-release inputs

* Read `requirements_model_contract.json` — this declares, for each entity type
  (DataModel, Dataset, Column, Attribute, Condition), the spec location, the
  entity type name, the Rule-ID artifact type letter, an optional ID prefix, and
  the heading names that hold the entity ID, display name, and requirements.
* Load the check-function lookup for the target version from
  `../releases/<NEW_VERSION>/check_function_lookup.json`. This maps a normalized
  requirement sentence (with the entity name replaced by `{entity}`) to a
  `{ function, requirement }` pair. Absent file is tolerated as an empty lookup.
* Scan `specification/conditions/` to build an anchor-to-ConditionId map, so
  that `#conditions.<anchor>` links in the markdown resolve to real Condition IDs.

### 2. Walk the entities

Entities are processed in an order that respects dependencies:

1. **DataModel** — `specification/datasets/data_model.md` (single entity).
2. **Attributes** — every `*.md` in `specification/attributes/` that has both an
   ID heading and a Requirements heading (overview files without those are
   skipped). Attributes are processed *before* datasets and columns because a
   column's "MUST conform to <Attribute>" rule needs the attribute's root Rule ID
   to record as a dependency.
3. **Datasets and their Columns** — every dataset folder under
   `specification/datasets/` that contains a `dataset.md`, then each `*.md` under
   that folder's `columns/`.

### 3. Parse each markdown file into a requirement tree

For one entity file (`emit` -> `parseRequirementTree`):

* The `marked` lexer produces an AST.
* The body of the `## Requirements` section is located. Its lead-in paragraph
  (the anchor sentence, e.g. `BillingPeriod MUST adhere to the following
  requirements:`) becomes the tree root, and the nested bullet list becomes the
  tree's children.
* Each bullet's inline tokens are rendered to plain text via
  `markdown_util.renderInline`, which keeps link and emphasis display text and
  decodes HTML entities so the stored text matches the source exactly. Nested
  bullets become child nodes. `#conditions.<anchor>` links on a bullet are
  recorded as that rule's condition anchors.

### 4. Classify each node into a rule

`flattenTree` turns the tree into a pre-order list, then each node is classified
(`classify`) in this precedence order:

1. **Composite** — a node with children becomes an `AND` over its child rules
   (`CheckModelRule` items), and lists those children as `Dependencies`.
2. **Presence** — a leaf matching `MUST include <X>`. For datasets this emits a
   `ColumnPresent` requirement; the data model records the reference generically.
3. **Check-function lookup** — a leaf whose normalized sentence is a key in the
   lookup gets a populated domain `Requirement` (Type, Nullability, Format, etc.),
   with `{entity}` substituted back to the real entity name.
4. **Attribute conformance** — a leaf matching `MUST conform to <Attribute>
   requirements`, where `<Attribute>` is a real generated attribute, records a
   dependency on that attribute's root rule (no inline requirement).
5. **Unclassified** — any remaining leaf is emitted with an empty `Requirement`
   and recorded as a warning so the lookup can be extended.

A rule with a populated `Requirement` is typed `Static`; an empty one is `Dynamic`.
The BCP-14 keyword (`MUST`, `SHOULD NOT`, `MAY`, ...) is extracted from the
sentence, and the status letter (M / O / C) is derived from the keyword and
whether the sentence is conditional (contains `when`).

### 5. Assign stable Rule IDs

Rule IDs are stable across releases (`expandTree`). Format:

* `<DatasetType>-<ArtifactName>-<ArtifactType>-<NumericId>-<Status>` for
  dataset-scoped entities (e.g. `BIP-BillingPeriod-D-004-M`), where the
  `DatasetType` prefix comes from the contract's `DatasetTypes` map.
* `<ArtifactName>-<ArtifactType>-<NumericId>-<Status>` otherwise.

ID assignment:

* The previous release's rule file(s) are loaded as a baseline. If a derived
  rule's requirement text (normalized) matches a baseline rule, that rule's
  existing ID is reused, preserving its `ModelVersionIntroduced`.
* A new requirement takes the next free NumericId above the baseline maximum.
* A baseline rule with no matching requirement in the current markdown is
  **tombstoned**: carried into the output with `Status: "Removed"`,
  `ModelVersionRemoved: <NEW_VERSION>`, and `Order: -1`. A rule already removed
  in the baseline is carried through unchanged.

Output for each entity is sorted by NumericId and written to its own JSON file
under `output/model_rules/`, mirroring the `releases/<v>/model_rules/` layout.

### 6. Report

The extractor prints a per-entity rule count. Any requirement sentence with no
check-function mapping is summarized at the end (grouped by normalized phrasing
with an occurrence count) so those sentences can be added to the lookup.

## Verification

`verify.js` audits the generated output in two layers and exits non-zero on any
failure:

* **Structural integrity** over every output file — no duplicate Rule IDs or
  NumericIds, files sorted by NumericId, active-rule dependencies resolve
  (within the file or to external `ATT-*` rules), composite `Items` match
  `Dependencies`, `Keyword` matches the sentence, dataset/column rules carry a
  `DatasetType` and an ID prefixed with it, and no raw HTML entities leaked into
  any `MustSatisfy`.
* **Deep transformation audit** of the `billing_period` dataset file — expected
  rules are independently re-derived from the two inputs (the previous-release
  baseline JSON and the current markdown) and compared against the output,
  checking coverage, ID reuse, `ModelVersionIntroduced`, and tombstoning.

`validate_markdown.js` is a lighter pre-flight check that the spec markdown is
shaped the way the extractor requires (present Requirements section, anchor
paragraph, well-formed bullet list) before extraction is attempted.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `PREVIOUS_VERSION` | `1.4` | Baseline release to diff against for stable IDs. |
| `NEW_VERSION` | `1.5` | Target release; also selects the check-function lookup. |
| `DATASET_FOLDERS` | (all) | Comma-separated dataset folders to limit extraction to. |
| `DATASET_FOLDER` | `billing_period` | Dataset file targeted by the `verify.js` deep audit. |
