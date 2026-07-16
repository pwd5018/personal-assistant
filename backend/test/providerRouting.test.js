import test from "node:test";
import assert from "node:assert/strict";

import {
  getProviderCatalog,
  getRoutingDefaults,
  getRoutingSelections,
  provider,
  resolveProviderRoute,
  saveProviderSettings,
} from "../src/provider/index.js";

test("the initial routing catalog exposes all logical routes", () => {
  const catalog = getProviderCatalog();

  assert.ok(catalog.providers.some((item) => item.id === "openai"));
  assert.ok(catalog.providers.some((item) => item.id === "gemini"));
  assert.ok(catalog.providers.some((item) => item.id === "groq"));
  assert.deepEqual(Object.keys(catalog.routes).sort(), Object.keys(getRoutingDefaults()).sort());
  assert.ok(catalog.routes.chat);
  assert.ok(catalog.routes["voice.stt"]);
  assert.ok(catalog.routes["voice.tts"]);
  assert.deepEqual(catalog.providers.find((item) => item.id === "openai").voices.speech_synthesis.includes("alloy"), true);
  assert.deepEqual(catalog.providers.find((item) => item.id === "gemini").voices.speech_synthesis.includes("Kore"), true);
});

test("the persisted provider selection resolves for every route", () => {
  for (const route of Object.keys(getRoutingDefaults())) {
    const resolved = resolveProviderRoute(route);

    assert.equal(resolved.providerId, getRoutingSelections()[route].provider);
    assert.ok(resolved.provider);
    assert.equal(typeof resolved.capability, "string");
    assert.ok(resolved.model);
  }
});

test("provider route settings persist and affect route resolution", () => {
  const originalModel = getRoutingDefaults().chat.model;
  const updated = saveProviderSettings({
    chat: { provider: "openai", model: "test-chat-model" },
  });

  assert.equal(updated.chat.model, "test-chat-model");
  assert.equal(resolveProviderRoute("chat").model, "test-chat-model");

  saveProviderSettings({
    chat: { provider: "openai", model: originalModel },
  });
});

test("unsupported provider selections are rejected", () => {
  assert.throws(
    () => saveProviderSettings({ summary: { provider: "groq", model: "groq-test" } }),
    /does not support route summary/
  );
});

test("registered providers expose capability-safe route support", () => {
  saveProviderSettings({
    chat: { provider: "openai", model: getRoutingDefaults().chat.model },
  });
  assert.equal(resolveProviderRoute("chat").providerId, "openai");

  saveProviderSettings({
    chat: { provider: "gemini", model: "gemini-2.5-flash" },
    "voice.stt": { provider: "groq", model: "whisper-large-v3-turbo" },
    "voice.tts": { provider: "groq", model: "canopylabs/orpheus-v1-english" },
  });

  assert.equal(resolveProviderRoute("chat").providerId, "gemini");
  assert.equal(resolveProviderRoute("voice.stt").providerId, "groq");
  assert.equal(resolveProviderRoute("voice.tts").providerId, "groq");

  saveProviderSettings({
    chat: { provider: "openai", model: getRoutingDefaults().chat.model },
    "voice.stt": { provider: "openai", model: getRoutingDefaults()["voice.stt"].model },
    "voice.tts": { provider: "openai", model: getRoutingDefaults()["voice.tts"].model },
  });
});

test("Gemini is available for speech synthesis routing", () => {
  saveProviderSettings({
    "voice.tts": { provider: "gemini", model: "gemini-3.1-flash-tts-preview" },
  });

  assert.equal(resolveProviderRoute("voice.tts").providerId, "gemini");

  saveProviderSettings({
    "voice.tts": { provider: "gemini", model: "gemini-3.1-flash-tts-preview", voice: "Kore" },
  });
  assert.equal(resolveProviderRoute("voice.tts").voice, "Kore");

  assert.throws(
    () => saveProviderSettings({ "voice.tts": { provider: "gemini", model: "gemini-3.1-flash-tts-preview", voice: "not-a-voice" } }),
    /Voice not-a-voice is not supported/
  );

  saveProviderSettings({
    "voice.tts": { provider: "openai", model: getRoutingDefaults()["voice.tts"].model },
  });
});

test("unknown routes fail before provider work begins", () => {
  assert.throws(() => resolveProviderRoute("voice.realtime"), /Unknown provider route/);
});
