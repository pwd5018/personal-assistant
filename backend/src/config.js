import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({
  path: path.resolve(__dirname, "../.env"),
});

export const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || "127.0.0.1",
  corsOrigin: process.env.CORS_ORIGIN || "http://127.0.0.1:5173",
  openAiApiKey: process.env.OPENAI_API_KEY || "",
  chatModel: process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini",
  summaryModel: process.env.OPENAI_SUMMARY_MODEL || "gpt-4.1-nano",
  factExtractionModel:
    process.env.OPENAI_FACT_EXTRACTION_MODEL ||
    process.env.OPENAI_SUMMARY_MODEL ||
    "gpt-4.1-nano",
  sttModel: process.env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe",
  ttsModel: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
  ttsVoice: process.env.OPENAI_TTS_VOICE || "alloy",
  externalLookupEnabled: normalizeBoolean(process.env.EXTERNAL_LOOKUP_ENABLED, true),
  externalLookupPrivacyMode: process.env.EXTERNAL_LOOKUP_PRIVACY_MODE || "strict",
  externalLookupDecisionModel:
    process.env.EXTERNAL_LOOKUP_DECISION_MODEL ||
    process.env.OPENAI_SUMMARY_MODEL ||
    "gpt-4.1-nano",
  externalLookupCompositionModel:
    process.env.EXTERNAL_LOOKUP_COMPOSITION_MODEL ||
    process.env.OPENAI_SUMMARY_MODEL ||
    "gpt-4.1-nano",
  externalLookupModel: process.env.EXTERNAL_LOOKUP_MODEL || process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini",
  externalLookupSearchContextSize: normalizeSearchContextSize(
    process.env.EXTERNAL_LOOKUP_SEARCH_CONTEXT_SIZE || "medium"
  ),
  systemPrompt:
    process.env.SYSTEM_PROMPT ||
    [
      "You are a private desktop voice companion for one trusted user.",
      "Respond like a calm, thoughtful person speaking out loud, not like a formal assistant.",
      "Be warm, concise, and natural.",
      "Prioritize the user's immediate request over background context.",
      "Prefer short voice-friendly phrasing unless the user asks for detail.",
      "Use only the provided context and avoid pretending unapproved facts are durable truth.",
      "Use approved facts only when they are relevant, and weave them in naturally instead of listing them back.",
      "Do not mention summaries, memory, or stored facts unless the user asks or it clearly helps the reply.",
      "If context is missing, respond helpfully without inventing personal history.",
      "If you are unsure about a personal detail, say so plainly instead of guessing.",
    ].join(" "),
  summaryIdleMs: Number(process.env.SUMMARY_IDLE_MS || 25000),
};

function normalizeBoolean(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }

  return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}

function normalizeSearchContextSize(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  return ["low", "medium", "high"].includes(normalized) ? normalized : "medium";
}
