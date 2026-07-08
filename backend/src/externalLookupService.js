import { config } from "./config.js";
import {
  buildSafeLookupQuery,
  fallbackExternalLookupDecision,
  normalizeLookupDecision,
} from "./externalLookupPolicy.js";
import { provider } from "./provider/index.js";

const CONTEXT_DEPENDENT_PATTERNS = [
  /\b(my|our|we|us|me)\b/i,
  /\bnear me\b/i,
  /\baround here\b/i,
  /\bfor me\b/i,
  /\bwith my\b/i,
  /\bthat\b/i,
  /\bearlier\b/i,
  /\blast time\b/i,
];

const BALANCED_LOOKUP_ALLOWED_FACT_CATEGORIES = new Set([
  "user_identity",
  "user_preference",
  "relationship_context",
]);

export async function buildExternalLookupPlan(question, contextPackage, privacyModeOverride = null) {
  const resolvedPrivacyMode =
    privacyModeOverride === "balanced" || privacyModeOverride === "strict"
      ? privacyModeOverride
      : config.externalLookupPrivacyMode;
  const lookupDecision = await decideExternalLookupNeed(question, contextPackage);
  const preview = buildSafeLookupQuery(question, resolvedPrivacyMode, lookupDecision);
  const enabled = config.externalLookupEnabled;
  const providerReady = provider.isConfigured();
  const contextDetails = buildLookupContext(question, contextPackage, preview.privacyMode);
  const queryDetails = buildLookupQueryDetails({
    originalQuestion: question,
    safeQuery: preview.safeQuery,
    contextPackage,
    lookupContext: contextDetails.lookupContext,
  });
  const shouldLookup = enabled && providerReady && preview.lookupNeeded;

  return {
    enabled,
    providerReady,
    needed: preview.lookupNeeded,
    shouldLookup,
    requestedPrivacyMode: privacyModeOverride || config.externalLookupPrivacyMode,
    privacyMode: preview.privacyMode,
    query: queryDetails.query,
    queryEnrichment: queryDetails.queryEnrichment,
    reason: preview.reason,
    matchedSignals: preview.matchedSignals,
    decisionSource: preview.decisionSource,
    decisionConfidence: preview.decisionConfidence,
    redactions: preview.redactions,
    includedContext: contextDetails.includedContext,
    contextMode: contextDetails.contextMode,
    lookupContext: contextDetails.lookupContext,
    preview: {
      ...preview,
      safeQuery: queryDetails.query,
      queryEnrichment: queryDetails.queryEnrichment,
      requestedPrivacyMode: privacyModeOverride || config.externalLookupPrivacyMode,
      includedContext: contextDetails.includedContext,
      contextMode: contextDetails.contextMode,
    },
  };
}

export async function performExternalLookup({ question, lookupPlan, signal }) {
  return provider.answerWithExternalLookup({
    question,
    lookupPlan,
    signal,
  });
}

function buildLookupContext(question, contextPackage, privacyMode) {
  if (privacyMode !== "balanced") {
    return {
      contextMode: "question_only",
      includedContext: {
        approvedFacts: false,
        approvedFactCategories: [],
        rollingSummary: false,
        recentTurns: false,
      },
      lookupContext: {
        approvedFacts: [],
        approvedFactCategories: [],
        rollingSummary: "",
        recentTurns: [],
      },
    };
  }

  const needsConversationContext = CONTEXT_DEPENDENT_PATTERNS.some((pattern) => pattern.test(question));
  const approvedFactCandidates = needsConversationContext
    ? filterAllowedApprovedFacts(
        contextPackage.approvedFactRecords || contextPackage.approvedFacts || []
      ).slice(0, 2)
    : [];
  const approvedFacts = approvedFactCandidates.map((fact) => fact.fact_text);
  const approvedFactCategories = [...new Set(
    approvedFactCandidates
      .map((fact) => fact.category)
      .filter(Boolean)
  )];
  const recentTurns = needsConversationContext
    ? (contextPackage.recentTurns || []).slice(-1).map((turn) => ({
        user: turn.user || "",
        assistant: turn.assistant || "",
      }))
    : [];

  return {
    contextMode:
      approvedFacts.length || recentTurns.length ? "balanced_with_local_hints" : "question_only",
    includedContext: {
      approvedFacts: approvedFacts.length > 0,
      approvedFactCategories,
      rollingSummary: false,
      recentTurns: recentTurns.length > 0,
    },
    lookupContext: {
      approvedFacts,
      approvedFactCategories,
      rollingSummary: "",
      recentTurns,
    },
  };
}

function filterAllowedApprovedFacts(approvedFacts) {
  return approvedFacts.filter((fact) => BALANCED_LOOKUP_ALLOWED_FACT_CATEGORIES.has(fact?.category || ""));
}

async function decideExternalLookupNeed(question, contextPackage) {
  const fallbackDecision = fallbackExternalLookupDecision(question);
  if (!String(question || "").trim()) {
    return fallbackDecision;
  }

  if (!provider.isConfigured()) {
    return fallbackDecision;
  }

  try {
    const modelDecision = await provider.classifyExternalLookupNeed({
      question,
      recentTurns: (contextPackage?.recentTurns || []).slice(-2),
    });
    return normalizeLookupDecision(
      {
        ...modelDecision,
        decisionSource: "model",
      },
      fallbackDecision
    );
  } catch {
    return fallbackDecision;
  }
}

function buildLookupQueryDetails({ originalQuestion, safeQuery, contextPackage, lookupContext }) {
  const baseQuery = String(safeQuery || "").trim();
  if (!baseQuery) {
    return {
      query: "",
      queryEnrichment: null,
    };
  }

  const locationHint = findLocationHintForQuestion(originalQuestion, contextPackage, lookupContext);
  if (!locationHint) {
    return {
      query: baseQuery,
      queryEnrichment: null,
    };
  }

  const normalizedLocation = String(locationHint.location || "").trim();
  if (!normalizedLocation) {
    return {
      query: baseQuery,
      queryEnrichment: null,
    };
  }

  if (baseQuery.toLowerCase().includes(normalizedLocation.toLowerCase())) {
    return {
      query: baseQuery,
      queryEnrichment: {
        source: locationHint.source,
        entity: locationHint.entity,
        location: normalizedLocation,
      },
    };
  }

  return {
    query: `${baseQuery} in ${normalizedLocation}`.replace(/\s+/g, " ").trim(),
    queryEnrichment: {
      source: locationHint.source,
      entity: locationHint.entity,
      location: normalizedLocation,
    },
  };
}

function findLocationHintForQuestion(originalQuestion, contextPackage, lookupContext) {
  const normalizedQuestion = String(originalQuestion || "").trim();
  if (!normalizedQuestion) {
    return null;
  }

  const approvedFactMatches = [
    ...(lookupContext?.approvedFacts || []).map((fact) => parseLocationFact(fact, "balanced_approved_fact")),
    ...((contextPackage?.approvedFacts || []).map((fact) => parseLocationFact(fact, "approved_fact"))),
  ].filter(Boolean);

  for (const match of approvedFactMatches) {
    if (questionMentionsEntity(normalizedQuestion, match.entity)) {
      return match;
    }
  }

  const recentTurnMatches = (contextPackage?.recentTurns || [])
    .slice()
    .reverse()
    .map((turn) => parseLocationTurn(turn))
    .filter(Boolean);

  for (const match of recentTurnMatches) {
    if (questionMentionsEntity(normalizedQuestion, match.entity)) {
      return match;
    }
  }

  return null;
}

function parseLocationFact(factText, source) {
  const match = String(factText || "").match(/^(.+?)\s+is located in\s+(.+?)\.?$/i);
  if (!match) {
    return null;
  }

  return {
    entity: String(match[1] || "").trim(),
    location: String(match[2] || "").trim(),
    source,
  };
}

function parseLocationTurn(turn) {
  const userText = String(turn?.user || "").trim();
  const assistantText = String(turn?.assistant || "").trim();
  if (!userText || !assistantText) {
    return null;
  }

  const locationMatch = assistantText.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]{2})\b/);
  if (!locationMatch) {
    return null;
  }

  return {
    entity: userText,
    location: locationMatch[1],
    source: "recent_turn",
  };
}

function questionMentionsEntity(question, entity) {
  const normalizedQuestion = normalizeEntity(question);
  const normalizedEntity = normalizeEntity(entity);
  if (!normalizedQuestion || !normalizedEntity) {
    return false;
  }

  return (
    normalizedQuestion.includes(normalizedEntity) ||
    normalizedEntity.includes(normalizedQuestion) ||
    normalizedQuestion.includes(removeTrailingDescriptors(normalizedEntity)) ||
    removeTrailingDescriptors(normalizedQuestion).includes(normalizedEntity)
  );
}

function removeTrailingDescriptors(value) {
  return String(value || "")
    .replace(/\b(golf course|golf club|course|club)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEntity(value) {
  return removeTrailingDescriptors(
    String(value || "")
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}
