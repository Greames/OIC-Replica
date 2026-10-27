import "server-only";
import { aiSetupHint, type ModelClient, modelFromEnv, PROVIDERS } from "@oicr/ai";

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

/** "Gemini · gemini-4-argon", for showing which model builds. */
export function aiLabel(): string | null {
  const m = getModel();
  if (!m) return null;
  return m.provider ? `${PROVIDERS[m.provider].name} · ${m.model}` : m.model;
}

/** What is missing when the AI builder is off. */
export function aiHint(): string {
  return aiSetupHint();
}
