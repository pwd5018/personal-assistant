import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLookupCacheDescriptor,
  buildLookupCacheEntry,
  determineLookupCacheWritePolicy,
} from "../src/lookupCache.js";

function buildLookupPlan(overrides = {}) {
  return {
    query: "What's the weather in Erie, PA today?",
    questionKind: "weather",
    privacyMode: "strict",
    answerMode: "lookup_required",
    resolutionStatus: "resolved",
    contextMode: "question_only",
    queryEnrichment: {
      entity: "",
      location: "Erie, PA",
    },
    ...overrides,
  };
}

test("cache descriptor normalizes equivalent lookup intent to the same key", () => {
  const first = buildLookupCacheDescriptor(
    buildLookupPlan({
      query: "  What's   the WEATHER in Erie, PA today? ",
    })
  );
  const second = buildLookupCacheDescriptor(
    buildLookupPlan({
      query: "what's the weather in erie, pa today?",
    })
  );

  assert.equal(first.cacheable, true);
  assert.equal(first.key, second.key);
});

test("market-price paraphrases normalize to the same cache key", () => {
  const first = buildLookupCacheDescriptor(
    buildLookupPlan({
      query: "What's Apple's stock price right now?",
      questionKind: "market_price",
      queryEnrichment: null,
    })
  );
  const second = buildLookupCacheDescriptor(
    buildLookupPlan({
      query: "What's Apple stock at right now?",
      questionKind: "market_price",
      queryEnrichment: null,
    })
  );

  assert.equal(first.cacheable, true);
  assert.equal(first.key, second.key);
  assert.equal(first.keyParts.query, "market_price apple");
});

test("exchange-rate paraphrases normalize to the same cache key", () => {
  const first = buildLookupCacheDescriptor(
    buildLookupPlan({
      query: "What's the exchange rate from USD to EUR today?",
      questionKind: "market_price",
      queryEnrichment: null,
    })
  );
  const second = buildLookupCacheDescriptor(
    buildLookupPlan({
      query: "USD/EUR exchange rate right now",
      questionKind: "market_price",
      queryEnrichment: null,
    })
  );

  assert.equal(first.cacheable, true);
  assert.equal(first.key, second.key);
  assert.equal(first.keyParts.query, "market_price usd eur");
});

test("generic other lookup questions normalize without staying fully literal", () => {
  const first = buildLookupCacheDescriptor(
    buildLookupPlan({
      query: "Who is the CEO of Nvidia right now?",
      questionKind: "other",
      queryEnrichment: null,
    })
  );
  const second = buildLookupCacheDescriptor(
    buildLookupPlan({
      query: "Who is the CEO of Nvidia today?",
      questionKind: "other",
      queryEnrichment: null,
    })
  );

  assert.equal(first.cacheable, true);
  assert.equal(first.key, second.key);
  assert.equal(first.keyParts.query, "other the ceo of nvidia");
});

test("strong answered lookups keep the full question-kind TTL", () => {
  const policy = determineLookupCacheWritePolicy({
    lookupPlan: buildLookupPlan({ questionKind: "market_price" }),
    evidence: {
      evidenceStatus: "strong",
      supportsDirectAnswer: true,
    },
    extraction: {
      retrievalStatus: "results_found",
      answerExtractability: "direct_answer",
    },
    answerStatus: "answered",
  });

  assert.equal(policy.cacheable, true);
  assert.equal(policy.tier, "strong");
  assert.equal(policy.ttlMs, 2 * 60 * 1000);
});

test("needs clarification results are not cached", () => {
  const policy = determineLookupCacheWritePolicy({
    lookupPlan: buildLookupPlan(),
    evidence: {
      evidenceStatus: "weak",
      supportsDirectAnswer: false,
    },
    extraction: {
      retrievalStatus: "results_found",
      answerExtractability: "insufficient",
    },
    answerStatus: "needs_clarification",
  });

  assert.equal(policy.cacheable, false);
});

test("cache entry builder stamps expiry from write policy", () => {
  const now = new Date("2026-07-10T12:00:00.000Z");
  const entry = buildLookupCacheEntry({
    lookupPlan: buildLookupPlan({ questionKind: "news" }),
    artifacts: {
      rawText: "OpenAI announced a new release.",
      citations: [{ title: "Example", url: "https://example.com" }],
      webSearches: [{ id: "s1", query: "OpenAI release", sources: [] }],
      usage: { total_tokens: 12 },
    },
    evidence: {
      evidenceStatus: "strong",
      supportsDirectAnswer: true,
      confidence: 0.9,
    },
    extraction: {
      retrievalStatus: "results_found",
      answerExtractability: "summary_answer",
      resultTopicMatch: "high",
    },
    answerStatus: "answered",
    now,
  });

  assert.ok(entry);
  assert.equal(entry.created_at, "2026-07-10T12:00:00.000Z");
  assert.equal(entry.expires_at, "2026-07-10T12:05:00.000Z");
});
