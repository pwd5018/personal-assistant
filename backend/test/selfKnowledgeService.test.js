import test from "node:test";
import assert from "node:assert/strict";

import { buildSelfKnowledgeOverview, buildSelfKnowledgeResponse, __testables } from "../src/selfKnowledgeService.js";

test("self-knowledge topic classifier recognizes first-pass questions", () => {
  assert.equal(__testables.classifySelfKnowledgeTopic("how do you work"), "architecture");
  assert.equal(__testables.classifySelfKnowledgeTopic("what do you store locally"), "storage");
  assert.equal(__testables.classifySelfKnowledgeTopic("what model handled my last turn"), "provider_path");
  assert.equal(__testables.classifySelfKnowledgeTopic("why did you answer that way"), "recent_reply");
  assert.equal(__testables.classifySelfKnowledgeTopic("why didn't audio play"), "debug_help");
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
