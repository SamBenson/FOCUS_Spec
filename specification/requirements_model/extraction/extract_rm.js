#!/usr/bin/env node
'use strict';

/**
 * Requirements Model extractor.
 *
 * Generates Requirements Model JSON from FOCUS specification markdown, driven by
 * `requirements_model_contract.json`. Markdown is parsed into an AST (via the
 * `marked` lexer) and the nested bullet list under each entity's `## Requirements`
 * heading is expanded into a rule family (a root composite, sub-composites, and a
 * rule per leaf bullet).
 *
 * Entity scope: DataModel (data_model.md), Datasets (<dataset>/dataset.md), and
 * Columns (<dataset>/columns/*.md). Each entity is written to its own file,
 * mirroring the releases/<v>/model_rules/ tree, under ./output/model_rules/.
 *
 * Rule IDs are <DatasetType>-<ArtifactName>-<ArtifactType>-<NumericId>-<Status>
 * for dataset-scoped entities (DatasetType prefix from the contract's DatasetTypes
 * map) and <ArtifactName>-<ArtifactType>-<NumericId>-<Status> otherwise (e.g. the
 * data model). IDs are STABLE: existing IDs are read from the previous release and
 * reused when a derived rule's MustSatisfy exactly matches an Active previous rule;
 * anything else (no match, or a match against only a non-Active previous rule) takes
 * the next free NumericId as a new rule; previous rules absent from the markdown are
 * tombstoned (Status "Removed"). Status (M/O/C) is derived from the keyword and
 * conditional phrasing.
 *
 * Leaf classification: composites become an AND over their children; "MUST include"
 * becomes a presence rule (ColumnPresent for datasets); leaves whose sentence matches
 * the per-release check-function lookup get a populated domain Requirement
 * (Type/Format/Nullability/...); "MUST conform to <Attr>" leaves link the attribute
 * via Dependencies; any remaining leaf is emitted with an empty Requirement and
 * recorded as a warning so the lookup can be extended. A populated Requirement is
 * Static, an empty one Dynamic. Conditions are resolved from `#conditions.<anchor>`
 * links to their Condition IDs.
 */

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const { renderInline, normalizeHeading, datasetJsonName, resolveDatasetFolders, renameConditions } = require('./markdown_util');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const RELEASES_DIR = path.join(__dirname, '..', 'releases');
const CONTRACT_PATH = path.join(__dirname, 'requirements_model_contract.json');
const OUTPUT_ROOT = path.join(__dirname, 'output', 'model_rules');

const PREVIOUS_VERSION = process.env.PREVIOUS_VERSION || '1.4';
const NEW_VERSION = process.env.NEW_VERSION || '1.5';

// Ordered so multi-word variants win over their prefixes (e.g. "MUST NOT" before "MUST").
const BCP14_KEYWORD = /\b(MUST NOT|MUST|SHALL NOT|SHALL|SHOULD NOT|SHOULD|MAY)\b/;
const INCLUDE_RE = /MUST include (\w+)/;
const CONFORM_RE = /MUST conform to (\w+) requirements/;
const CONDITIONAL_RE = /\bwhen\b/;

// Loaded once in main(): the per-release sentence -> check-function lookup, the
// condition anchor -> ConditionId map, and a dedup'd set of unmapped sentences.
let CHECK_LOOKUP = {};
let CONDITIONS = {};
const WARNINGS = [];
const EMITTED = []; // { outPath, rules } per file, written after the carry-forward post-pass

// ---------------------------------------------------------------------------
// Text / id helpers
// ---------------------------------------------------------------------------

/** Split a PascalCase id into a spaced Display Name (e.g. "BillingPeriodEnd" -> "Billing Period End"). */
function pascalToDisplay(id) {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

/** Map a BCP-14 keyword to a Rule-ID status letter (M=Mandatory, O=Optional, C=Conditional). */
function statusLetter(keyword, hasCondition) {
  if (hasCondition) return 'C';
  if (keyword === 'SHOULD' || keyword === 'SHOULD NOT' || keyword === 'MAY') return 'O';
  return 'M';
}

/** Build a Rule ID. `ctx.idPrefix` (DatasetType for datasets/columns, "ATT" for attributes) is optional. */
function buildRuleId(ctx, numericId, status) {
  const padded = String(numericId).padStart(3, '0');
  const prefix = ctx.idPrefix ? `${ctx.idPrefix}-` : '';
  return `${prefix}${ctx.artifactName}-${ctx.artifactType}-${padded}-${status}`;
}

/** Parse the NumericId out of a Rule ID (e.g. "BIP-BillingPeriod-D-004-M" -> 4). */
function numericIdOf(ruleId) {
  const m = ruleId.match(/-(\d+)-[A-Z]$/);
  return m ? parseInt(m[1], 10) : -1;
}

/**
 * Normalize MustSatisfy text for cross-version matching: strip inline-code backticks
 * (the extractor emits plain text, but older baselines stored the markdown backticks),
 * then trim and collapse whitespace. Applied to both sides of a comparison, so it only
 * affects ID reuse, never the stored MustSatisfy value.
 */
function normalizeMustSatisfy(text) {
  return text.replace(/`/g, '').trim().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Markdown parsing
// ---------------------------------------------------------------------------

/** Body tokens of the H2 section introduced by `headingText`. */
function getSectionTokens(tokens, headingText, depth = 2) {
  const start = tokens.findIndex(
    (t) => t.type === 'heading' && t.depth === depth && normalizeHeading(t.text) === headingText
  );
  if (start === -1) throw new Error(`Heading not found: "${headingText}" (depth ${depth})`);
  const body = [];
  for (let i = start + 1; i < tokens.length; i++) {
    if (tokens[i].type === 'heading' && tokens[i].depth <= depth) break;
    body.push(tokens[i]);
  }
  return body;
}

/** Whether an H2 section with the given heading text exists (used to skip overview files). */
function hasSection(tokens, headingText, depth = 2) {
  return tokens.some((t) => t.type === 'heading' && t.depth === depth && normalizeHeading(t.text) === headingText);
}

/** Plain text of the first paragraph token in a section (a simple-value or anchor line). */
function getSectionText(tokens, headingText, depth = 2) {
  const paragraph = getSectionTokens(tokens, headingText, depth).find((t) => t.type === 'paragraph');
  if (!paragraph) throw new Error(`No paragraph found in section "${headingText}"`);
  return renderInline(paragraph.tokens);
}

/** Collect condition anchors from inline tokens (links whose href is "#conditions.<anchor>"). */
function conditionAnchorsOf(tokens) {
  const out = [];
  for (const t of tokens || []) {
    if (t.type === 'link' && t.href) {
      const m = t.href.match(/^#conditions\.(.+)$/);
      if (m) out.push(m[1]);
    }
    if (t.tokens) out.push(...conditionAnchorsOf(t.tokens));
  }
  return out;
}

/** Parse a `list` token's items into a tree of { text, children, conditionAnchors }. */
function parseListItems(listToken) {
  return listToken.items.map((item) => {
    const textToken = item.tokens.find((t) => t.type === 'text');
    const subList = item.tokens.find((t) => t.type === 'list');
    return {
      text: textToken ? renderInline(textToken.tokens) : '',
      conditionAnchors: textToken ? conditionAnchorsOf(textToken.tokens) : [],
      children: subList ? parseListItems(subList) : [],
    };
  });
}

/** Build the requirement tree for an entity: a root composite over its top-level bullets. */
function parseRequirementTree(tokens, requirementsHeading) {
  const body = getSectionTokens(tokens, requirementsHeading);
  const anchor = body.find((t) => t.type === 'paragraph');
  const list = body.find((t) => t.type === 'list');
  if (!anchor || !list) throw new Error('Requirements section missing anchor paragraph or bullet list.');
  return { text: renderInline(anchor.tokens), conditionAnchors: conditionAnchorsOf(anchor.tokens), children: parseListItems(list) };
}

/** Flatten a requirement tree into a pre-order array of { node, text, childIdx[] } specs. */
function flattenTree(root) {
  const specs = [];
  (function visit(node) {
    const idx = specs.length;
    specs.push({ node, text: node.text, childIdx: [] });
    for (const child of node.children) specs[idx].childIdx.push(visit(child));
    return idx;
  })(root);
  return specs;
}

// ---------------------------------------------------------------------------
// Rule construction
// ---------------------------------------------------------------------------

/** Resolve a sentence against the check-function lookup; null when unmapped. */
function checkFunctionFor(text, artifactName) {
  const norm = text.split(artifactName).join('{entity}');
  const entry = CHECK_LOOKUP[norm];
  if (!entry) return null;
  const requirement = JSON.parse(JSON.stringify(entry.requirement).split('{entity}').join(artifactName));
  return { Function: entry.function, Requirement: requirement };
}

/**
 * Classify a requirement node into Function / Reference / Requirement / Dependencies.
 * Type is derived later from whether Requirement is populated. Leaf order matters:
 * composite -> include -> check-function lookup -> attribute conformance -> unclassified.
 */
function classify(node, childKeys, ctx) {
  if (node.children.length) {
    return {
      Function: 'Composite',
      Reference: ctx.artifactName,
      Requirement: {
        CheckFunction: 'AND',
        Items: childKeys.map((k) => ({ CheckFunction: 'CheckModelRule', ModelRuleId: k })),
      },
      Dependencies: childKeys.slice(),
    };
  }
  const include = node.text.match(INCLUDE_RE);
  if (include) {
    // Datasets check column presence; the data model includes datasets (generic for now).
    const requirement = ctx.entityType === 'Dataset' ? { CheckFunction: 'ColumnPresent', ColumnName: include[1] } : {};
    return { Function: 'Presence', Reference: include[1], Requirement: requirement, Dependencies: [] };
  }
  // Check-function lookup (covers type/format/nullability leaves, incl. format conformance).
  const looked = checkFunctionFor(node.text, ctx.artifactName);
  if (looked) {
    return { Function: looked.Function, Reference: ctx.artifactName, Requirement: looked.Requirement, Dependencies: [] };
  }
  // Attribute conformance: a dependency only when X is a real (generated) attribute.
  const conform = node.text.match(CONFORM_RE);
  if (conform && ctx.attrRoots && ctx.attrRoots[conform[1]]) {
    return { Function: 'Validation', Reference: ctx.artifactName, Requirement: {}, Dependencies: [ctx.attrRoots[conform[1]]] };
  }
  // Unclassified leaf: no check function found — empty Requirement, flagged for a warning.
  return { Function: 'Validation', Reference: ctx.artifactName, Requirement: {}, Dependencies: [], unclassified: true };
}

/** Construct a single model rule object from a requirement-tree node. */
function makeRule(node, numericId, childKeys, ctx, modelVersionIntroduced, status, prevRule) {
  const c = classify(node, childKeys, ctx);
  const keyword = node.text.match(BCP14_KEYWORD);

  // Carry forward a curated Requirement from the baseline when the current derivation
  // produced none (the current lookup wins whenever it does resolve one). Enum value
  // lists and functions like CheckNationalCurrency live only in the model and cannot be
  // re-derived from the sentence text, so regenerating from the lookup alone would drop
  // them. Reuse (matched MustSatisfy) is what makes the prior Requirement applicable here.
  // Carry the curated Requirement forward optimistically. A carried Requirement may
  // reference other rules (CheckModelRule / Dependencies) whose NumericId shifted between
  // versions, so the global post-pass in main() reverts any carry whose references do not
  // resolve. Everything that resolves is kept, recovering curation the lookup cannot derive.
  const prevReq = prevRule && prevRule.ValidationCriteria && prevRule.ValidationCriteria.Requirement;
  if (!Object.keys(c.Requirement).length && prevReq && Object.keys(prevReq).length) {
    c.unclassified = false;
    c.carried = true;
    c.Function = prevRule.Function;
    c.Reference = prevRule.Reference;
    c.Requirement = JSON.parse(JSON.stringify(prevReq));
    c.Dependencies = (prevRule.ValidationCriteria.Dependencies || []).slice();
    c.carriedCondition = prevRule.ValidationCriteria.Condition && Object.keys(prevRule.ValidationCriteria.Condition).length
      ? JSON.parse(JSON.stringify(prevRule.ValidationCriteria.Condition)) : null;
  }
  const entityName = c.Reference === ctx.artifactName ? ctx.displayName : pascalToDisplay(c.Reference);

  if (c.unclassified) {
    WARNINGS.push({ entity: `${ctx.entityType} ${ctx.artifactName}`, text: node.text });
  }

  // A populated Requirement (a check-function template) is Static; an empty one is Dynamic.
  const type = Object.keys(c.Requirement).length > 0 ? 'Static' : 'Dynamic';
  const conditions = (node.conditionAnchors || []).map((a) => CONDITIONS[a] || a);

  const rule = {
    Function: c.Function,
    Reference: c.Reference,
    EntityType: ctx.entityType,
    EntityName: entityName,
    EntityId: c.Reference,
    Notes: '',
    ModelVersionIntroduced: modelVersionIntroduced,
    Status: status || 'Active',
    Conditions: conditions,
    Type: type,
    Order: numericId * 10,
  };
  if (ctx.datasetType) {
    rule.DatasetType = ctx.datasetType;
    rule.DatasetId = ctx.datasetId;
    rule.DatasetName = ctx.datasetName;
  }
  rule.ValidationCriteria = {
    MustSatisfy: node.text,
    Keyword: keyword ? keyword[1] : '',
    Requirement: c.Requirement,
    Condition: c.carriedCondition || {},
    Dependencies: c.Dependencies,
  };
  // Transient marker (stripped before write) so the post-pass can validate carried refs
  // and re-warn if it must revert one.
  if (c.carried) rule.__carried = { entity: `${ctx.entityType} ${ctx.artifactName}`, text: node.text };
  return rule;
}

// ---------------------------------------------------------------------------
// Baselines + stable-ID expansion
// ---------------------------------------------------------------------------

/** Merge all rule JSON files directly inside a previous-release model_rules subdirectory. */
function loadBaselineDir(version, ...relParts) {
  const dir = path.join(RELEASES_DIR, version, 'model_rules', ...relParts);
  if (!fs.existsSync(dir)) return null;
  const rules = {};
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json')) Object.assign(rules, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  }
  return Object.keys(rules).length ? rules : null;
}

/** Load a single previous-release rule JSON file. */
function loadBaselineFile(version, ...relParts) {
  const file = path.join(RELEASES_DIR, version, 'model_rules', ...relParts);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Load the per-release check-function lookup (sentence -> { function, requirement }); {} if absent. */
function loadCheckLookup(version) {
  const file = path.join(RELEASES_DIR, version, 'check_function_lookup.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

/** Map a condition anchor (lowercased id) to its Condition ID by scanning the conditions dir. */
function loadConditions(locationAbs, idHeading) {
  const map = {};
  if (!fs.existsSync(locationAbs)) return map;
  for (const file of fs.readdirSync(locationAbs).filter((f) => f.endsWith('.md'))) {
    const tokens = marked.lexer(fs.readFileSync(path.join(locationAbs, file), 'utf8'));
    if (!hasSection(tokens, idHeading)) continue;
    const id = getSectionText(tokens, idHeading);
    map[id.toLowerCase()] = id;
  }
  return map;
}

/** Expand a requirement tree into { RuleId: rule }, reusing stable IDs and tombstoning removals. */
function expandTree(root, ctx, prevRules) {
  const specs = flattenTree(root);

  // Only Active previous rules are eligible for ID reuse: an exact MustSatisfy match
  // means the requirement is already in the model. A match against a non-Active rule
  // (Removed/Deprecated) does NOT count; that text gets a new NumericId. All previous
  // IDs still advance maxNumericId so tombstoned numbers are never reassigned.
  const prevByText = new Map();
  let maxNumericId = -1;
  if (prevRules) {
    for (const id of Object.keys(prevRules)) {
      maxNumericId = Math.max(maxNumericId, numericIdOf(id));
      if (prevRules[id].Status === 'Active') {
        prevByText.set(normalizeMustSatisfy(prevRules[id].ValidationCriteria.MustSatisfy), id);
      }
    }
  }

  const reusedIds = new Set();
  let nextNumericId = maxNumericId + 1;
  const idByIdx = specs.map((spec) => {
    const prevId = prevByText.get(normalizeMustSatisfy(spec.text));
    if (prevId) {
      reusedIds.add(prevId);
      return prevId;
    }
    const keyword = spec.text.match(BCP14_KEYWORD);
    const status = statusLetter(keyword && keyword[1], CONDITIONAL_RE.test(spec.text));
    return buildRuleId(ctx, nextNumericId++, status);
  });

  const output = {};
  specs.forEach((spec, idx) => {
    const id = idByIdx[idx];
    const childKeys = spec.childIdx.map((ci) => idByIdx[ci]);
    // A reused id always came from an Active previous rule (reuse is Active-only), so
    // the rule is emitted Active; only its introduced version carries over.
    const prev = prevRules && prevRules[id];
    const introduced = prev ? prev.ModelVersionIntroduced : NEW_VERSION;
    output[id] = makeRule(spec.node, numericIdOf(id), childKeys, ctx, introduced, 'Active', prev);
  });

  if (prevRules) {
    for (const id of Object.keys(prevRules)) {
      if (reusedIds.has(id)) continue;
      const carried = renameConditions(JSON.parse(JSON.stringify(prevRules[id])));
      if (!carried.ModelVersionRemoved) {
        carried.Status = 'Removed';
        carried.ModelVersionRemoved = NEW_VERSION;
        carried.Order = -1; // removed rules are never referenced as a requirement
      }
      output[id] = carried;
    }
  }

  const sorted = {};
  for (const id of Object.keys(output).sort((a, b) => numericIdOf(a) - numericIdOf(b))) sorted[id] = output[id];
  return sorted;
}

// ---------------------------------------------------------------------------
// Per-entity emit + main
// ---------------------------------------------------------------------------

function writeJson(outPath, obj) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(obj, null, 4) + '\n');
}

/**
 * Parse one markdown file and expand it against its baseline. Output is collected in
 * EMITTED (not written yet) so the global carry-forward post-pass can run with every
 * rule ID visible before anything is persisted.
 */
function emit(mdPath, ctx, headings, baseline, outPath) {
  const tokens = marked.lexer(fs.readFileSync(mdPath, 'utf8'));
  const tree = parseRequirementTree(tokens, headings.Requirements);
  const rules = expandTree(tree, ctx, baseline);
  EMITTED.push({ outPath, rules });
  return rules;
}

/** RuleIds a rule's Requirement/Dependencies point at (for cross-version ref validation). */
function referencedIds(rule) {
  const reqIds = [...JSON.stringify(rule.ValidationCriteria.Requirement || {}).matchAll(/"ModelRuleId":"([^"]+)"/g)].map((m) => m[1]);
  return reqIds.concat(rule.ValidationCriteria.Dependencies || []);
}

/**
 * Validate every carried-forward Requirement against the full set of generated rule IDs.
 * A carry whose references don't all resolve (e.g. a baseline dependency whose NumericId
 * shifted) is reverted to an empty, Dynamic rule and re-flagged as unmapped. Then strip
 * the transient marker and persist every file.
 */
function finalizeEmitted() {
  const liveIds = new Set();
  for (const { rules } of EMITTED) {
    for (const id of Object.keys(rules)) if (rules[id].Status !== 'Removed') liveIds.add(id);
  }
  for (const { rules } of EMITTED) {
    for (const id of Object.keys(rules)) {
      const r = rules[id];
      const carried = r.__carried;
      delete r.__carried;
      if (!carried || r.Status === 'Removed') continue;
      if (referencedIds(r).every((x) => liveIds.has(x))) continue;
      r.Function = 'Validation';
      r.Type = 'Dynamic';
      r.ValidationCriteria.Requirement = {};
      r.ValidationCriteria.Condition = {};
      r.ValidationCriteria.Dependencies = [];
      WARNINGS.push(carried);
    }
  }
  for (const { outPath, rules } of EMITTED) writeJson(outPath, rules);
}

function main() {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  const summary = [];

  CHECK_LOOKUP = loadCheckLookup(NEW_VERSION);
  CONDITIONS = loadConditions(path.join(REPO_ROOT, contract.Conditions.Location), contract.Conditions.Headings.Id);

  // --- DataModel ---
  {
    const dm = contract.DataModel;
    const mdPath = path.join(REPO_ROOT, dm.Location);
    const tokens = marked.lexer(fs.readFileSync(mdPath, 'utf8'));
    const ctx = {
      entityType: dm.EntityType,
      artifactType: dm.ArtifactType,
      idPrefix: dm.IdPrefix,
      artifactName: getSectionText(tokens, dm.Headings.Id),
      displayName: getSectionText(tokens, dm.Headings.DisplayName),
    };
    const rules = emit(mdPath, ctx, dm.Headings, loadBaselineDir(PREVIOUS_VERSION, 'datamodel'), path.join(OUTPUT_ROOT, 'datamodel.json'));
    summary.push([`DataModel (${ctx.artifactName})`, Object.keys(rules).length]);
  }

  // --- Attributes (first: dataset/column "conform to X" rules depend on their root IDs) ---
  const attrRoots = {}; // attribute EntityId -> its root rule ID (e.g. NullHandling -> ATT-NullHandling-A-000-C)
  const att = contract.Attributes;
  const attrDir = path.join(REPO_ROOT, att.Location);
  for (const file of fs.readdirSync(attrDir).filter((f) => f.endsWith('.md'))) {
    const attrMdPath = path.join(attrDir, file);
    const attrTokens = marked.lexer(fs.readFileSync(attrMdPath, 'utf8'));
    // Skip non-entity files (e.g. attributes_overview.md) that lack the entity sections.
    if (!hasSection(attrTokens, att.Headings.Id) || !hasSection(attrTokens, att.Headings.Requirements)) continue;
    const attrId = getSectionText(attrTokens, att.Headings.Id);
    const attrCtx = { entityType: att.EntityType, artifactType: att.ArtifactType, idPrefix: att.IdPrefix, artifactName: attrId, displayName: getSectionText(attrTokens, att.Headings.DisplayName) };
    const outName = datasetJsonName(path.basename(file, '.md'));
    const attrOut = path.join(OUTPUT_ROOT, 'attributes', outName);
    const attrRules = emit(attrMdPath, attrCtx, att.Headings, loadBaselineFile(PREVIOUS_VERSION, 'attributes', outName), attrOut);
    attrRoots[attrId] = Object.keys(attrRules).find((k) => numericIdOf(k) === 0);
    summary.push([`Attribute ${attrId}`, Object.keys(attrRules).length]);
  }

  // --- Datasets + their Columns ---
  const datasetFolders = resolveDatasetFolders(path.join(REPO_ROOT, contract.Datasets.Location));
  for (const folder of datasetFolders) {
    const ds = contract.Datasets;
    const dsMdPath = path.join(REPO_ROOT, ds.Location, folder, 'dataset.md');
    const dsTokens = marked.lexer(fs.readFileSync(dsMdPath, 'utf8'));
    const datasetId = getSectionText(dsTokens, ds.Headings.Id);
    const datasetName = getSectionText(dsTokens, ds.Headings.DisplayName);
    const datasetType = contract.DatasetTypes[datasetId];
    const dsCtx = { entityType: ds.EntityType, artifactType: ds.ArtifactType, idPrefix: datasetType, artifactName: datasetId, displayName: datasetName, datasetType, datasetId, datasetName, attrRoots };
    const dsOut = path.join(OUTPUT_ROOT, 'datasets', folder, datasetJsonName(folder));
    const dsRules = emit(dsMdPath, dsCtx, ds.Headings, loadBaselineDir(PREVIOUS_VERSION, 'datasets', folder), dsOut);
    summary.push([`Dataset ${datasetId}`, Object.keys(dsRules).length]);

    const cc = contract.Columns;
    const colDir = path.join(REPO_ROOT, ds.Location, folder, 'columns');
    for (const file of fs.readdirSync(colDir).filter((f) => f.endsWith('.md'))) {
      const colMdPath = path.join(colDir, file);
      const colTokens = marked.lexer(fs.readFileSync(colMdPath, 'utf8'));
      const colId = getSectionText(colTokens, cc.Headings.Id);
      const colCtx = { entityType: cc.EntityType, artifactType: cc.ArtifactType, idPrefix: datasetType, artifactName: colId, displayName: getSectionText(colTokens, cc.Headings.DisplayName), datasetType, datasetId, datasetName, attrRoots };
      const base = path.basename(file, '.md');
      const colOut = path.join(OUTPUT_ROOT, 'datasets', folder, 'columns', `${base}.json`);
      const colRules = emit(colMdPath, colCtx, cc.Headings, loadBaselineFile(PREVIOUS_VERSION, 'datasets', folder, 'columns', `${base}.json`), colOut);
      summary.push([`  Column ${colId}`, Object.keys(colRules).length]);
    }
  }

  finalizeEmitted();

  console.log(`Wrote model rules under ${OUTPUT_ROOT} (diff ${PREVIOUS_VERSION} -> ${NEW_VERSION}):`);
  for (const [name, count] of summary) console.log(`  ${name}: ${count} rules`);

  if (WARNINGS.length) {
    console.warn(`\n⚠ ${WARNINGS.length} requirement sentence(s) have no check-function mapping`);
    console.warn('  (Requirement left empty, Type set to Dynamic). Add entries to the lookup to resolve:');
    for (const w of WARNINGS) console.warn(`    [${w.entity}] ${w.text}`);
  }
}

main();
