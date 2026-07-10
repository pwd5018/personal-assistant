import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { app } from "../src/server.js";
import { provider } from "../src/provider/index.js";
import { store } from "../src/store.js";

const ORIGINAL_IS_CONFIGURED = provider.isConfigured;
const ORIGINAL_CLASSIFY_LOOKUP = provider.classifyExternalLookupNeed;
const ORIGINAL_FETCH_LOOKUP_ARTIFACTS = provider.fetchExternalLookupArtifacts;
const ORIGINAL_COMPOSE_LOOKUP_RESULT = provider.composeExternalLookupResult;
const ORIGINAL_SYNTHESIZE_SPEECH = provider.synthesizeSpeech;

test.before(async () => {
  await app.ready();
});

test.after(async () => {
  provider.isConfigured = ORIGINAL_IS_CONFIGURED;
  provider.classifyExternalLookupNeed = ORIGINAL_CLASSIFY_LOOKUP;
  provider.fetchExternalLookupArtifacts = ORIGINAL_FETCH_LOOKUP_ARTIFACTS;
  provider.composeExternalLookupResult = ORIGINAL_COMPOSE_LOOKUP_RESULT;
  provider.synthesizeSpeech = ORIGINAL_SYNTHESIZE_SPEECH;
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

function extractTurnComplete(body) {
  const lines = String(body || "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const turnComplete = lines.find((event) => event.type === "turn-complete");
  assert.ok(turnComplete, "expected turn-complete event");
  return turnComplete.turn;
}
