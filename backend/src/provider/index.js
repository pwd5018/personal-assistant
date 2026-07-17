import { OpenAiProvider } from "./openaiProvider.js";
import { GeminiProvider } from "./geminiProvider.js";
import { GroqProvider } from "./groqProvider.js";
import { buildProviderDescriptor, buildRoutingCatalog, assertRouteName } from "./routing.js";
import { store } from "../store.js";
import { config } from "../config.js";

const openAiProvider = new OpenAiProvider();
const geminiProvider = new GeminiProvider();
const groqProvider = new GroqProvider();

export const providerRegistry = new Map([
  [openAiProvider.id, openAiProvider],
  [geminiProvider.id, geminiProvider],
  [groqProvider.id, groqProvider],
]);

export const provider = openAiProvider;

export function getProviderCatalog() {
  const providers = [...providerRegistry.values()].map((item) =>
    buildProviderDescriptor(item.getDescriptor())
  );
  return buildRoutingCatalog({
    providers,
    routes: getRoutingSelections(),
    readiness: getProviderReadiness({ providers }),
  });
}

export function getProviderReadiness({ providers = null } = {}) {
  const descriptors = providers || [...providerRegistry.values()].map((item) =>
    buildProviderDescriptor(item.getDescriptor())
  );
  const selections = getRoutingSelections();
  const providerStates = Object.fromEntries(
    descriptors.map((descriptor) => [descriptor.id, {
      id: descriptor.id,
      label: descriptor.label,
      configured: descriptor.configured,
      capabilities: [...descriptor.capabilities],
      status: descriptor.configured ? "configured" : "missing_key",
    }])
  );
  const routes = Object.fromEntries(
    Object.entries(selections).map(([route, selection]) => {
      const providerState = providerStates[selection.provider];
      const configured = Boolean(providerState?.configured);
      return [route, {
        route,
        capability: selection.capability,
        provider: selection.provider,
        model: selection.model,
        configured,
        usable: configured,
        status: configured ? "ready" : "provider_missing_key",
      }];
    })
  );

  return { providers: providerStates, routes };
}

export function getRoutingDefaults() {
  const openAiDescriptor = openAiProvider.getDescriptor();
  return {
    chat: { provider: "openai", capability: "chat", model: openAiDescriptor.models.chat },
    "voice.stt": { provider: "openai", capability: "transcription", model: openAiDescriptor.models.transcription },
    "voice.tts": { provider: "openai", capability: "speech_synthesis", model: openAiDescriptor.models.speech_synthesis, voice: config.ttsVoice },
    summary: { provider: "openai", capability: "summary", model: openAiDescriptor.models.summary },
    "lookup.decision": { provider: "openai", capability: "lookup_decision", model: openAiDescriptor.models.lookup_decision },
    "lookup.retrieval": { provider: "openai", capability: "lookup_retrieval", model: openAiDescriptor.models.lookup_retrieval },
    "lookup.composition": { provider: "openai", capability: "lookup_composition", model: openAiDescriptor.models.lookup_composition },
    fact_extraction: { provider: "openai", capability: "fact_extraction", model: openAiDescriptor.models.fact_extraction },
  };
}

export function getRoutingSelections() {
  const defaults = getRoutingDefaults();
  const persisted = new Map(store.getProviderSettings().map((setting) => [setting.route, setting]));

  return Object.fromEntries(
    Object.entries(defaults).map(([route, selection]) => {
      const saved = persisted.get(route);
      return [
        route,
        saved && isValidSelection(route, saved.provider_id, saved.model)
          ? {
              provider: saved.provider_id,
              capability: selection.capability,
              model: saved.model,
              ...(route === "voice.tts"
                ? {
                    voice: isValidVoice(route, saved.provider_id, saved.voice, saved.model)
                      ? saved.voice
                      : getDefaultVoice(saved.provider_id, saved.model) || selection.voice || null,
                  }
                : {}),
              updatedAt: saved.updated_at,
            }
        : selection,
      ];
    })
  );
}

export function validateProviderSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Provider settings must be an object keyed by route.");
  }

  const normalized = [];
  for (const [route, selection] of Object.entries(input)) {
    assertRouteName(route);
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
      throw new Error(`Provider settings for ${route} must be an object.`);
    }

    const providerId = String(selection.provider || "").trim();
    const model = String(selection.model || "").trim();
    const voice = selection.voice == null ? null : String(selection.voice).trim();
    if (!providerId || !model) {
      throw new Error(`Provider and model are required for route ${route}.`);
    }

    if (!isValidSelection(route, providerId, model)) {
      throw new Error(`Provider ${providerId} does not support route ${route}.`);
    }

    if (route === "voice.tts" && voice && !isValidVoice(route, providerId, voice, model)) {
      throw new Error(`Voice ${voice} is not supported for route ${route}.`);
    }

    normalized.push({
      route,
      providerId,
      model,
      voice: route === "voice.tts" ? voice || getDefaultVoice(providerId, model) || null : null,
    });
  }

  return normalized;
}

export function saveProviderSettings(input) {
  const normalized = validateProviderSettings(input);
  store.upsertProviderSettings(normalized);
  return getRoutingSelections();
}

export function resetProviderSettings(routes = []) {
  const normalizedRoutes = Array.isArray(routes) ? routes : [];
  normalizedRoutes.forEach(assertRouteName);
  store.deleteProviderSettings(normalizedRoutes);
  return getRoutingSelections();
}

export function resolveProviderRoute(route) {
  assertRouteName(route);
  const selection = getRoutingSelections()[route];
  const selectedProvider = providerRegistry.get(selection.provider);

  if (!selectedProvider) {
    throw new Error(`Provider ${selection.provider} is not registered for route ${route}.`);
  }

  if (!selectedProvider.getDescriptor().capabilities.includes(selection.capability)) {
    throw new Error(`Provider ${selection.provider} does not support route ${route}.`);
  }

  return {
    route,
    provider: selectedProvider,
    providerId: selection.provider,
    capability: selection.capability,
    model: selection.model || null,
    voice: selection.voice || null,
  };
}

function isValidVoice(route, providerId, voice, model) {
  if (route !== "voice.tts" || !voice) return false;
  const voices = getProviderVoices(providerId, model);
  return voices.includes(voice);
}

function getProviderVoices(providerId, model) {
  const catalog = providerRegistry.get(providerId)?.getDescriptor().voices?.speech_synthesis || [];
  if (Array.isArray(catalog)) return catalog;
  return catalog[model] || catalog["*"] || [];
}

function getDefaultVoice(providerId, model) {
  if (providerId === "openai") return config.ttsVoice;
  if (providerId === "gemini") return config.geminiTtsVoice;
  if (providerId === "groq") return model === "canopylabs/orpheus-arabic-saudi" ? "fahad" : "autumn";
  return getProviderVoices(providerId, model)[0] || null;
}

function isValidSelection(route, providerId, model) {
  const defaultSelection = getRoutingDefaults()[route];
  const selectedProvider = providerRegistry.get(providerId);
  return Boolean(
    defaultSelection &&
      selectedProvider &&
      model &&
      selectedProvider.getDescriptor().capabilities.includes(defaultSelection.capability)
  );
}
