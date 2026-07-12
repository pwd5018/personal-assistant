import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSelfKnowledgeOverview,
  buildSelfKnowledgeResponse,
  buildTurnExplainability,
  __testables,
} from "../src/selfKnowledgeService.js";
import { store } from "../src/store.js";

test("self-knowledge topic classifier recognizes first-pass questions", () => {
  assert.equal(__testables.classifySelfKnowledgeTopic("how do you work"), "architecture");
  assert.equal(__testables.classifySelfKnowledgeTopic("what do you store locally"), "storage");
  assert.equal(__testables.classifySelfKnowledgeTopic("what model handled my last turn"), "provider_path");
  assert.equal(__testables.classifySelfKnowledgeTopic("why did you answer that way"), "recent_reply");
  assert.equal(__testables.classifySelfKnowledgeTopic("why didn't audio play"), "debug_help");
  assert.equal(__testables.classifySelfKnowledgeTopic("what data did you use for that turn"), "turn_data_usage");
  assert.equal(__testables.classifySelfKnowledgeTopic("what was stored from that turn"), "turn_storage");
  assert.equal(__testables.classifySelfKnowledgeTopic("was that model-only or lookup-backed"), "turn_routing");
  assert.equal(__testables.classifySelfKnowledgeTopic("tell me a joke"), null);
});

test("self-knowledge overview exposes local architecture and storage facts", () => {
  const overview = buildSelfKnowledgeOverview();

  assert.match(overview.architectureSummary, /React frontend/i);
  assert.match(overview.providerSummary, /local backend/i);
  assert.ok(overview.storageFacts.some((fact) => /assistant\.sqlite/i.test(fact)));
  assert.ok(overview.sampleQuestions.length >= 4);
});

test("latest-turn explanation separates evidence from unknown internals", () => {
  const explanation = __testables.buildLatestTurnExplanation({
    id: "turn-12345678",
    assistant_text: "It is sunny and 72 degrees.",
    provider_json: {
      provider: "openai",
      api: "responses",
      chatModel: "gpt-4.1-mini",
      ttsModel: "gpt-4o-mini-tts",
      lookup: {
        status: "used",
        privacyMode: "strict",
        questionKind: "weather",
        retrievalSource: "fresh_lookup",
      },
    },
    context_json: {
      approvedFacts: ["The user likes short answers."],
      recentTurns: [{ user: "Hi", assistant: "Hello" }],
      rollingSummary: "Confirmed context: local testing.",
    },
  });

  assert.match(explanation.providerAnswer, /openai via responses/i);
  assert.match(explanation.explainAnswer, /Confirmed evidence:/i);
  assert.ok(explanation.evidence.length >= 4);
  assert.ok(explanation.unknowns.some((item) => /chain-of-thought/i.test(item)));
  assert.equal(explanation.answerMode, "current_source_answer");
  assert.ok(explanation.nextChecks.some((item) => /citations/i.test(item)));
});

test("storage self-knowledge response is answered from local facts", () => {
  const response = buildSelfKnowledgeResponse("What do you store locally?");

  assert.equal(response.topic, "storage");
  assert.match(response.text, /assistant\.sqlite/i);
  assert.ok(response.evidence.some((item) => /lookup cache/i.test(item)));
});

test("failure debug explanation suggests targeted next checks", () => {
  const explanation = __testables.buildFailureDebugExplanation({
    id: "manual-failure-b0e793d1-a5d7-46ec-b7a9-27d64fcfb402",
    turn_status: "completed_with_tts_failure",
    failure_json: {
      stage: "tts",
      message: "Audio generation failed.",
    },
    provider_json: {
      provider: "openai",
      lookup: {
        status: "not_needed",
      },
    },
    latency_json: {
      sttComplete: new Date().toISOString(),
      chatFirstToken: new Date().toISOString(),
      chatFinalToken: new Date().toISOString(),
    },
  });

  assert.equal(explanation.failureCategory, "tts");
  assert.match(explanation.debugAnswer, /speech synthesis/i);
  assert.ok(explanation.nextChecks.some((item) => /assistant text/i.test(item)));
  assert.equal(explanation.summary, "TTS issue on turn b0e793d1.");
});

test("selected turn explainability returns reply and failure sections", () => {
  const explainability = buildTurnExplainability({
    id: "manual-failure-b0e793d1-a5d7-46ec-b7a9-27d64fcfb402",
    turn_status: "completed_with_tts_failure",
    assistant_text: "Hello there.",
    provider_json: {
      provider: "openai",
      api: "chat_completions",
      chatModel: "gpt-4.1-mini",
      ttsModel: "gpt-4o-mini-tts",
      lookup: {
        status: "not_needed",
      },
    },
    context_json: {
      approvedFacts: [],
      recentTurns: [],
      rollingSummary: "",
    },
    latency_json: {
      sttComplete: new Date().toISOString(),
      chatFinalToken: new Date().toISOString(),
    },
    token_json: {
      provider: {
        total_tokens: 12,
      },
    },
    failure_json: {
      stage: "tts",
      message: "Audio generation failed.",
    },
  });

  assert.equal(explainability.answerMode, "text_reply_with_tts_failure");
  assert.ok(explainability.evidence.length >= 4);
  assert.match(explainability.dataUsage.summary, /current utterance/i);
  assert.equal(explainability.dataUsage.lookupUsed, false);
  assert.ok(explainability.storedArtifacts.storedFields.includes("failure_json"));
  assert.equal(explainability.routing.lookupBacked, false);
  assert.match(explainability.routing.approvedFactsImpact, /No approved facts/i);
  assert.equal(explainability.failure?.failureCategory, "tts");
  assert.equal(explainability.failure?.summary, "TTS issue on turn b0e793d1.");
});

test("turn-specific self-knowledge response uses latest turn explainability buckets", () => {
  const response = buildSelfKnowledgeResponse("What data did you use for that turn?");

  assert.equal(response.topic, "turn_data_usage");
  assert.ok(response.latestTurnId);
  assert.match(response.text, /approved facts|external lookup|current utterance/i);
});

test("turn-specific self-knowledge response honors explicit explain turn selection", () => {
  const turnId = `selected-turn-${Date.now()}`;
  store.insertTurn({
    id: turnId,
    session_id: "selected-turn-session",
    created_at: new Date().toISOString(),
    transcript_text: "Tell me something current.",
    assistant_text: "Here is the latest weather update.",
    turn_status: "completed",
    context_json: JSON.stringify({
      currentUserText: "Tell me something current.",
      approvedFacts: ["The user likes short answers."],
      recentTurns: [{ user: "Hello", assistant: "Hi" }],
      rollingSummary: "User prefers direct answers.",
    }),
    latency_json: JSON.stringify({ chatFinalToken: new Date().toISOString() }),
    token_json: JSON.stringify({ provider: { total_tokens: 18 } }),
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

  const response = buildSelfKnowledgeResponse("What data did you use for that turn?", {
    explainTurnId: turnId,
  });

  assert.equal(response.latestTurnId, turnId);
  assert.equal(response.explainability.latestTurnId, turnId);
  assert.equal(response.explainability.dataUsage.lookupUsed, true);
  assert.match(response.text, /lookup-backed|external lookup|approved facts/i);
});
