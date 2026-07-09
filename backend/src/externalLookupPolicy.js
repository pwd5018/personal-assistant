const FALLBACK_LOOKUP_SIGNALS = [
  {
    label: "time_sensitive",
    pattern: /\b(latest|current|today|tonight|this week|this month|right now|recent|recently|breaking)\b/i,
  },
  {
    label: "weather",
    pattern: /\b(weather|forecast|temperature|rain|snow|wind)\b/i,
  },
  {
    label: "news",
    pattern: /\b(news|headline|headlines)\b/i,
  },
  {
    label: "markets",
    pattern: /\b(stock|price|market cap|earnings|exchange rate)\b/i,
  },
  {
    label: "sports",
    pattern: /\b(score|scores|schedule|standings|record)\b/i,
  },
  {
    label: "hours_or_availability",
    pattern: /\b(open now|hours|closing time|release date|shipping date)\b/i,
  },
];

const ALLOWED_QUESTION_KINDS = new Set([
  "weather",
  "market_price",
  "hours",
  "news",
  "sports",
  "general_chat",
  "other",
]);

const SENSITIVE_PATTERNS = [
  {
    label: "email",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: "[redacted-email]",
  },
  {
    label: "phone",
    pattern: /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
    replacement: "[redacted-phone]",
  },
  {
    label: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: "[redacted-ssn]",
  },
  {
    label: "credit_card",
    pattern: /\b(?:\d[ -]*?){13,16}\b/g,
    replacement: "[redacted-card]",
  },
  {
    label: "date_of_birth",
    pattern: /\b(?:dob|date of birth)\s*[:\-]?\s*\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/gi,
    replacement: "[redacted-dob]",
  },
  {
    label: "api_key",
    pattern: /\b(?:sk|rk|pk)_[A-Za-z0-9_-]{16,}\b/g,
    replacement: "[redacted-key]",
  },
  {
    label: "bearer_token",
    pattern: /\bbearer\s+[A-Za-z0-9._-]{16,}\b/gi,
    replacement: "Bearer [redacted-token]",
  },
];

export function fallbackExternalLookupDecision(question) {
  const normalized = String(question || "").trim();
  if (!normalized) {
    return {
      needed: false,
      reason: "empty_question",
      matchedSignals: [],
      decisionSource: "fallback",
      confidence: 1,
    };
  }

  const matchedSignals = FALLBACK_LOOKUP_SIGNALS
    .filter((rule) => rule.pattern.test(normalized))
    .map((rule) => rule.label);
  const questionKind = inferFallbackQuestionKind(normalized, matchedSignals);

  return {
    needed: matchedSignals.length > 0,
    reason: matchedSignals.length > 0 ? "current_or_source_sensitive_question" : "model_only_is_probably_enough",
    matchedSignals,
    questionKind,
    answerMode: questionKind === "general_chat" ? "model_only" : "lookup_or_model",
    needsResolution: questionKind === "weather" || questionKind === "hours",
    canUseLocalMemoryForResolution: matchedSignals.length > 0,
    decisionSource: "fallback",
    confidence: matchedSignals.length > 0 ? 0.7 : 0.6,
  };
}

export function normalizeLookupDecision(rawDecision, fallbackDecision) {
  const fallback = fallbackDecision || fallbackExternalLookupDecision("");
  if (!rawDecision || typeof rawDecision !== "object") {
    return fallback;
  }

  const matchedSignals = Array.isArray(rawDecision.matchedSignals)
    ? [...new Set(
        rawDecision.matchedSignals
          .map((signal) => String(signal || "").trim())
          .filter(Boolean)
      )]
    : [];

  const needed = typeof rawDecision.needed === "boolean" ? rawDecision.needed : fallback.needed;
  const reason = normalizeLookupReason(rawDecision.reason, needed ? fallback.reason : "model_only_is_probably_enough");
  const decisionSource =
    rawDecision.decisionSource === "model" || rawDecision.decisionSource === "fallback"
      ? rawDecision.decisionSource
      : fallback.decisionSource;
  const confidence = normalizeConfidence(rawDecision.confidence, fallback.confidence);
  const questionKind = normalizeQuestionKind(rawDecision.questionKind, fallback.questionKind);
  const answerMode = normalizeAnswerMode(rawDecision.answerMode, fallback.answerMode);
  const needsResolution =
    typeof rawDecision.needsResolution === "boolean"
      ? rawDecision.needsResolution
      : fallback.needsResolution;
  const canUseLocalMemoryForResolution =
    typeof rawDecision.canUseLocalMemoryForResolution === "boolean"
      ? rawDecision.canUseLocalMemoryForResolution
      : fallback.canUseLocalMemoryForResolution;

  return {
    needed,
    reason,
    matchedSignals,
    questionKind,
    answerMode,
    needsResolution,
    canUseLocalMemoryForResolution,
    decisionSource,
    confidence,
  };
}

export function redactSensitiveText(text) {
  let redactedText = String(text || "");
  const matches = [];

  for (const rule of SENSITIVE_PATTERNS) {
    let matchCount = 0;
    redactedText = redactedText.replace(rule.pattern, () => {
      matchCount += 1;
      return rule.replacement;
    });

    if (matchCount > 0) {
      matches.push({
        label: rule.label,
        count: matchCount,
      });
    }
  }

  return {
    text: redactedText.trim(),
    redactions: matches,
  };
}

export function buildSafeLookupQuery(question, privacyMode = "strict", lookupDecision = null) {
  const normalizedQuestion = String(question || "").trim();
  const normalizedDecision = normalizeLookupDecision(
    lookupDecision,
    fallbackExternalLookupDecision(normalizedQuestion)
  );
  const redactionResult = redactSensitiveText(normalizedQuestion);
  const normalizedMode = privacyMode === "balanced" ? "balanced" : "strict";

  return {
    lookupNeeded: normalizedDecision.needed,
    reason: normalizedDecision.reason,
    matchedSignals: normalizedDecision.matchedSignals,
    questionKind: normalizedDecision.questionKind,
    answerMode: normalizedDecision.answerMode,
    needsResolution: normalizedDecision.needsResolution,
    canUseLocalMemoryForResolution: normalizedDecision.canUseLocalMemoryForResolution,
    decisionSource: normalizedDecision.decisionSource,
    decisionConfidence: normalizedDecision.confidence,
    privacyMode: normalizedMode,
    includedContext: {
      approvedFacts: false,
      rollingSummary: false,
      recentTurns: false,
    },
    originalQuestion: normalizedQuestion,
    safeQuery: redactionResult.text,
    redactions: redactionResult.redactions,
  };
}

function normalizeLookupReason(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  return normalized || fallback;
}

function normalizeConfidence(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(0, Math.min(1, numeric));
}

function normalizeQuestionKind(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  return ALLOWED_QUESTION_KINDS.has(normalized) ? normalized : fallback;
}

function normalizeAnswerMode(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  return ["model_only", "lookup_or_model", "lookup_required"].includes(normalized) ? normalized : fallback;
}

function inferFallbackQuestionKind(question, matchedSignals) {
  const normalizedQuestion = String(question || "").toLowerCase();
  if (/\b(hi|hello|hey|how are you|thanks|thank you)\b/.test(normalizedQuestion)) {
    return "general_chat";
  }

  if (matchedSignals.includes("weather")) {
    return "weather";
  }

  if (matchedSignals.includes("markets")) {
    return "market_price";
  }

  if (matchedSignals.includes("hours_or_availability")) {
    return "hours";
  }

  if (matchedSignals.includes("sports")) {
    return "sports";
  }

  if (matchedSignals.includes("news")) {
    return "news";
  }

  return matchedSignals.length ? "other" : "general_chat";
}
