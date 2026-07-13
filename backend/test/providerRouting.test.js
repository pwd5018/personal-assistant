import test from "node:test";
import assert from "node:assert/strict";

import {
  getProviderCatalog,
  getRoutingDefaults,
  provider,
  resolveProviderRoute,
} from "../src/provider/index.js";

test("the initial routing catalog exposes all logical routes", () => {
  const catalog = getProviderCatalog();

  assert.equal(catalog.providers.length, 1);
  assert.equal(catalog.providers[0].id, "openai");
  assert.deepEqual(Object.keys(catalog.routes).sort(), Object.keys(getRoutingDefaults()).sort());
  assert.ok(catalog.routes.chat);
  assert.ok(catalog.routes["voice.stt"]);
  assert.ok(catalog.routes["voice.tts"]);
});

test("the existing OpenAI provider resolves for every initial route", () => {
  for (const route of Object.keys(getRoutingDefaults())) {
    const resolved = resolveProviderRoute(route);

    assert.equal(resolved.provider, provider);
    assert.equal(resolved.providerId, "openai");
    assert.equal(typeof resolved.capability, "string");
  }
});

test("unknown routes fail before provider work begins", () => {
  assert.throws(() => resolveProviderRoute("voice.realtime"), /Unknown provider route/);
});
