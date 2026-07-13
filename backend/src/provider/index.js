import { OpenAiProvider } from "./openaiProvider.js";
import { buildProviderDescriptor, buildRoutingCatalog, assertRouteName } from "./routing.js";

const openAiProvider = new OpenAiProvider();

export const providerRegistry = new Map([[openAiProvider.id, openAiProvider]]);

export const provider = openAiProvider;

export function getProviderCatalog() {
  return buildRoutingCatalog({
    providers: [...providerRegistry.values()].map((item) =>
      buildProviderDescriptor(item.getDescriptor())
    ),
    routes: getRoutingDefaults(),
  });
}

export function getRoutingDefaults() {
  return {
    chat: { provider: "openai", capability: "chat" },
    "voice.stt": { provider: "openai", capability: "transcription" },
    "voice.tts": { provider: "openai", capability: "speech_synthesis" },
    summary: { provider: "openai", capability: "summary" },
    "lookup.decision": { provider: "openai", capability: "lookup_decision" },
    "lookup.composition": { provider: "openai", capability: "lookup_composition" },
    fact_extraction: { provider: "openai", capability: "fact_extraction" },
  };
}

export function resolveProviderRoute(route) {
  assertRouteName(route);
  const selection = getRoutingDefaults()[route];
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
    model: selectedProvider.getDescriptor().models[selection.capability] || null,
  };
}
