import { type ModelClient, type ProviderId, ScriptedModel } from "../model.js";
import { ANTHROPIC_DEFAULT_MODEL, AnthropicModel } from "./anthropic.js";
import { GEMINI_DEFAULT_MODEL, GeminiModel } from "./gemini.js";
import { OPENAI_DEFAULT_MODEL, OpenAIModel } from "./openai.js";

export * from "./anthropic.js";
export * from "./gemini.js";
export * from "./openai.js";

export const PROVIDERS: Record<ProviderId, { name: string; keyEnv: string[]; modelEnv: string; defaultModel: string }> =
  {
    gemini: {
      name: "Gemini",
      keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      modelEnv: "GEMINI_MODEL",
      defaultModel: GEMINI_DEFAULT_MODEL,
    },
    anthropic: {
      name: "Claude",
      keyEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
      modelEnv: "ANTHROPIC_MODEL",
      defaultModel: ANTHROPIC_DEFAULT_MODEL,
    },
    openai: { name: "GPT", keyEnv: ["OPENAI_API_KEY"], modelEnv: "OPENAI_MODEL", defaultModel: OPENAI_DEFAULT_MODEL },
  };

const ALIASES: Record<string, ProviderId | "scripted"> = {
  gemini: "gemini",
  google: "gemini",
  anthropic: "anthropic",
  claude: "anthropic",
  openai: "openai",
  gpt: "openai",
  scripted: "scripted",
};

const hasKey = (p: ProviderId, env = process.env) => PROVIDERS[p].keyEnv.some((k) => env[k]);

/**
 * Which provider the AI builder uses: AI_PROVIDER when set (gemini, anthropic
 * or openai; also google, claude, gpt), otherwise the first with a key, in
 * the order Gemini, Claude, GPT.
 */
export function configuredProvider(env = process.env): ProviderId | "scripted" | null {
  const raw = env.AI_PROVIDER?.trim().toLowerCase();
  if (raw) {
    const p = ALIASES[raw];
    if (!p) throw new Error(`AI_PROVIDER "${env.AI_PROVIDER}" is not known. Use gemini, anthropic or openai.`);
    return p;
  }
  return (["gemini", "anthropic", "openai"] as const).find((p) => hasKey(p, env)) ?? null;
}

/** The configured model, or null when the chosen provider has no key (the AI builder is then off). */
export function modelFromEnv(env = process.env): ModelClient | null {
  const p = configuredProvider(env);
  if (p === "scripted") {
    const file = env.AI_SCRIPT_FILE;
    if (!file) throw new Error("AI_PROVIDER=scripted needs AI_SCRIPT_FILE");
    return ScriptedModel.fromFile(file);
  }
  if (!p || !hasKey(p, env)) return null;
  if (p === "gemini") return new GeminiModel();
  if (p === "openai") return new OpenAIModel();
  return new AnthropicModel();
}

/** What to tell an admin when the AI builder is off. */
export function aiSetupHint(env = process.env): string {
  const p = configuredProvider(env);
  if (p && p !== "scripted") return `Set ${PROVIDERS[p].keyEnv[0]} on the server (AI_PROVIDER is ${p}).`;
  return "Set GEMINI_API_KEY on the server (or ANTHROPIC_API_KEY or OPENAI_API_KEY, with AI_PROVIDER to choose).";
}
