export const PROVIDER_ROUTE_NAMES = Object.freeze([
  "chat",
  "voice.stt",
  "voice.tts",
  "summary",
  "lookup.decision",
  "lookup.retrieval",
  "lookup.composition",
  "fact_extraction",
]);

export const PROVIDER_CAPABILITIES = Object.freeze([
  "chat",
  "transcription",
  "speech_synthesis",
  "summary",
  "lookup_decision",
  "lookup_retrieval",
  "lookup_composition",
  "fact_extraction",
]);

export function buildProviderDescriptor({
  id,
  label,
  configured,
  capabilities,
  models,
  voices,
}) {
  return {
    id,
    label,
    configured: Boolean(configured),
    capabilities: PROVIDER_CAPABILITIES.filter((capability) => capabilities?.includes(capability)),
    models: Object.fromEntries(
      Object.entries(models || {}).map(([capability, model]) => [capability, String(model || "")])
    ),
    voices: Object.fromEntries(
      Object.entries(voices || {}).map(([capability, values]) => [capability, [...values]])
    ),
  };
}

export function buildRoutingCatalog({ providers, routes }) {
  return {
    routes: Object.fromEntries(
      PROVIDER_ROUTE_NAMES.map((route) => [route, routes?.[route] || null])
    ),
    providers: providers.map((provider) => ({
      ...provider,
      capabilities: [...provider.capabilities],
      models: { ...provider.models },
      voices: Object.fromEntries(
        Object.entries(provider.voices || {}).map(([capability, values]) => [capability, [...values]])
      ),
    })),
  };
}

export function assertRouteName(route) {
  if (!PROVIDER_ROUTE_NAMES.includes(route)) {
    throw new Error(`Unknown provider route: ${route}`);
  }

  return route;
}
