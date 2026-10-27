import { createHash } from "node:crypto";
import {
  type Attribute,
  DEFAULT_DIALECT,
  type Entity,
  type FieldBinding,
  type ObjectBinding,
  objectKey,
  type SystemInfo,
} from "./catalog.js";
import { CATALOG_VERSION, PLATFORM_ENTITIES } from "./platform.js";
import { PLATFORM_OBJECTS, PLATFORM_SYSTEMS } from "./systems/index.js";

// A workspace's semantic graph: the platform catalog and bindings, with the
// workspace's own layer on top. The workspace layer wins: it can add
// attributes and entities, rebind or unbind platform fields, and bind objects
// of any system.

export interface TenantEntity {
  name: string;
  label: string;
  description: string;
  attributes: Attribute[];
}

export interface TenantObject {
  system: string;
  object: string;
  entity: string;
  label?: string | null;
  description?: string | null;
}

export interface TenantBinding {
  system: string;
  object: string;
  field: string;
  /** null: the platform binding of this field is switched off. */
  attribute: string | null;
  read?: string | null;
  write?: string | null;
  readOnly?: boolean | null;
  confidence?: number | null;
  evidence?: string | null;
}

export interface TenantLayer {
  entities: TenantEntity[];
  objects: TenantObject[];
  bindings: TenantBinding[];
}

export const EMPTY_LAYER: TenantLayer = { entities: [], objects: [], bindings: [] };

/** Something in the workspace layer that could not be applied (shown on the catalog). */
export interface GraphProblem {
  system?: string;
  object?: string;
  field?: string;
  message: string;
}

export class SemanticGraph {
  readonly version = CATALOG_VERSION;
  readonly problems: GraphProblem[] = [];
  private readonly entityMap = new Map<string, Entity>();
  private readonly systemMap = new Map<string, SystemInfo>();
  private readonly objectMap = new Map<string, ObjectBinding>();
  private readonly hashes = new Map<string, string>();

  constructor(layer: TenantLayer = EMPTY_LAYER) {
    for (const e of PLATFORM_ENTITIES) this.entityMap.set(e.name, { ...e, attributes: [...e.attributes] });
    for (const t of layer.entities) this.applyEntity(t);

    for (const s of PLATFORM_SYSTEMS) this.systemMap.set(s.id, s);
    for (const o of PLATFORM_OBJECTS) this.objectMap.set(objectKey(o.system, o.object), structuredClone(o));
    for (const o of layer.objects) this.applyObject(o);
    for (const b of layer.bindings) this.applyBinding(b);
    for (const o of this.objectMap.values()) this.prune(o);
  }

  entities(): Entity[] {
    return [...this.entityMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  entity(name: string): Entity | undefined {
    return this.entityMap.get(name);
  }

  attribute(entity: string, name: string): Attribute | undefined {
    return this.entityMap.get(entity)?.attributes.find((a) => a.name === name);
  }

  systems(): SystemInfo[] {
    return [...this.systemMap.values()];
  }

  system(id: string): SystemInfo | undefined {
    return this.systemMap.get(id);
  }

  objects(filter: { system?: string; entity?: string } = {}): ObjectBinding[] {
    return [...this.objectMap.values()].filter(
      (o) => (!filter.system || o.system === filter.system) && (!filter.entity || o.entity === filter.entity),
    );
  }

  object(system: string, object: string): ObjectBinding | undefined {
    return this.objectMap.get(objectKey(system, object));
  }

  /** "system/object" → entity, for validating flows. Objects without field bindings are left out. */
  objectIndex(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, o] of this.objectMap) if (o.fields.length > 0) out[k] = o.entity;
    return out;
  }

  /** A stable hash of everything that decides how one object is read and written. */
  objectHash(system: string, object: string): string | undefined {
    const key = objectKey(system, object);
    const cached = this.hashes.get(key);
    if (cached) return cached;
    const o = this.objectMap.get(key);
    if (!o) return undefined;
    const fields = [...o.fields]
      .sort((a, b) => a.field.localeCompare(b.field))
      .map((f) => [f.field, f.attribute, this.attribute(o.entity, f.attribute)?.type, f.read, f.write, !!f.readOnly]);
    const dialect = this.systemMap.get(o.system)?.dialect ?? DEFAULT_DIALECT;
    const hash = createHash("sha256")
      .update(JSON.stringify([o.system, o.object, o.entity, dialect, fields]))
      .digest("hex");
    this.hashes.set(key, hash);
    return hash;
  }

  private applyEntity(t: TenantEntity): void {
    const base = this.entityMap.get(t.name);
    if (!base) {
      this.entityMap.set(t.name, { ...t, origin: "tenant" });
      return;
    }
    const added: Attribute[] = [];
    for (const a of t.attributes) {
      if (base.attributes.some((x) => x.name === a.name))
        this.problems.push({
          message: `${t.name}.${a.name} already exists in the platform catalog; the copy is ignored.`,
        });
      else added.push(a);
    }
    this.entityMap.set(t.name, {
      ...base,
      description: t.description || base.description,
      attributes: [...base.attributes, ...added],
      extended: added.map((a) => a.name),
    });
  }

  private applyObject(t: TenantObject): void {
    if (!this.entityMap.has(t.entity)) {
      this.problems.push({ ...t, message: `Entity ${t.entity} does not exist, so ${t.object} is not bound.` });
      return;
    }
    if (!this.systemMap.has(t.system))
      this.systemMap.set(t.system, {
        id: t.system,
        label: t.system,
        description: "",
        objectKind: "object",
        dialect: DEFAULT_DIALECT,
        origin: "tenant",
      });
    const key = objectKey(t.system, t.object);
    const seed = this.objectMap.get(key);
    this.objectMap.set(key, {
      system: t.system,
      object: t.object,
      entity: t.entity,
      label: t.label || seed?.label || t.object,
      description: t.description ?? seed?.description ?? "",
      origin: "tenant",
      // Platform fields only make sense for the entity they were written for.
      fields: seed && seed.entity === t.entity ? seed.fields : [],
    });
  }

  private applyBinding(b: TenantBinding): void {
    const o = this.objectMap.get(objectKey(b.system, b.object));
    if (!o) {
      this.problems.push({
        ...b,
        message: `${b.object} of ${b.system} is not bound to an entity, so ${b.field} is ignored.`,
      });
      return;
    }
    const rest = o.fields.filter((f) => f.field !== b.field);
    if (b.attribute === null) {
      o.fields = rest;
      return;
    }
    if (!this.attribute(o.entity, b.attribute)) {
      this.problems.push({ ...b, message: `${o.entity} has no attribute "${b.attribute}", so ${b.field} is ignored.` });
      o.fields = rest;
      return;
    }
    const field: FieldBinding = {
      field: b.field,
      attribute: b.attribute,
      origin: "tenant",
      ...(b.read ? { read: b.read } : {}),
      ...(b.write ? { write: b.write } : {}),
      ...(b.readOnly ? { readOnly: true } : {}),
      ...(b.confidence != null ? { confidence: b.confidence } : {}),
      ...(b.evidence ? { evidence: b.evidence } : {}),
    };
    // One field per attribute: the workspace's binding replaces a platform one.
    o.fields = [...rest.filter((f) => !(f.attribute === b.attribute && f.origin === "platform")), field];
  }

  /** Drops platform fields whose attribute no longer exists or is bound twice. */
  private prune(o: ObjectBinding): void {
    const seen = new Set<string>();
    o.fields = o.fields.filter((f) => {
      if (!this.attribute(o.entity, f.attribute) || seen.has(f.attribute)) return false;
      seen.add(f.attribute);
      return true;
    });
  }
}
