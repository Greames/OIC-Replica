import { parseExpression } from "@oicr/flow-schema";
import { z } from "zod";
import type { Entity } from "./catalog.js";
import type { SemanticGraph } from "./graph.js";

// Binding discovery: a schema sample (records, or a column list) is reduced to
// its fields, a model proposes which catalog attribute each field holds, and
// the proposal is checked before anyone sees it.

export interface SampleField {
  field: string;
  /** Observed JSON type, or the declared column type. */
  type: string;
  /** A few distinct values, shortened; empty when values are withheld. */
  examples: string[];
  description?: string;
}

export interface Sample {
  fields: SampleField[];
  records: number;
}

export const MAX_SAMPLE_FIELDS = 200;
const MAX_EXAMPLES = 3;
const MAX_EXAMPLE_LENGTH = 40;

export class SampleError extends Error {}

/**
 * Reads a pasted sample: JSON (a record, a list of records, or a response
 * with the list inside, e.g. { "items": [...] } or OData { "d": { "results": [...] } }),
 * CSV with a header row, or one column per line ("ACCOUNT_NUMBER VARCHAR2(30) Account number").
 */
export function describeSample(text: string, opts: { includeValues?: boolean } = {}): Sample {
  const src = text.trim();
  if (!src) throw new SampleError("Paste a sample: JSON records, CSV with a header row, or one column per line.");
  const includeValues = opts.includeValues ?? true;
  if (src.startsWith("{") || src.startsWith("[")) {
    let json: unknown;
    try {
      json = JSON.parse(src);
    } catch (e) {
      throw new SampleError(`The sample is not valid JSON: ${(e as Error).message}`);
    }
    return fromRecords(recordsIn(json), includeValues);
  }
  const lines = src.split(/\r?\n/).filter((l) => l.trim());
  if (lines[0]!.includes(",") && lines.length > 1) return fromCsv(lines, includeValues);
  if (lines[0]!.includes(",")) return fromColumns(lines[0]!.split(",").map((c) => c.trim()));
  return fromColumns(lines);
}

function recordsIn(json: unknown): Record<string, unknown>[] {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (Array.isArray(json)) {
    const recs = json.filter(isObj);
    if (recs.length === 0) throw new SampleError("The JSON list has no records (objects) in it.");
    return recs;
  }
  if (!isObj(json)) throw new SampleError("The JSON sample must be a record or a list of records.");
  // OData V2 { d: { results: [...] } }, V4 { value: [...] }, Fusion/NetSuite { items: [...] }
  const d = json.d;
  if (isObj(d) && Array.isArray(d.results)) return recordsIn(d.results);
  for (const key of ["items", "value", "results", "data", "records", "rows"]) {
    const v = json[key];
    if (Array.isArray(v) && v.some(isObj)) return recordsIn(v);
  }
  return [json];
}

function fromRecords(records: Record<string, unknown>[], includeValues: boolean): Sample {
  const fields = new Map<string, { types: Set<string>; examples: Set<string> }>();
  const visit = (value: unknown, path: string, depth: number) => {
    if (value && typeof value === "object" && !Array.isArray(value) && depth < 3) {
      for (const [k, v] of Object.entries(value)) {
        // OData metadata and links are not data.
        if (k === "__metadata" || k === "__deferred" || k === "links" || k.startsWith("@")) continue;
        visit(v, path ? `${path}.${k}` : k, depth + 1);
      }
      return;
    }
    if (!path) return;
    let f = fields.get(path);
    if (!f) {
      if (fields.size >= MAX_SAMPLE_FIELDS) return;
      f = { types: new Set(), examples: new Set() };
      fields.set(path, f);
    }
    if (Array.isArray(value)) {
      f.types.add(value.some((x) => x && typeof x === "object") ? "list of records" : "list");
      return;
    }
    if (value === null || value === undefined) return;
    f.types.add(typeof value);
    const s = String(value);
    if (includeValues && s !== "" && f.examples.size < MAX_EXAMPLES)
      f.examples.add(s.length > MAX_EXAMPLE_LENGTH ? `${s.slice(0, MAX_EXAMPLE_LENGTH)}…` : s);
  };
  for (const r of records.slice(0, 50)) visit(r, "", 0);
  return {
    records: records.length,
    fields: [...fields].map(([field, f]) => ({
      field,
      type: f.types.size === 0 ? "null" : [...f.types].join(" | "),
      examples: [...f.examples],
    })),
  };
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function fromCsv(lines: string[], includeValues: boolean): Sample {
  const header = splitCsv(lines[0]!);
  const records = lines.slice(1).map((l) => {
    const cells = splitCsv(l);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
  const sample = fromRecords(records, includeValues);
  // CSV cells are all text; say so rather than guess.
  return { ...sample, fields: sample.fields.map((f) => ({ ...f, type: "text" })) };
}

function fromColumns(lines: string[]): Sample {
  const fields: SampleField[] = [];
  for (const line of lines.slice(0, MAX_SAMPLE_FIELDS)) {
    // NAME [TYPE] [description]; a type is an upper-case SQL type or a JSON type name.
    const m =
      /^\s*([A-Za-z_$@][\w$@.-]*)\s*(?:([A-Z][A-Z0-9_]*(?:\([^)]*\))?|string|number|integer|boolean|date|datetime|text)(?=\s|$))?\s*(?:[-–:]\s*)?(.*)$/.exec(
        line,
      );
    if (!m) continue;
    fields.push({
      field: m[1]!,
      type: m[2]?.trim() || "unknown",
      examples: [],
      ...(m[3]?.trim() ? { description: m[3].trim() } : {}),
    });
  }
  if (fields.length === 0) throw new SampleError("No column names found in the sample.");
  return { fields, records: 0 };
}

// ── proposals ─────────────────────────────────────────────────────────────

export const ProposedBinding = z.object({
  field: z.string().min(1),
  attribute: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidence: z.string().max(600),
  read: z.string().max(500).optional(),
  write: z.string().max(500).optional(),
});

export const BindingProposal = z.object({
  entity: z.string().min(1),
  entityConfidence: z.number().min(0).max(1),
  reasoning: z.string().max(1500).default(""),
  bindings: z.array(ProposedBinding).max(MAX_SAMPLE_FIELDS),
  unmapped: z
    .array(z.object({ field: z.string(), reason: z.string().max(300) }))
    .max(MAX_SAMPLE_FIELDS)
    .default([]),
});
export type BindingProposal = z.infer<typeof BindingProposal>;

/** JSON Schema of BindingProposal, for the model's submit tool. */
export const BINDING_PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    entity: { type: "string", description: "The catalog entity the object holds, e.g. Customer." },
    entityConfidence: { type: "number", minimum: 0, maximum: 1 },
    reasoning: { type: "string", description: "One or two sentences on why this entity." },
    bindings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string", description: "The technical field, exactly as in the sample." },
          attribute: { type: "string", description: "An attribute of the chosen entity." },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "string", description: "What in the name, type, description or values supports it." },
          read: { type: "string", description: "Optional JSONata from $value (technical) to the catalog value." },
          write: { type: "string", description: "Optional JSONata from $value (catalog) back to the technical value." },
        },
        required: ["field", "attribute", "confidence", "evidence"],
      },
    },
    unmapped: {
      type: "array",
      items: {
        type: "object",
        properties: { field: { type: "string" }, reason: { type: "string" } },
        required: ["field", "reason"],
      },
    },
  },
  required: ["entity", "entityConfidence", "bindings", "unmapped"],
} as const;

export interface CheckedProposal {
  entity: string;
  entityConfidence: number;
  reasoning: string;
  bindings: z.infer<typeof ProposedBinding>[];
  unmapped: { field: string; reason: string }[];
  /** Bindings that failed the checks, with why; shown so nothing disappears silently. */
  dropped: { field: string; attribute: string; reason: string }[];
}

/** Checks a model's proposal against the catalog and the sample. */
export function checkProposal(
  graph: SemanticGraph,
  sample: Sample,
  raw: unknown,
): { ok: true; proposal: CheckedProposal } | { ok: false; error: string } {
  const parsed = BindingProposal.safeParse(raw);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const p = parsed.data;
  const entity = graph.entity(p.entity);
  if (!entity)
    return {
      ok: false,
      error: `Entity "${p.entity}" is not in the catalog. Use one of: ${graph
        .entities()
        .map((e) => e.name)
        .join(", ")}.`,
    };
  const fields = new Set(sample.fields.map((f) => f.field));
  const dropped: CheckedProposal["dropped"] = [];
  const best = new Map<string, z.infer<typeof ProposedBinding>>();
  const seenFields = new Set<string>();
  for (const b of p.bindings) {
    const drop = (reason: string) => dropped.push({ field: b.field, attribute: b.attribute, reason });
    if (!fields.has(b.field)) {
      drop("The field is not in the sample.");
      continue;
    }
    if (seenFields.has(b.field)) {
      drop("The field was proposed twice; the first proposal is kept.");
      continue;
    }
    if (!entity.attributes.some((a) => a.name === b.attribute)) {
      drop(`${entity.name} has no attribute "${b.attribute}".`);
      continue;
    }
    const bad = [b.read, b.write].find((t) => t !== undefined && t.trim() !== "" && !parseExpression(t).ok);
    if (bad !== undefined) {
      drop(`The transform is not valid JSONata: ${bad}`);
      continue;
    }
    seenFields.add(b.field);
    const clean = {
      ...b,
      read: b.read?.trim() || undefined,
      write: b.write?.trim() || undefined,
    };
    const other = best.get(b.attribute);
    if (other) {
      // One field per attribute: keep the more confident one.
      const [keep, lose] = other.confidence >= clean.confidence ? [other, clean] : [clean, other];
      dropped.push({ field: lose.field, attribute: lose.attribute, reason: `${keep.field} is a better match.` });
      best.set(b.attribute, keep);
    } else best.set(b.attribute, clean);
  }
  const bound = new Set([...best.values()].map((b) => b.field));
  const unmapped = [
    ...p.unmapped.filter((u) => fields.has(u.field) && !bound.has(u.field)),
    ...sample.fields
      .filter((f) => !bound.has(f.field) && !p.unmapped.some((u) => u.field === f.field))
      .map((f) => ({ field: f.field, reason: "No matching attribute was proposed." })),
  ];
  return {
    ok: true,
    proposal: {
      entity: entity.name,
      entityConfidence: p.entityConfidence,
      reasoning: p.reasoning,
      bindings: [...best.values()],
      unmapped,
      dropped,
    },
  };
}

const describeEntity = (e: Entity) =>
  [
    `### ${e.name} — ${e.description}`,
    ...e.attributes.map(
      (a) =>
        `- ${a.name} (${a.type}${a.identifier ? ", identifier" : ""}${a.references ? `, holds ${a.references}.number` : ""}): ${a.description}${a.synonyms?.length ? ` Also called: ${a.synonyms.join(", ")}.` : ""}`,
    ),
  ].join("\n");

/** The instructions and the request for a binding proposal. */
export function bindingPrompt(
  graph: SemanticGraph,
  req: { system: string; object: string; sample: Sample; entityHint?: string },
): { system: string; user: string } {
  const sys = graph.system(req.system);
  const examples = graph
    .objects({ system: req.system })
    .filter((o) => o.object !== req.object && o.fields.length > 0)
    .slice(0, 3);
  const existing = graph.object(req.system, req.object);
  const system = [
    "You map the fields of enterprise systems (Oracle Fusion and EBS, NetSuite, SAP S/4HANA and others) to a Semantic Catalog of business entities.",
    "Decide which single catalog entity the object holds, then, for each sample field, which attribute of that entity it holds. Only bind a field when it truly holds that attribute's meaning; leave internal ids, foreign keys to other tables, audit columns that have no attribute, and unclear fields unmapped, with a short reason.",
    "Confidence is your probability that the binding is right: 0.95+ only when the name and the values agree unambiguously; 0.6–0.85 when it is a reasonable reading; below 0.5 when you are guessing. People review anything below 0.9.",
    'Values are normalised automatically: numeric text to numbers, Y/N and X flags to booleans, dates (including /Date(ms)/) to ISO dates. Only write `read`/`write` transforms (JSONata over $value) when the meaning differs, e.g. a status code A/I for `active` (read: $value = "A", write: $value ? "A" : "I") or an inverted flag like isInactive (read and write: $not($value)).',
    "Answer only by calling submit_bindings once.",
    "",
    "## Catalog",
    ...graph.entities().map(describeEntity),
  ].join("\n");
  const user = [
    `System: ${sys ? `${sys.label} (${sys.id}); objects are ${sys.objectKind}s` : req.system}`,
    `Object: ${req.object}`,
    req.entityHint ? `The user thinks it holds: ${req.entityHint}` : "",
    existing?.fields.length
      ? `Already bound (keep unless clearly wrong): ${existing.fields.map((f) => `${f.field} → ${f.attribute}`).join(", ")}`
      : "",
    examples.length
      ? `Bindings of other ${req.system} objects, for its naming conventions:\n${examples
          .map((o) => `- ${o.object} → ${o.entity}: ${o.fields.map((f) => `${f.field}→${f.attribute}`).join(", ")}`)
          .join("\n")}`
      : "",
    `Fields (${req.sample.fields.length}${req.sample.records ? `, from ${req.sample.records} sample record(s)` : ""}):`,
    ...req.sample.fields.map(
      (f) =>
        `- ${f.field}: ${f.type}${f.description ? ` — ${f.description}` : ""}${f.examples.length ? ` e.g. ${f.examples.map((x) => JSON.stringify(x)).join(", ")}` : ""}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
  return { system, user };
}
