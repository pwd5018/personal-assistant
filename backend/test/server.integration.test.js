import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { app } from "../src/server.js";
import { getRoutingDefaults, provider, saveProviderSettings } from "../src/provider/index.js";
import { store } from "../src/store.js";

const ORIGINAL_IS_CONFIGURED = provider.isConfigured;
const ORIGINAL_CLASSIFY_LOOKUP = provider.classifyExternalLookupNeed;
const ORIGINAL_FETCH_LOOKUP_ARTIFACTS = provider.fetchExternalLookupArtifacts;
const ORIGINAL_COMPOSE_LOOKUP_RESULT = provider.composeExternalLookupResult;
const ORIGINAL_SYNTHESIZE_SPEECH = provider.synthesizeSpeech;
const ORIGINAL_STREAM_CHAT = provider.streamChat;

test.before(async () => {
  await app.ready();
});

test.afterEach(() => {
  provider.isConfigured = ORIGINAL_IS_CONFIGURED;
  provider.classifyExternalLookupNeed = ORIGINAL_CLASSIFY_LOOKUP;
  provider.fetchExternalLookupArtifacts = ORIGINAL_FETCH_LOOKUP_ARTIFACTS;
  provider.composeExternalLookupResult = ORIGINAL_COMPOSE_LOOKUP_RESULT;
  provider.synthesizeSpeech = ORIGINAL_SYNTHESIZE_SPEECH;
  provider.streamChat = ORIGINAL_STREAM_CHAT;
});

test.after(async () => {
  provider.isConfigured = ORIGINAL_IS_CONFIGURED;
  provider.classifyExternalLookupNeed = ORIGINAL_CLASSIFY_LOOKUP;
  provider.fetchExternalLookupArtifacts = ORIGINAL_FETCH_LOOKUP_ARTIFACTS;
  provider.composeExternalLookupResult = ORIGINAL_COMPOSE_LOOKUP_RESULT;
  provider.synthesizeSpeech = ORIGINAL_SYNTHESIZE_SPEECH;
  provider.streamChat = ORIGINAL_STREAM_CHAT;
  await app.close();
});

test("preview endpoint returns a structured lookup preview", async () => {
  provider.isConfigured = () => false;

  const response = await app.inject({
    method: "POST",
    url: "/api/debug/external-lookup/preview",
    payload: {
      question: "What's the weather at the golf course near me today?",
      privacyMode: "balanced",
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.preview.privacyMode, "balanced");
  assert.equal(body.preview.questionKind, "weather");
  assert.equal(body.preview.lookupNeeded, true);
  assert.ok(["resolved", "ambiguous", "unresolved"].includes(body.preview.resolutionStatus));
});

test("provider settings endpoint returns the routing catalog", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/settings/providers",
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.providerCatalog.providers[0].id, "openai");
  assert.ok(body.providerCatalog.routes.chat.model);
});

test("health exposes route-level provider readiness", async () => {
  const response = await app.inject({ method: "GET", url: "/api/health" });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(typeof body.routesReady, "number");
  assert.ok(body.providerCatalog.readiness.routes.chat);
  assert.equal(
    body.providerCatalog.readiness.routes.chat.usable,
    Boolean(body.providerCatalog.readiness.providers[body.providerCatalog.routes.chat.provider]?.configured)
  );
});

test("lookup privacy mode persists through the settings API", async () => {
  const saveResponse = await app.inject({
    method: "PATCH",
    url: "/api/settings/privacy",
    payload: { lookupPrivacyMode: "balanced" },
  });
  assert.equal(saveResponse.statusCode, 200);
  assert.equal(saveResponse.json().lookupPrivacyMode, "balanced");

  const readResponse = await app.inject({ method: "GET", url: "/api/settings/privacy" });
  assert.equal(readResponse.statusCode, 200);
  assert.equal(readResponse.json().lookupPrivacyMode, "balanced");

  const invalidResponse = await app.inject({
    method: "PATCH",
    url: "/api/settings/privacy",
    payload: { lookupPrivacyMode: "unsafe" },
  });
  assert.equal(invalidResponse.statusCode, 400);
  assert.match(invalidResponse.json().error, /strict or balanced/);

  await app.inject({
    method: "PATCH",
    url: "/api/settings/privacy",
    payload: { lookupPrivacyMode: "strict" },
  });
});

test("provider settings can reset one route without clearing the others", async () => {
  const defaults = getRoutingDefaults();
  saveProviderSettings({
    chat: { provider: "openai", model: "temporary-chat-model" },
    summary: { provider: "openai", model: "temporary-summary-model" },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/settings/providers/reset",
      payload: { routes: ["chat"] },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().routes.chat.model, defaults.chat.model);
    assert.equal(response.json().routes.summary.model, "temporary-summary-model");
  } finally {
    saveProviderSettings({
      chat: { provider: "openai", model: defaults.chat.model },
      summary: { provider: "openai", model: defaults.summary.model },
    });
  }
});

test("provider settings endpoint validates unsupported selections", async () => {
  const response = await app.inject({
    method: "PATCH",
    url: "/api/settings/providers",
    payload: {
      routes: {
        summary: { provider: "groq", model: "groq-test" },
      },
    },
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /does not support route summary/);
});

test("retry applies saved chat and TTS models and stores the routing snapshot", async () => {
  const defaults = getRoutingDefaults();
  const observed = { chat: null, tts: null, ttsVoice: null };
  saveProviderSettings({
    chat: { provider: "openai", model: "test-chat-route-model" },
    "voice.tts": { provider: "openai", model: "test-tts-route-model", voice: "coral" },
  });

  provider.isConfigured = () => true;
  provider.classifyExternalLookupNeed = async () => ({
    needed: false,
    questionKind: "general_chat",
    answerMode: "model_only",
    needsResolution: false,
    canUseLocalMemoryForResolution: false,
    reason: "test",
    matchedSignals: [],
    confidence: 0.95,
  });
  provider.streamChat = async ({ model, onDelta }) => {
    observed.chat = model;
    onDelta("Test reply.");
    return { usage: { total_tokens: 1 } };
  };
  provider.synthesizeSpeech = async ({ model, voice, text }) => {
    observed.tts = model;
    observed.ttsVoice = voice;
    return { audioBuffer: Buffer.from("audio"), mimeType: "audio/mpeg", speechInput: text };
  };

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/voice/retry",
      payload: {
        sessionId: "routing-snapshot-session",
        turnId: `routing-snapshot-${randomUUID()}`,
        transcriptText: "Say a test reply.",
      },
    });

    assert.equal(response.statusCode, 200);
    const turn = extractTurnComplete(response.body);
    assert.equal(observed.chat, "test-chat-route-model");
    assert.equal(observed.tts, "test-tts-route-model");
    assert.equal(observed.ttsVoice, "coral");
    assert.equal(turn.provider.routes.chat.model, "test-chat-route-model");
    assert.equal(turn.provider.routes["voice.tts"].model, "test-tts-route-model");
    assert.equal(turn.timings.routes.chat.status, "success");
    assert.equal(turn.timings.routes["voice.tts"].status, "success");
    assert.ok(Number.isInteger(turn.timings.routes.chat.durationMs));
    assert.ok(turn.provider.telemetry.routes.chat);
  } finally {
    saveProviderSettings({
      chat: { provider: "openai", model: defaults.chat.model },
      "voice.tts": { provider: "openai", model: defaults["voice.tts"].model },
    });
  }
});

test("retry passes the saved voice direction to buffered TTS and records its application", async () => {
  const defaults = getRoutingDefaults();
  const observed = { hint: null };
  saveProviderSettings({
    "voice.tts": {
      provider: "openai",
      model: "gpt-4o-mini-tts",
      voice: "coral",
      voiceHint: "gentle, warm, and concise",
    },
  });

  provider.isConfigured = () => true;
  provider.classifyExternalLookupNeed = async () => ({
    needed: false,
    questionKind: "general_chat",
    answerMode: "model_only",
    needsResolution: false,
    canUseLocalMemoryForResolution: false,
    reason: "test",
    matchedSignals: [],
    confidence: 0.95,
  });
  provider.streamChat = async ({ onDelta }) => {
    onDelta("Hinted reply.");
    return { usage: { total_tokens: 1 } };
  };
  provider.synthesizeSpeech = async ({ voiceHint, text }) => {
    observed.hint = voiceHint;
    return { audioBuffer: Buffer.from("audio"), mimeType: "audio/mpeg", speechInput: text };
  };

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/voice/retry",
      payload: {
        sessionId: "voice-hint-session",
        turnId: `voice-hint-${randomUUID()}`,
        transcriptText: "Say a hinted reply.",
      },
    });

    assert.equal(response.statusCode, 200);
    const turn = extractTurnComplete(response.body);
    assert.equal(observed.hint, "gentle, warm, and concise");
    assert.equal(turn.timings.routes["voice.tts"].synthesisMode, "buffered");
    assert.equal(turn.timings.routes["voice.tts"].hintApplied, true);
    assert.equal(turn.timings.routes["voice.tts"].hintCapability, "supported");
  } finally {
    saveProviderSettings({
      "voice.tts": { provider: "openai", model: defaults["voice.tts"].model },
    });
  }
});

test("debug turn endpoint returns parsed provider metadata", async () => {
  const turnId = `test-turn-${randomUUID()}`;

  store.insertTurn({
    id: turnId,
    session_id: "test-session",
    created_at: new Date().toISOString(),
    transcript_text: "What's Apple's stock at right now?",
    assistant_text: "Apple's stock is currently trading at $316.22.",
    turn_status: "completed",
    context_json: JSON.stringify({ currentUserText: "What's Apple's stock at right now?" }),
    latency_json: JSON.stringify({ chatFinalToken: new Date().toISOString() }),
    token_json: JSON.stringify({ provider: { total_tokens: 42 } }),
    provider_json: JSON.stringify({
      provider: "openai",
      lookup: {
        status: "used",
        questionKind: "market_price",
        answerStatus: "answered",
        retrievalStatus: "results_found",
        answerExtractability: "direct_answer",
        resultTopicMatch: "high",
      },
    }),
    failure_json: null,
    transcript_mime_type: "retry/text",
    audio_bytes: 0,
  });

  const response = await app.inject({
    method: "GET",
    url: `/api/debug/turns/${turnId}`,
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.turn.id, turnId);
  assert.equal(body.turn.provider_json.lookup.answerStatus, "answered");
  assert.equal(body.turn.provider_json.lookup.retrievalStatus, "results_found");
  assert.equal(body.turn.provider_json.lookup.answerExtractability, "direct_answer");
  assert.equal(body.explainability.answerMode, "current_source_answer");
  assert.equal(body.explainability.dataUsage.lookupUsed, true);
  assert.equal(body.explainability.routing.lookupBacked, true);
  assert.ok(Array.isArray(body.explainability.storedArtifacts.storedFields));
  assert.equal(body.explainability.failure, null);
});

test("self-knowledge debug endpoint returns overview and latest turn explanation", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/debug/self-knowledge",
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.match(body.selfKnowledge.overview.architectureSummary, /React frontend/i);
  assert.ok(Array.isArray(body.selfKnowledge.overview.sampleQuestions));
  assert.ok(Object.prototype.hasOwnProperty.call(body.selfKnowledge, "latestFailureExplanation"));
});

test("retry endpoint answers self-knowledge questions without invoking lookup or chat", async () => {
  provider.isConfigured = () => false;
  provider.classifyExternalLookupNeed = async () => {
    throw new Error("lookup should not run for self-knowledge");
  };
  provider.fetchExternalLookupArtifacts = async () => {
    throw new Error("lookup artifacts should not run for self-knowledge");
  };
  provider.streamChat = async () => {
    throw new Error("chat should not run for self-knowledge");
  };
  provider.synthesizeSpeech = async ({ text }) => ({
    audioBuffer: Buffer.from("audio"),
    mimeType: "audio/mpeg",
    speechInput: text,
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/voice/retry",
    payload: {
      sessionId: "self-knowledge-test-session",
      turnId: `self-knowledge-${randomUUID()}`,
      transcriptText: "How do you work?",
      lookupPrivacyMode: "strict",
    },
  });

  assert.equal(response.statusCode, 200);
  const turn = extractTurnComplete(response.body);

  assert.equal(turn.provider.provider, "local_self_knowledge");
  assert.equal(turn.provider.selfKnowledge.topic, "architecture");
  assert.equal(turn.provider.lookup.status, "not_applicable");
  assert.match(turn.assistantText, /React frontend/i);
});

test("retry endpoint answers failure-debug self-knowledge questions from stored evidence", async () => {
  provider.isConfigured = () => false;
  provider.classifyExternalLookupNeed = async () => {
    throw new Error("lookup should not run for self-knowledge");
  };
  provider.fetchExternalLookupArtifacts = async () => {
    throw new Error("lookup artifacts should not run for self-knowledge");
  };
  provider.streamChat = async () => {
    throw new Error("chat should not run for self-knowledge");
  };
  provider.synthesizeSpeech = async ({ text }) => ({
    audioBuffer: Buffer.from("audio"),
    mimeType: "audio/mpeg",
    speechInput: text,
  });

  store.insertTurn({
    id: `failure-turn-${randomUUID()}`,
    session_id: "failure-session",
    created_at: new Date().toISOString(),
    transcript_text: "Say hello.",
    assistant_text: "Hello there.",
    turn_status: "completed_with_tts_failure",
    context_json: JSON.stringify({ currentUserText: "Say hello." }),
    latency_json: JSON.stringify({ sttComplete: new Date().toISOString(), chatFinalToken: new Date().toISOString() }),
    token_json: JSON.stringify({ provider: { total_tokens: 10 } }),
    provider_json: JSON.stringify({
      provider: "openai",
      chatModel: "gpt-4.1-mini",
      ttsModel: "gpt-4o-mini-tts",
      lookup: {
        status: "not_needed",
      },
    }),
    failure_json: JSON.stringify({
      stage: "tts",
      message: "Audio generation failed.",
    }),
    transcript_mime_type: "retry/text",
    audio_bytes: 0,
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/voice/retry",
    payload: {
      sessionId: "self-knowledge-debug-session",
      turnId: `self-knowledge-debug-${randomUUID()}`,
      transcriptText: "Why didn't audio play?",
      lookupPrivacyMode: "strict",
    },
  });

  assert.equal(response.statusCode, 200);
  const turn = extractTurnComplete(response.body);

  assert.equal(turn.provider.provider, "local_self_knowledge");
  assert.equal(turn.provider.selfKnowledge.topic, "debug_help");
  assert.ok(turn.provider.selfKnowledge.nextChecks.some((item) => /assistant text/i.test(item)));
  assert.match(turn.assistantText, /Confirmed evidence:/i);
});

test("retry endpoint answers turn-data self-knowledge questions from latest turn evidence", async () => {
  provider.isConfigured = () => false;
  provider.classifyExternalLookupNeed = async () => {
    throw new Error("lookup should not run for self-knowledge");
  };
  provider.fetchExternalLookupArtifacts = async () => {
    throw new Error("lookup artifacts should not run for self-knowledge");
  };
  provider.streamChat = async () => {
    throw new Error("chat should not run for self-knowledge");
  };
  provider.synthesizeSpeech = async ({ text }) => ({
    audioBuffer: Buffer.from("audio"),
    mimeType: "audio/mpeg",
    speechInput: text,
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/voice/retry",
    payload: {
      sessionId: "self-knowledge-turn-data-session",
      turnId: `self-knowledge-turn-data-${randomUUID()}`,
      transcriptText: "What data did you use for that turn?",
      lookupPrivacyMode: "strict",
    },
  });

  assert.equal(response.statusCode, 200);
  const turn = extractTurnComplete(response.body);

  assert.equal(turn.provider.provider, "local_self_knowledge");
  assert.equal(turn.provider.selfKnowledge.topic, "turn_data_usage");
  assert.match(turn.assistantText, /current utterance|approved facts|external lookup/i);
});

test("retry endpoint anchors self-knowledge questions to the requested explain turn", async () => {
  provider.isConfigured = () => false;
  provider.classifyExternalLookupNeed = async () => {
    throw new Error("lookup should not run for self-knowledge");
  };
  provider.fetchExternalLookupArtifacts = async () => {
    throw new Error("lookup artifacts should not run for self-knowledge");
  };
  provider.streamChat = async () => {
    throw new Error("chat should not run for self-knowledge");
  };
  provider.synthesizeSpeech = async ({ text }) => ({
    audioBuffer: Buffer.from("audio"),
    mimeType: "audio/mpeg",
    speechInput: text,
  });

  const explainTurnId = `anchored-turn-${randomUUID()}`;
  store.insertTurn({
    id: explainTurnId,
    session_id: "anchored-session",
    created_at: new Date().toISOString(),
    transcript_text: "Check the weather.",
    assistant_text: "It is 72 and sunny.",
    turn_status: "completed",
    context_json: JSON.stringify({
      currentUserText: "Check the weather.",
      approvedFacts: ["The user prefers concise answers."],
      recentTurns: [{ user: "Hi", assistant: "Hello" }],
      rollingSummary: "Keep answers short.",
    }),
    latency_json: JSON.stringify({ chatFinalToken: new Date().toISOString() }),
    token_json: JSON.stringify({ provider: { total_tokens: 14 } }),
    provider_json: JSON.stringify({
      provider: "openai",
      api: "responses",
      chatModel: "gpt-4.1-mini",
      ttsModel: "gpt-4o-mini-tts",
      lookup: {
        status: "used",
        privacyMode: "strict",
        questionKind: "weather",
        retrievalSource: "cache",
        citations: [{ title: "Weather", url: "https://example.com/weather" }],
      },
    }),
    failure_json: null,
    transcript_mime_type: "retry/text",
    audio_bytes: 0,
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/voice/retry",
    payload: {
      sessionId: "self-knowledge-anchored-session",
      turnId: `self-knowledge-anchored-${randomUUID()}`,
      transcriptText: "What data did you use for that turn?",
      explainTurnId,
      lookupPrivacyMode: "strict",
    },
  });

  assert.equal(response.statusCode, 200);
  const turn = extractTurnComplete(response.body);

  assert.equal(turn.provider.provider, "local_self_knowledge");
  assert.equal(turn.provider.selfKnowledge.topic, "turn_data_usage");
  assert.equal(turn.provider.selfKnowledge.latestTurnId, explainTurnId);
  assert.equal(turn.provider.selfKnowledge.requestedTurnId, explainTurnId);
  assert.match(turn.assistantText, /lookup-backed|external lookup|approved facts/i);
});

test("retry endpoint reuses cached lookup retrieval artifacts on repeated current-info questions", async () => {
  store.clearLookupCache();

  let fetchCount = 0;
  provider.isConfigured = () => true;
  provider.classifyExternalLookupNeed = async () => ({
    needed: true,
    questionKind: "weather",
    answerMode: "lookup_required",
    needsResolution: false,
    canUseLocalMemoryForResolution: false,
    reason: "weather",
    matchedSignals: ["weather"],
    confidence: 0.95,
  });
  provider.fetchExternalLookupArtifacts = async () => {
    fetchCount += 1;
    return {
      rawText: "It is 72 degrees and sunny in Erie, Pennsylvania today.",
      citations: [{ title: "Weather Source", url: "https://weather.example.com/erie" }],
      webSearches: [{ id: "search-1", query: "erie pa weather", sources: [{ url: "https://weather.example.com/erie" }] }],
      usage: { total_tokens: 21 },
    };
  };
  provider.composeExternalLookupResult = async ({ citations, webSearches }) => ({
    text: "It is 72 degrees and sunny in Erie today.",
    displayText: "It is 72 degrees and sunny in Erie today.",
    spokenText: "It is 72 degrees and sunny in Erie today.",
    answerStatus: "answered",
    showSources: true,
    evidence: {
      evidenceStatus: "strong",
      supportsDirectAnswer: true,
      confidence: 0.92,
    },
    extraction: {
      retrievalStatus: "results_found",
      answerExtractability: "direct_answer",
      resultTopicMatch: "high",
    },
    citations,
    webSearches,
  });
  provider.synthesizeSpeech = async ({ text }) => ({
    audioBuffer: Buffer.from("audio"),
    mimeType: "audio/mpeg",
    speechInput: text,
  });

  const firstResponse = await app.inject({
    method: "POST",
    url: "/api/voice/retry",
    payload: {
      sessionId: "cache-test-session",
      turnId: `cache-test-1-${randomUUID()}`,
      transcriptText: "What's the weather in Erie today?",
      lookupPrivacyMode: "strict",
    },
  });

  const secondResponse = await app.inject({
    method: "POST",
    url: "/api/voice/retry",
    payload: {
      sessionId: "cache-test-session",
      turnId: `cache-test-2-${randomUUID()}`,
      transcriptText: "What's the weather in Erie today?",
      lookupPrivacyMode: "strict",
    },
  });

  assert.equal(fetchCount, 1);

  const firstTurn = extractTurnComplete(firstResponse.body);
  const secondTurn = extractTurnComplete(secondResponse.body);

  assert.equal(firstTurn.provider.lookup.cache.status, "stored");
  assert.equal(secondTurn.provider.lookup.cache.status, "hit");
  assert.equal(secondTurn.provider.lookup.retrievalSource, "cache");
});

test("chat provider failure is stored as a chat failure instead of a generic server error", async () => {
  const turnId = `chat-failure-${randomUUID()}`;
  provider.isConfigured = () => true;
  provider.classifyExternalLookupNeed = async () => ({
    needed: false,
    questionKind: "general_chat",
    answerMode: "model_only",
    needsResolution: false,
    canUseLocalMemoryForResolution: false,
    reason: "test",
    matchedSignals: [],
    confidence: 0.95,
  });
  provider.streamChat = async () => {
    throw new Error("Chat provider temporarily unavailable.");
  };
  provider.synthesizeSpeech = async () => {
    throw new Error("TTS should not run after chat failure.");
  };

  const response = await app.inject({
    method: "POST",
    url: "/api/voice/retry",
    payload: {
      sessionId: "chat-failure-session",
      turnId,
      transcriptText: "Say something.",
    },
  });

  assert.equal(response.statusCode, 200);
  const events = parseEvents(response.body);
  assert.equal(events.find((event) => event.type === "error")?.stage, "chat");
  const storedTurn = store.getTurnById(turnId);
  assert.equal(storedTurn.turn_status, "chat_failed");
  assert.equal(storedTurn.failure_json.stage, "chat");
  assert.equal(storedTurn.failure_json.message, "Chat provider temporarily unavailable.");
});

test("TTS cancellation is not converted into a successful text-only fallback", async () => {
  provider.isConfigured = () => true;
  provider.classifyExternalLookupNeed = async () => ({
    needed: false,
    questionKind: "general_chat",
    answerMode: "model_only",
    needsResolution: false,
    canUseLocalMemoryForResolution: false,
    reason: "test",
    matchedSignals: [],
    confidence: 0.95,
  });
  provider.streamChat = async ({ onDelta }) => {
    onDelta("A reply.");
    return { usage: { total_tokens: 1 } };
  };
  provider.synthesizeSpeech = async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  };

  const response = await app.inject({
    method: "POST",
    url: "/api/voice/retry",
    payload: {
      sessionId: "tts-cancel-session",
      turnId: `tts-cancel-${randomUUID()}`,
      transcriptText: "Say something.",
    },
  });

  assert.equal(response.statusCode, 200);
  const events = parseEvents(response.body);
  assert.equal(events.find((event) => event.type === "error")?.stage, "cancelled");
  assert.equal(events.some((event) => event.type === "turn-complete"), false);
});

function extractTurnComplete(body) {
  const events = parseEvents(body);
  const turnComplete = events.find((event) => event.type === "turn-complete");
  assert.ok(turnComplete, "expected turn-complete event");
  return turnComplete.turn;
}

function parseEvents(body) {
  return String(body || "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
