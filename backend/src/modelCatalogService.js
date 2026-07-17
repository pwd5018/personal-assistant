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

let cachedCatalog = null;
let cachedAt = 0;
let refreshPromise = null;

export async function buildModelCatalog({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cachedCatalog && now - cachedAt < config.modelCatalogTtlMs) {
    return withCatalogState(cachedCatalog, "cached");
  }

  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = refreshModelCatalog();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function refreshModelCatalog() {
  const [openai, gemini, groq] = await Promise.all([
    listOpenAiModels(),
    listGeminiModels(),
    listGroqModels(),
  ]);

  const catalog = {
    generatedAt: new Date().toISOString(),
    providers: [openai, gemini, groq],
  };

  cachedCatalog = catalog;
  cachedAt = Date.now();
  return withCatalogState(catalog, "live");
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
      const response = await fetchWithTimeout("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${config.openAiApiKey}` },
      });
      if (response.ok) {
        const body = await response.json();
        return buildProviderCatalogEntry(
          "openai",
          "OpenAI",
          true,
          (body.data || []).map((model) => normalizeModel("openai", model.id)),
          fallbackModels,
          "live"
        );
      }
    } catch {
      return buildProviderCatalogEntry("openai", "OpenAI", true, [], fallbackModels, "fallback");
    }
  }

  return buildProviderCatalogEntry(
    "openai",
    "OpenAI",
    Boolean(config.openAiApiKey),
    models,
    fallbackModels,
    config.openAiApiKey ? "fallback" : "unavailable"
  );
}

async function listGeminiModels() {
  if (!config.geminiApiKey) {
    return buildProviderCatalogEntry("gemini", "Google Gemini", false, [], [], "unavailable");
  }

  try {
    const response = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(config.geminiApiKey)}`
    );
    if (!response.ok) {
      return buildProviderCatalogEntry("gemini", "Google Gemini", true, [], geminiFallbackModels(), "fallback");
    }

    const body = await response.json();
    return buildProviderCatalogEntry(
      "gemini",
      "Google Gemini",
      true,
      (body.models || [])
        .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
        .map((model) => normalizeModel("gemini", model.baseModelId || model.name?.replace(/^models\//, ""), model)),
      geminiFallbackModels(),
      "live"
    );
  } catch {
    return buildProviderCatalogEntry("gemini", "Google Gemini", true, [], geminiFallbackModels(), "fallback");
  }
}

async function listGroqModels() {
  if (!config.groqApiKey) {
    return buildProviderCatalogEntry("groq", "Groq", false, [], [], "unavailable");
  }

  try {
    const response = await fetchWithTimeout("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${config.groqApiKey}` },
    });
    if (!response.ok) {
      return buildProviderCatalogEntry("groq", "Groq", true, [], groqFallbackModels(), "fallback");
    }

    const body = await response.json();
    return buildProviderCatalogEntry(
      "groq",
      "Groq",
      true,
      (body.data || []).map((model) => normalizeModel("groq", model.id, model)),
      groqFallbackModels(),
      "live"
    );
  } catch {
    return buildProviderCatalogEntry("groq", "Groq", true, [], groqFallbackModels(), "fallback");
  }
}

function buildProviderCatalogEntry(id, label, configured, models, fallbackModels = [], sourceStatus = "unavailable") {
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
    sourceStatus,
    pricingSourceUrl: PRICING_SOURCES[id],
    models: [...merged.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function geminiFallbackModels() {
  return [config.geminiChatModel, config.geminiSummaryModel, config.geminiTtsModel];
}

function groqFallbackModels() {
  return [config.groqChatModel, config.groqSttModel, config.groqTtsModel];
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.modelCatalogTimeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function withCatalogState(catalog, state) {
  return {
    ...catalog,
    catalogState: state,
    cachedAt: new Date(cachedAt || Date.now()).toISOString(),
    providers: catalog.providers.map((provider) => ({ ...provider })),
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
