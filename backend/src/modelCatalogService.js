import { config } from "./config.js";

const PRICING_SOURCES = Object.freeze({
  openai: "https://openai.com/api/pricing/",
  gemini: "https://ai.google.dev/gemini-api/docs/pricing",
  groq: "https://groq.com/pricing/",
});

const GROQ_PRICING = Object.freeze({
  "llama-3.1-8b-instant": { inputPerMillionUsd: 0.05, outputPerMillionUsd: 0.08 },
  "llama-3.3-70b-versatile": { inputPerMillionUsd: 0.59, outputPerMillionUsd: 0.79 },
  "openai/gpt-oss-120b": { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  "openai/gpt-oss-20b": { inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.3 },
  "whisper-large-v3": { audioPerHourUsd: 0.111 },
  "whisper-large-v3-turbo": { audioPerHourUsd: 0.04 },
  "canopylabs/orpheus-v1-english": { outputPerMillionCharactersUsd: 22 },
  "canopylabs/orpheus-arabic-saudi": { outputPerMillionCharactersUsd: 40 },
});

export async function buildModelCatalog() {
  const [openai, gemini, groq] = await Promise.all([
    listOpenAiModels(),
    listGeminiModels(),
    listGroqModels(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    providers: [openai, gemini, groq],
  };
}

async function listOpenAiModels() {
  const fallbackModels = [
    config.chatModel,
    config.summaryModel,
    config.factExtractionModel,
    config.sttModel,
    config.ttsModel,
    config.externalLookupModel,
    config.externalLookupDecisionModel,
    config.externalLookupCompositionModel,
  ];
  let models = [];

  if (config.openAiApiKey) {
    try {
      const response = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${config.openAiApiKey}` },
      });
      if (response.ok) {
        const body = await response.json();
        models = (body.data || []).map((model) => normalizeModel("openai", model.id));
      }
    } catch {
      models = [];
    }
  }

  return buildProviderCatalogEntry("openai", "OpenAI", Boolean(config.openAiApiKey), models, fallbackModels);
}

async function listGeminiModels() {
  if (!config.geminiApiKey) {
    return buildProviderCatalogEntry("gemini", "Google Gemini", false, [], []);
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(config.geminiApiKey)}`
    );
    if (!response.ok) {
      return buildProviderCatalogEntry("gemini", "Google Gemini", true, [], []);
    }

    const body = await response.json();
    return buildProviderCatalogEntry(
      "gemini",
      "Google Gemini",
      true,
      (body.models || [])
        .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
        .map((model) => normalizeModel("gemini", model.baseModelId || model.name?.replace(/^models\//, ""), model))
    );
  } catch {
    return buildProviderCatalogEntry("gemini", "Google Gemini", true, [], []);
  }
}

async function listGroqModels() {
  if (!config.groqApiKey) {
    return buildProviderCatalogEntry("groq", "Groq", false, [], []);
  }

  try {
    const response = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${config.groqApiKey}` },
    });
    if (!response.ok) {
      return buildProviderCatalogEntry("groq", "Groq", true, [], []);
    }

    const body = await response.json();
    return buildProviderCatalogEntry(
      "groq",
      "Groq",
      true,
      (body.data || []).map((model) => normalizeModel("groq", model.id, model))
    );
  } catch {
    return buildProviderCatalogEntry("groq", "Groq", true, [], []);
  }
}

function buildProviderCatalogEntry(id, label, configured, models, fallbackModels = []) {
  const merged = new Map(models.map((model) => [model.id, model]));
  for (const modelId of fallbackModels) {
    if (!merged.has(modelId)) {
      merged.set(modelId, normalizeModel(id, modelId));
    }
  }

  return {
    id,
    label,
    configured,
    pricingSourceUrl: PRICING_SOURCES[id],
    models: [...merged.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function normalizeModel(provider, id, raw = {}) {
  const modelId = String(id || "").trim();
  return {
    id: modelId,
    displayName: raw.displayName || raw.name || modelId,
    capabilities: inferCapabilities(provider, modelId, raw),
    contextWindow: raw.inputTokenLimit || raw.context_window || raw.context_length || null,
    pricing: getPricing(provider, modelId),
  };
}

function inferCapabilities(provider, modelId, raw) {
  const normalized = modelId.toLowerCase();
  const capabilities = [];

  if (provider === "gemini") {
    if (raw.supportedGenerationMethods?.includes("generateContent")) capabilities.push("chat", "summary", "lookup_decision", "lookup_composition", "fact_extraction");
    if (normalized.includes("tts") || normalized.includes("audio") || raw.outputAudio) capabilities.push("speech_synthesis");
    return [...new Set(capabilities)];
  }

  if (normalized.includes("whisper") || normalized.includes("transcri")) capabilities.push("transcription");
  if (normalized.includes("tts") || normalized.includes("speech") || normalized.includes("orpheus")) capabilities.push("speech_synthesis");
  if (!capabilities.length) {
    capabilities.push("chat", "summary", "lookup_decision", "lookup_retrieval", "lookup_composition", "fact_extraction");
  }

  return [...new Set(capabilities)];
}

function getPricing(provider, modelId) {
  const known = provider === "groq" ? GROQ_PRICING[modelId] : null;
  return {
    status: known ? "known" : "reference_only",
    currency: "USD",
    unit: known?.audioPerHourUsd || known?.outputPerMillionCharactersUsd ? "provider_specific" : "per_million_tokens",
    ...(known || {}),
    sourceUrl: PRICING_SOURCES[provider],
  };
}
