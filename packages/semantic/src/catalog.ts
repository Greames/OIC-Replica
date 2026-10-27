// Types and validators only (no Node APIs): safe to import from browser code as @oicr/semantic/types.
import { z } from "zod";

// The Semantic Catalog: business entities (Customer, Invoice, ...) and their
// attributes, independent of any system. Systems are bound to it field by
// field; integrations read and write through it.

export const ATTRIBUTE_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "date",
  "datetime",
  "currency",
  "email",
] as const;
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

export const EntityName = z
  .string()
  .regex(/^[A-Z][A-Za-z0-9]{1,59}$/, "Use PascalCase letters and digits, e.g. ShipmentNotice.");
export const AttributeName = z
  .string()
  .regex(/^[a-z][A-Za-z0-9]{0,59}$/, "Use camelCase letters and digits, e.g. trackingNumber.");
export const SystemId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,39}$/, "Use lowercase letters, digits and -, e.g. oracle-ebs.");
export const ObjectName = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9_.$-]{0,127}$/,
    "Use the system's name for the table, resource or record, e.g. HZ_CUST_ACCOUNTS or salesOrder.",
  );
/** A technical field, or a dotted path into nested data (entity.id). */
export const FieldPath = z
  .string()
  .regex(
    /^[A-Za-z_$@][A-Za-z0-9_$@-]*(\.[A-Za-z_$@][A-Za-z0-9_$@-]*){0,4}$/,
    "Use the field name, or a.b for nested fields.",
  );

export const Attribute = z.object({
  name: AttributeName,
  type: z.enum(ATTRIBUTE_TYPES),
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  /** Identifies the record across systems (a business key, not a database id). */
  identifier: z.boolean().optional(),
  required: z.boolean().optional(),
  /** Holds the identifier of another entity, e.g. SalesOrder.customer → Customer. */
  references: EntityName.optional(),
  /** Other names people and systems use; they guide AI binding proposals. */
  synonyms: z.array(z.string().max(60)).max(20).optional(),
});
export type Attribute = z.infer<typeof Attribute>;
export type AttributeInput = z.input<typeof Attribute>;

export interface Entity {
  name: string;
  label: string;
  description: string;
  attributes: Attribute[];
  /** "platform": shipped with the catalog; "tenant": the workspace's own (or extended). */
  origin: "platform" | "tenant";
  /** Attributes the workspace added to a platform entity. */
  extended?: string[];
}

/** How a system writes values the catalog keeps in one standard form. */
export interface Dialect {
  /** "YN": Y/N flags (Oracle EBS); "native": JSON booleans. */
  booleans: "native" | "YN";
  /** "odata-v2": /Date(ms)/ (SAP Gateway); "iso": ISO 8601 text. */
  dates: "iso" | "odata-v2";
}

export interface SystemInfo {
  id: string;
  label: string;
  description: string;
  /** What its objects are: tables and views, REST resources, OData entity sets, records. */
  objectKind: string;
  dialect: Dialect;
  origin: "platform" | "tenant";
}

export const DEFAULT_DIALECT: Dialect = { booleans: "native", dates: "iso" };

/** One technical field bound to one attribute. */
export interface FieldBinding {
  field: string;
  attribute: string;
  /** JSONata from the technical value ($value; the whole record is the context) to the catalog value. */
  read?: string;
  /** JSONata from the catalog value ($value; the whole entity is the context) to the technical value. */
  write?: string;
  /** Read only: never written back (computed or reference fields). */
  readOnly?: boolean;
  origin: "platform" | "tenant";
  /** For AI-proposed bindings a person or the policy approved. */
  confidence?: number;
  evidence?: string;
}

/** A system object (table, resource, record type) bound to an entity. */
export interface ObjectBinding {
  system: string;
  object: string;
  entity: string;
  label: string;
  description: string;
  origin: "platform" | "tenant";
  fields: FieldBinding[];
}

/** Authoring shorthand for platform bindings: "attribute" or the full form. */
export type FieldSpec = string | { attribute: string; read?: string; write?: string; readOnly?: boolean };

export interface ObjectSpec {
  object: string;
  entity: string;
  label: string;
  description?: string;
  fields: Record<string, FieldSpec>;
}

export function objectFromSpec(system: string, spec: ObjectSpec): ObjectBinding {
  return {
    system,
    object: spec.object,
    entity: spec.entity,
    label: spec.label,
    description: spec.description ?? "",
    origin: "platform",
    fields: Object.entries(spec.fields).map(([field, s]) =>
      typeof s === "string" ? { field, attribute: s, origin: "platform" } : { field, ...s, origin: "platform" },
    ),
  };
}

export const objectKey = (system: string, object: string) => `${system}/${object}`;
