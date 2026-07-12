import test from "node:test";
import assert from "node:assert/strict";

import { buildExternalLookupPlan } from "../src/externalLookupService.js";
import { provider } from "../src/provider/index.js";

const ORIGINAL_IS_CONFIGURED = provider.isConfigured;

test.afterEach(() => {
  provider.isConfigured = ORIGINAL_IS_CONFIGURED;
});

function buildContext() {
  return {
    approvedFacts: ["The Ridge is located in Waterford, PA."],
    approvedFactRecords: [
      {
        fact_text: "The Ridge is located in Waterford, PA.",
        category: "user_preference",
      },
    ],
    recentTurns: [],
    rollingSummary: "",
  };
}

test("balanced lookup keeps generic near-me golf-course questions ambiguous", async () => {
  provider.isConfigured = () => false;

  const plan = await buildExternalLookupPlan(
    "What's the weather at the golf course near me today?",
    buildContext(),
    "balanced"
  );

  assert.equal(plan.privacyMode, "balanced");
  assert.equal(plan.resolutionStatus, "ambiguous");
  assert.equal(plan.queryEnrichment, null);
  assert.equal(plan.query, "What's the weather at the golf course near me today?");
});

test("balanced lookup still resolves an explicitly named remembered place", async () => {
  provider.isConfigured = () => false;

  const plan = await buildExternalLookupPlan(
    "What's the weather at The Ridge today?",
    buildContext(),
    "balanced"
  );

  assert.equal(plan.privacyMode, "balanced");
  assert.equal(plan.resolutionStatus, "resolved");
  assert.equal(plan.queryEnrichment?.entity, "The Ridge");
  assert.equal(plan.queryEnrichment?.location, "Waterford, PA");
  assert.match(plan.query, /Waterford, PA/i);
});

test("strict lookup does not use remembered place hints", async () => {
  provider.isConfigured = () => false;

  const plan = await buildExternalLookupPlan(
    "What's the weather at the golf course near me today?",
    buildContext(),
    "strict"
  );

  assert.equal(plan.privacyMode, "strict");
  assert.equal(plan.resolutionStatus, "ambiguous");
  assert.equal(plan.queryEnrichment, null);
  assert.equal(plan.query, "What's the weather at the golf course near me today?");
});
