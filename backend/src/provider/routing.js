export const PROVIDER_ROUTE_NAMES = Object.freeze([
  "chat",
  "voice.stt",
  "voice.tts",
  "summary",
  "lookup.decision",
  "lookup.composition",
  "fact_extraction",
]);

export const PROVIDER_CAPABILITIES = Object.freeze([
  "chat",
  "transcription",
  "speech_synthesis",
  "summary",
  "lookup_decision",
  "lookup_composition",
  "fact_extraction",
]);

export function buildProviderDescriptor({
  id,
  label,
  configured,
  capabilities,
  models,
}) {
  return {
    id,
    label,
    configured: Boolean(configured),
    capabilities: PROVIDER_CAPABILITIES.filter((capability) => capabilities?.includes(capability)),
    models: Object.fromEntries(
      Object.entries(models || {}).map(([capability, model]) => [capability, String(model || "")])
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
    })),
  };
}

export function assertRouteName(route) {
  if (!PROVIDER_ROUTE_NAMES.includes(route)) {
    throw new Error(`Unknown provider route: ${route}`);
  }

  return route;
}
