import { z } from "zod";
import { FlowDoc } from "./schema.js";

/**
 * JSON Schema of the FlowDoc, as given to the AI builder's tools and
 * published for API users. Generated, never hand-edited.
 */
export function flowJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(FlowDoc, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
}
