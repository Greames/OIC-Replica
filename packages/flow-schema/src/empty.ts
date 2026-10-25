import type { FlowDoc } from "./schema.js";
import { SCHEMA_VERSION } from "./schema.js";

/** The document a new integration starts with (S05). */
export function emptyFlow(style: FlowDoc["style"]): FlowDoc {
  return {
    schemaVersion: SCHEMA_VERSION,
    style,
    trigger:
      style === "scheduled"
        ? { id: "trigger", type: "schedule" }
        : { id: "trigger", type: "http", method: "POST", path: "/", sync: false },
    variables: {},
    steps: [],
    businessIds: [],
  };
}
