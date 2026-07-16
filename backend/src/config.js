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
  corsOrigins: buildCorsOrigins(process.env.CORS_ORIGIN),
  openAiApiKey: process.env.OPENAI_API_KEY || "",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  groqApiKey: process.env.GROQ_API_KEY || "",
  geminiChatModel: process.env.GEMINI_CHAT_MODEL || "gemini-2.5-flash",
  geminiSummaryModel: process.env.GEMINI_SUMMARY_MODEL || "gemini-2.5-flash",
  geminiTtsModel: process.env.GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview",
  geminiTtsVoice: process.env.GEMINI_TTS_VOICE || "Kore",
  groqChatModel: process.env.GROQ_CHAT_MODEL || "llama-3.3-70b-versatile",
  groqSttModel: process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo",
  groqTtsModel: process.env.GROQ_TTS_MODEL || "canopylabs/orpheus-v1-english",
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

function buildCorsOrigins(value) {
  const configured = String(value || "http://127.0.0.1:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configured.some((origin) => origin.includes("127.0.0.1:5173") || origin.includes("localhost:5173"))) {
    return [...new Set([...configured, "http://127.0.0.1:5173", "http://localhost:5173"])]
  }

  return configured;
}
