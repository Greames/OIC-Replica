import "server-only";
import { type ModelClient, modelFromEnv } from "@oicr/ai";

// One model client per server process. A scripted model (offline e2e runs)
// must keep its position across requests, so it is never recreated.
const g = globalThis as unknown as { __oicrModel?: ModelClient | null };

export function getModel(): ModelClient | null {
  if (g.__oicrModel === undefined) g.__oicrModel = modelFromEnv();
  return g.__oicrModel;
}

export function aiEnabled(): boolean {
  return getModel() !== null;
}
