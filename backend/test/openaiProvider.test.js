import test from "node:test";
import assert from "node:assert/strict";

import { __testables } from "../src/provider/openaiProvider.js";

const {
  finalizeCandidateFacts,
  reconcileLookupEvidence,
  determineLookupAnswerStatus,
  buildLookupAnswerFallback,
} = __testables;

test("question-derived lookup candidates are suppressed", () => {
  const facts = finalizeCandidateFacts(
    [
      {
        fact: "User asked about current Apple stock price.",
        category: "user_preference",
        recommendation: "approve",
        recommendationReason: "explicit question about stock",
      },
    ],
    {
      transcriptText: "What's Apple's stock at right now?",
      existingApprovedFacts: [],
    }
  );

  assert.deepEqual(facts, []);
});

test("greeting-derived memory candidates are suppressed", () => {
  const facts = finalizeCandidateFacts(
    [
      {
        fact: "User query includes a friendly greeting.",
        category: "user_preference",
        recommendation: "dismiss",
        recommendationReason: "Expression of politeness",
      },
    ],
    {
      transcriptText: "Hello, how are you?",
      existingApprovedFacts: [],
    }
  );

  assert.deepEqual(facts, []);
});

test("reconcileLookupEvidence upgrades usable extracted answers", () => {
  const evidence = reconcileLookupEvidence({
    evidence: {
      evidenceStatus: "missing",
      supportsDirectAnswer: false,
      confidence: 0,
    },
    extraction: {
      retrievalStatus: "results_found",
      answerExtractability: "direct_answer",
      resultTopicMatch: "high",
    },
    citations: [],
    webSearches: [{ id: "search-1" }],
  });

  assert.equal(evidence.evidenceStatus, "strong");
  assert.equal(evidence.supportsDirectAnswer, true);
  assert.ok(evidence.confidence >= 0.7);
});

test("direct extracted answers resolve to answered status", () => {
  const answerStatus = determineLookupAnswerStatus({
    lookupPlan: {
      questionKind: "market_price",
      resolutionStatus: "unresolved",
    },
    evidence: {
      evidenceStatus: "strong",
      supportsDirectAnswer: true,
      confidence: 0.9,
    },
    extraction: {
      retrievalStatus: "results_found",
      answerExtractability: "direct_answer",
      resultTopicMatch: "high",
    },
    compactedText: "Apple's stock is currently trading at $316.22.",
  });

  assert.equal(answerStatus, "answered");
});

test("fallback uses extracted direct answers instead of generic filler", () => {
  const fallback = buildLookupAnswerFallback({
    question: "Is the golf course near me open today?",
    lookupPlan: {
      questionKind: "hours",
      resolutionStatus: "resolved",
    },
    compactedText: "",
    citations: [],
    webSearches: [],
    answerStatus: "answered",
    evidence: {
      evidenceStatus: "strong",
      supportsDirectAnswer: true,
      confidence: 0.9,
    },
    extraction: {
      answerExtractability: "direct_answer",
      resultTopicMatch: "high",
      displayAnswer: "Yes, The Ridge Golf Club in Waterford, PA, is open today from 6:00 AM to 9:00 PM.",
      spokenAnswer: "Yes, The Ridge Golf Club is open today from early morning to evening.",
    },
  });

  assert.match(fallback.displayAnswer, /open today/i);
  assert.doesNotMatch(fallback.displayAnswer, /couldn't shape it/i);
});
