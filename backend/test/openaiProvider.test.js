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

test("hours clarification fallback asks for location instead of golf-specific wording", () => {
  const fallback = buildLookupAnswerFallback({
    question: "What time does the DMV close today?",
    lookupPlan: {
      questionKind: "hours",
      resolutionStatus: "unresolved",
      queryEnrichment: null,
    },
    compactedText: "",
    citations: [],
    webSearches: [],
    answerStatus: "needs_clarification",
    evidence: {
      evidenceStatus: "missing",
      supportsDirectAnswer: false,
      confidence: 0.2,
    },
    extraction: {
      answerExtractability: "insufficient",
      resultTopicMatch: "low",
    },
  });

  assert.match(fallback.displayAnswer, /city, state, or specific place name/i);
  assert.doesNotMatch(fallback.displayAnswer, /golf course/i);
});

test("specific sports misses fall back to an uncertain score message instead of clarification", () => {
  const answerStatus = determineLookupAnswerStatus({
    question: "What's the Yankees score right now?",
    lookupPlan: {
      questionKind: "sports",
      resolutionStatus: "unresolved",
    },
    evidence: {
      evidenceStatus: "missing",
      supportsDirectAnswer: false,
      confidence: 0.2,
    },
    extraction: {
      retrievalStatus: "no_results",
      answerExtractability: "insufficient",
      resultTopicMatch: "low",
    },
    compactedText: "",
  });

  const fallback = buildLookupAnswerFallback({
    question: "What's the Yankees score right now?",
    lookupPlan: {
      questionKind: "sports",
      resolutionStatus: "unresolved",
    },
    compactedText: "",
    citations: [],
    webSearches: [{ id: "sports-search-1" }],
    answerStatus,
    evidence: {
      evidenceStatus: "missing",
      supportsDirectAnswer: false,
      confidence: 0.2,
    },
    extraction: {
      retrievalStatus: "no_results",
      answerExtractability: "insufficient",
      resultTopicMatch: "low",
    },
  });

  assert.equal(answerStatus, "uncertain");
  assert.match(fallback.displayAnswer, /yankees/i);
  assert.match(fallback.displayAnswer, /couldn't find a reliable live/i);
});

test("live market-price questions do not present closing prices as confirmed live quotes", () => {
  const answerStatus = determineLookupAnswerStatus({
    question: "What's Apple's stock price right now?",
    lookupPlan: {
      questionKind: "market_price",
      resolutionStatus: "unresolved",
    },
    evidence: {
      evidenceStatus: "weak",
      supportsDirectAnswer: true,
      confidence: 0.8,
    },
    extraction: {
      retrievalStatus: "results_found",
      answerExtractability: "direct_answer",
      resultTopicMatch: "high",
      displayAnswer: "Apple's stock (AAPL) closed at $315.32 on July 10, 2026.",
    },
    compactedText: "Apple's stock (AAPL) closed at $315.32 on July 10, 2026.",
  });

  const fallback = buildLookupAnswerFallback({
    question: "What's Apple's stock price right now?",
    lookupPlan: {
      questionKind: "market_price",
      resolutionStatus: "unresolved",
    },
    compactedText: "Apple's stock (AAPL) closed at $315.32 on July 10, 2026.",
    citations: [],
    webSearches: [{ id: "market-search-1" }],
    answerStatus,
    evidence: {
      evidenceStatus: "weak",
      supportsDirectAnswer: true,
      confidence: 0.8,
    },
    extraction: {
      retrievalStatus: "results_found",
      answerExtractability: "direct_answer",
      resultTopicMatch: "high",
      displayAnswer: "Apple's stock (AAPL) closed at $315.32 on July 10, 2026.",
    },
  });

  assert.equal(answerStatus, "partial");
  assert.match(fallback.displayAnswer, /closing price/i);
  assert.match(fallback.displayAnswer, /not a confirmed live quote/i);
});

test("exchange-rate misses fall back to uncertain instead of asking for more detail", () => {
  const answerStatus = determineLookupAnswerStatus({
    question: "What's the exchange rate from USD to EUR today?",
    lookupPlan: {
      questionKind: "market_price",
      resolutionStatus: "unresolved",
    },
    evidence: {
      evidenceStatus: "missing",
      supportsDirectAnswer: false,
      confidence: 0.2,
    },
    extraction: {
      retrievalStatus: "no_results",
      answerExtractability: "insufficient",
      resultTopicMatch: "low",
    },
    compactedText: "",
  });

  const fallback = buildLookupAnswerFallback({
    question: "What's the exchange rate from USD to EUR today?",
    lookupPlan: {
      questionKind: "market_price",
      resolutionStatus: "unresolved",
    },
    compactedText: "",
    citations: [],
    webSearches: [{ id: "market-search-2" }],
    answerStatus,
    evidence: {
      evidenceStatus: "missing",
      supportsDirectAnswer: false,
      confidence: 0.2,
    },
    extraction: {
      retrievalStatus: "no_results",
      answerExtractability: "insufficient",
      resultTopicMatch: "low",
    },
  });

  assert.equal(answerStatus, "uncertain");
  assert.match(fallback.displayAnswer, /exchange rate for USD to EUR/i);
});

test("generic lookup misses fall back to uncertain instead of asking for more detail", () => {
  const answerStatus = determineLookupAnswerStatus({
    question: "Who is the CEO of Nvidia right now?",
    lookupPlan: {
      questionKind: "other",
      resolutionStatus: "unresolved",
    },
    evidence: {
      evidenceStatus: "missing",
      supportsDirectAnswer: false,
      confidence: 0.2,
    },
    extraction: {
      retrievalStatus: "no_results",
      answerExtractability: "insufficient",
      resultTopicMatch: "low",
    },
    compactedText: "",
  });

  const fallback = buildLookupAnswerFallback({
    question: "Who is the CEO of Nvidia right now?",
    lookupPlan: {
      questionKind: "other",
      resolutionStatus: "unresolved",
    },
    compactedText: "",
    citations: [],
    webSearches: [{ id: "other-search-1" }],
    answerStatus,
    evidence: {
      evidenceStatus: "missing",
      supportsDirectAnswer: false,
      confidence: 0.2,
    },
    extraction: {
      retrievalStatus: "no_results",
      answerExtractability: "insufficient",
      resultTopicMatch: "low",
    },
  });

  assert.equal(answerStatus, "uncertain");
  assert.match(fallback.displayAnswer, /couldn't find a reliable current answer/i);
});

test("noisy multi-location summaries are not passed through as direct generic answers", () => {
  const fallback = buildLookupAnswerFallback({
    question: "What time does the DMV close today?",
    lookupPlan: {
      questionKind: "other",
      resolutionStatus: "unresolved",
      queryEnrichment: null,
    },
    compactedText:
      "California DMV offices typically close at 5 PM. Connecticut DMV branches close at 4 PM. Maryland MVA branches often close at 4:30 PM.",
    citations: [{ title: "DMV info", url: "https://example.com/dmv" }],
    webSearches: [{ id: "other-search-2" }],
    answerStatus: "uncertain",
    evidence: {
      evidenceStatus: "weak",
      supportsDirectAnswer: false,
      confidence: 0.4,
    },
    extraction: {
      retrievalStatus: "results_found",
      answerExtractability: "insufficient",
      resultTopicMatch: "medium",
    },
  });

  assert.equal(
    fallback.displayAnswer,
    "I couldn't find a reliable current answer from the sources I found."
  );
});
