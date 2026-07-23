# Extraction Output

This directory holds the Requirements Model JSON produced by `../extract_rm.js`.
It is generated output: do not edit these files by hand. Regenerate with
`npm run extract` from the parent directory and audit with `npm run verify`.

## Layout

The tree mirrors the hand-authored `releases/<version>/model_rules/` layout, one
file per entity:

```
model_rules/
  datamodel.json                                  DataModel entity
  attributes/
    <attribute>.json                              one file per attribute
  datasets/
    <dataset_folder>/
      <dataset>.json                              the dataset entity
      columns/
        <column>.json                             one file per column
```

Attribute and dataset file names drop underscores from the source folder name
(e.g. `billing_period` -> `billingperiod.json`); column files keep the source
markdown base name.

## File contents

Each file is a JSON object keyed by Rule ID. A Rule ID is:

* `<DatasetType>-<ArtifactName>-<ArtifactType>-<NumericId>-<Status>` for
  dataset-scoped entities (e.g. `BIP-BillingPeriod-D-004-M`), or
* `<ArtifactName>-<ArtifactType>-<NumericId>-<Status>` otherwise.

Where the trailing status letter is `M` (Mandatory), `O` (Optional), or `C`
(Conditional), and the artifact type is `D` (Dataset), `C` (Column), `A`
(Attribute), or `M` (data Model).

## Rule shape

```jsonc
{
  "BIP-BillingPeriod-D-004-M": {
    "Function": "Composite",          // Composite | Presence | Type | Nullability | Format | Validation
    "Reference": "BillingPeriod",     // entity (or referenced entity) the rule is about
    "EntityType": "Dataset",
    "EntityName": "Billing Period",   // display name
    "EntityId": "BillingPeriod",
    "Notes": "",
    "ModelVersionIntroduced": "1.3",  // preserved across releases via stable IDs
    "Status": "Active",               // Active | Removed | Deprecated
    "Conditions": [],                 // resolved Condition IDs, from #conditions.<anchor> links
    "Type": "Static",                 // Static when Requirement is populated, else Dynamic
    "Order": 40,                      // NumericId * 10; -1 for removed rules
    "DatasetType": "BIP",             // dataset-scoped rules only
    "DatasetId": "BillingPeriod",
    "DatasetName": "Billing Period",
    "ValidationCriteria": {
      "MustSatisfy": "...",           // the exact normative sentence from the spec
      "Keyword": "MUST",              // BCP-14 keyword extracted from MustSatisfy
      "Requirement": { },             // the machine-checkable check function, or {} if unmapped
      "Condition": {},
      "Dependencies": []              // other Rule IDs this rule depends on
    }
  }
}
```

### Composite rules

A rule with child bullets in the spec is a `Composite`: its `Requirement` is an
`AND` over `CheckModelRule` items, one per child, and those same child IDs are
listed in `Dependencies`. The root rule of each entity (NumericId `000`) is the
composite that gathers all top-level requirements.

### Removed rules

A baseline rule whose requirement text no longer appears in the current markdown
is retained as a tombstone with `Status: "Removed"`, `ModelVersionRemoved` set to
the target version, and `Order: -1`. Tombstones keep Rule IDs stable so that
downstream references remain valid.
