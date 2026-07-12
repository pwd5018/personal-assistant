import { createHash } from "node:crypto";

const TTL_BY_QUESTION_KIND_MS = {
  weather: 15 * 60 * 1000,
  market_price: 2 * 60 * 1000,
  hours: 6 * 60 * 60 * 1000,
  news: 5 * 60 * 1000,
  sports: 10 * 60 * 1000,
  other: 30 * 60 * 1000,
  general_chat: 0,
};

const WEAK_RESULT_TTL_MS = 2 * 60 * 1000;
const UNCERTAIN_RESULT_TTL_MS = 60 * 1000;

export function buildLookupCacheDescriptor(lookupPlan) {
  const normalizedQuery = normalizeLookupQueryForCache(lookupPlan?.query || "", lookupPlan?.questionKind || "other");
  if (!normalizedQuery) {
    return {
      cacheable: false,
      reason: "empty_query",
      key: "",
      keyParts: null,
      ttlMs: 0,
    };
  }

  const questionKind = normalizeLookupQuestionKind(lookupPlan?.questionKind);
  if (questionKind === "general_chat") {
    return {
      cacheable: false,
      reason: "general_chat",
      key: "",
      keyParts: null,
      ttlMs: 0,
    };
  }

  const keyParts = {
    questionKind,
    privacyMode: normalizeKeyPart(lookupPlan?.privacyMode || "strict"),
    answerMode: normalizeKeyPart(lookupPlan?.answerMode || "lookup_or_model"),
    resolutionStatus: normalizeKeyPart(lookupPlan?.resolutionStatus || "unresolved"),
    contextMode: normalizeKeyPart(lookupPlan?.contextMode || "question_only"),
    query: normalizedQuery,
    entity: normalizeKeyPart(lookupPlan?.queryEnrichment?.entity || ""),
    location: normalizeKeyPart(lookupPlan?.queryEnrichment?.location || ""),
  };

  const key = createHash("sha256")
    .update(JSON.stringify(keyParts))
    .digest("hex");

  return {
    cacheable: true,
    reason: "lookup_query",
    key,
    keyParts,
    ttlMs: getBaseLookupCacheTtlMs(questionKind),
  };
}

export function determineLookupCacheWritePolicy({
  lookupPlan,
  evidence,
  extraction,
  answerStatus,
}) {
  const descriptor = buildLookupCacheDescriptor(lookupPlan);
  if (!descriptor.cacheable) {
    return {
      cacheable: false,
      reason: descriptor.reason,
      ttlMs: 0,
      tier: "none",
    };
  }

  const evidenceStatus = normalizeKeyPart(evidence?.evidenceStatus || "missing");
  const retrievalStatus = normalizeKeyPart(extraction?.retrievalStatus || "no_results");
  const answerExtractability = normalizeKeyPart(extraction?.answerExtractability || "insufficient");
  const normalizedAnswerStatus = normalizeKeyPart(answerStatus || "partial");
  const baseTtlMs = descriptor.ttlMs;

  if (normalizedAnswerStatus === "needs_clarification") {
    return {
      cacheable: false,
      reason: "needs_clarification",
      ttlMs: 0,
      tier: "none",
    };
  }

  if (evidenceStatus === "missing" || evidenceStatus === "mismatched") {
    return {
      cacheable: false,
      reason: `evidence_${evidenceStatus}`,
      ttlMs: 0,
      tier: "none",
    };
  }

  if (retrievalStatus !== "results_found") {
    return {
      cacheable: false,
      reason: "no_results",
      ttlMs: 0,
      tier: "none",
    };
  }

  if (
    normalizedAnswerStatus === "answered" &&
    ["direct_answer", "summary_answer"].includes(answerExtractability) &&
    evidence?.supportsDirectAnswer
  ) {
    return {
      cacheable: true,
      reason: "strong_answer",
      ttlMs: baseTtlMs,
      tier: "strong",
    };
  }

  if (normalizedAnswerStatus === "uncertain") {
    return {
      cacheable: true,
      reason: "uncertain_answer",
      ttlMs: Math.min(baseTtlMs, UNCERTAIN_RESULT_TTL_MS),
      tier: "uncertain",
    };
  }

  return {
    cacheable: true,
    reason: "weak_answer",
    ttlMs: Math.min(baseTtlMs, WEAK_RESULT_TTL_MS),
    tier: "weak",
  };
}

export function isLookupCacheEntryExpired(entry, now = Date.now()) {
  const expiresAt = Date.parse(entry?.expires_at || entry?.expiresAt || "");
  if (!Number.isFinite(expiresAt)) {
    return true;
  }

  return expiresAt <= now;
}

export function getLookupCacheAgeMs(entry, now = Date.now()) {
  const createdAt = Date.parse(entry?.created_at || entry?.createdAt || "");
  if (!Number.isFinite(createdAt)) {
    return null;
  }

  return Math.max(0, now - createdAt);
}

export function buildLookupCacheEntry({
  lookupPlan,
  artifacts,
  evidence,
  extraction,
  answerStatus,
  now = new Date(),
}) {
  const descriptor = buildLookupCacheDescriptor(lookupPlan);
  const writePolicy = determineLookupCacheWritePolicy({
    lookupPlan,
    evidence,
    extraction,
    answerStatus,
  });

  if (!descriptor.cacheable || !writePolicy.cacheable) {
    return null;
  }

  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + writePolicy.ttlMs).toISOString();

  return {
    cache_key: descriptor.key,
    question_kind: normalizeLookupQuestionKind(lookupPlan?.questionKind),
    privacy_mode: String(lookupPlan?.privacyMode || "strict"),
    answer_mode: String(lookupPlan?.answerMode || "lookup_or_model"),
    resolution_status: String(lookupPlan?.resolutionStatus || "unresolved"),
    retrieval_json: JSON.stringify({
      rawText: artifacts?.rawText || "",
    }),
    evidence_json: JSON.stringify(evidence || {}),
    extraction_json: JSON.stringify(extraction || {}),
    citations_json: JSON.stringify(artifacts?.citations || []),
    web_searches_json: JSON.stringify(artifacts?.webSearches || []),
    usage_json: artifacts?.usage ? JSON.stringify(artifacts.usage) : null,
    created_at: createdAt,
    expires_at: expiresAt,
    last_used_at: createdAt,
    hit_count: 0,
    cache_policy: writePolicy,
    cache_descriptor: descriptor,
  };
}

function getBaseLookupCacheTtlMs(questionKind) {
  return TTL_BY_QUESTION_KIND_MS[questionKind] ?? TTL_BY_QUESTION_KIND_MS.other;
}

function normalizeKeyPart(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeLookupQueryForCache(query, questionKind) {
  const normalizedQuestionKind = normalizeLookupQuestionKind(questionKind);
  const normalizedQuery = normalizeKeyPart(query)
    .replace(/[?.,!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (normalizedQuestionKind === "market_price") {
    const subject = normalizedQuery
      .replace(/\//g, " ")
      .replace(/\b([a-z0-9]+)'s\b/g, "$1")
      .replace(/'/g, "")
      .replace(/\b(?:what|whats|what s|what is)\s+(?:the\s+)?/g, " ")
      .replace(/\b(what|whats|what s|what is|is|the|tell me|show me|give me|current|currently|right now|today|stock price|stock|share price|share|shares|price|quote|trading at|at|exchange rate|rate|from|to)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return subject ? `market_price ${subject}` : "market_price";
  }

  if (normalizedQuestionKind === "sports") {
    const subject = normalizedQuery
      .replace(/\b(whats|what is|tell me|show me|give me|latest|current|currently|right now|today|tonight|live|score|scores|record|schedule|standings)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return subject ? `sports ${subject}` : "sports";
  }

  if (normalizedQuestionKind === "other") {
    const subject = normalizedQuery
      .replace(/\b([a-z0-9]+)'s\b/g, "$1")
      .replace(/'/g, "")
      .replace(/\b(who|what|when|where|why|how)\s+(is|are|was|were|does|do|did|can|could|would|will)\b/g, " ")
      .replace(/\b(tell me|show me|give me|latest|current|currently|right now|today|tonight|this week|this month|for me|please)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return subject ? `other ${subject}` : "other";
  }

  return normalizedQuery;
}

function normalizeLookupQuestionKind(value) {
  const normalized = normalizeKeyPart(value).replace(/\s+/g, "_");
  return ["weather", "market_price", "hours", "news", "sports", "general_chat", "other"].includes(normalized)
    ? normalized
    : "other";
}
