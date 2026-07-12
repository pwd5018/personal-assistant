import test from "node:test";
import assert from "node:assert/strict";

import { fallbackExternalLookupDecision } from "../src/externalLookupPolicy.js";

test("road closure questions are not classified as business-hours lookups", () => {
  const decision = fallbackExternalLookupDecision("Is Route 90 closed near Erie right now?");

  assert.equal(decision.needed, true);
  assert.equal(decision.questionKind, "other");
});

test("closed-today business questions still classify as hours lookups", () => {
  const decision = fallbackExternalLookupDecision("Is the DMV closed today?");

  assert.equal(decision.needed, true);
  assert.equal(decision.questionKind, "hours");
});

test("what-time-close questions classify as hours lookups", () => {
  const decision = fallbackExternalLookupDecision("What time does the DMV close today?");

  assert.equal(decision.needed, true);
  assert.equal(decision.questionKind, "hours");
});

test("reference fact questions like population trigger lookup", () => {
  const decision = fallbackExternalLookupDecision("What's the population of Tokyo?");

  assert.equal(decision.needed, true);
  assert.equal(decision.questionKind, "other");
});

test("astronomy fact questions like full moon trigger lookup", () => {
  const decision = fallbackExternalLookupDecision("Is there a full moon tonight in New York City?");

  assert.equal(decision.needed, true);
  assert.equal(decision.questionKind, "other");
});
