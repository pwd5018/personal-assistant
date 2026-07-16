import { config } from "./config.js";
import {
  buildSafeLookupQuery,
  fallbackExternalLookupDecision,
  normalizeLookupDecision,
} from "./externalLookupPolicy.js";
import { provider } from "./provider/index.js";

const BALANCED_LOOKUP_ALLOWED_FACT_CATEGORIES = new Set([
  "user_identity",
  "user_preference",
  "relationship_context",
]);
const MIN_RESOLUTION_CONFIDENCE = 0.65;

export async function buildExternalLookupPlan(question, contextPackage, privacyModeOverride = null, routing = null) {
  const resolvedPrivacyMode =
    privacyModeOverride === "balanced" || privacyModeOverride === "strict"
      ? privacyModeOverride
      : config.externalLookupPrivacyMode;
  const lookupDecision = await decideExternalLookupNeed(question, contextPackage, routing);
  const preview = buildSafeLookupQuery(question, resolvedPrivacyMode, lookupDecision);
  const enabled = config.externalLookupEnabled;
  const providerReady = provider.isConfigured();
  const contextDetails = buildLookupContext(contextPackage, preview.privacyMode, lookupDecision);
  const queryDetails = await buildLookupQueryDetails({
    originalQuestion: question,
    safeQuery: preview.safeQuery,
    contextPackage,
    lookupContext: contextDetails.lookupContext,
    lookupDecision,
    routing,
  });
  const shouldLookup =
    enabled &&
    providerReady &&
    preview.lookupNeeded &&
    preview.answerMode !== "model_only";
  const effectiveNeedsResolution =
    preview.needsResolution || queryDetails.resolutionStatus === "resolved" || queryDetails.resolutionStatus === "ambiguous";

  return {
    enabled,
    providerReady,
    needed: preview.lookupNeeded,
    shouldLookup,
    requestedPrivacyMode: privacyModeOverride || config.externalLookupPrivacyMode,
    privacyMode: preview.privacyMode,
    query: queryDetails.query,
    queryEnrichment: queryDetails.queryEnrichment,
    resolutionStatus: queryDetails.resolutionStatus,
    resolutionConfidence: queryDetails.resolutionConfidence,
    reason: preview.reason,
    matchedSignals: preview.matchedSignals,
    questionKind: preview.questionKind,
    answerMode: preview.answerMode,
    needsResolution: effectiveNeedsResolution,
    canUseLocalMemoryForResolution: preview.canUseLocalMemoryForResolution,
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
      resolutionStatus: queryDetails.resolutionStatus,
      resolutionConfidence: queryDetails.resolutionConfidence,
      needsResolution: effectiveNeedsResolution,
      requestedPrivacyMode: privacyModeOverride || config.externalLookupPrivacyMode,
      includedContext: contextDetails.includedContext,
      contextMode: contextDetails.contextMode,
    },
  };
}

export async function performExternalLookup({ question, lookupPlan, signal, routing }) {
  return provider.answerWithExternalLookup({
    question,
    lookupPlan,
    signal,
    model: routing?.["lookup.retrieval"]?.model,
  });
}

export async function performExternalLookupRetrieval({ question, lookupPlan, signal, routing }) {
  return provider.fetchExternalLookupArtifacts({
    question,
    lookupPlan,
    signal,
    model: routing?.["lookup.retrieval"]?.model,
  });
}

export async function composeExternalLookupResult({ question, lookupPlan, artifacts, routing }) {
  return provider.composeExternalLookupResult({
    question,
    lookupPlan,
    ...artifacts,
    model: routing?.["lookup.composition"]?.model,
  });
}

function buildLookupContext(contextPackage, privacyMode, lookupDecision) {
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

  const shouldUseLocalHints = Boolean(
    lookupDecision?.canUseLocalMemoryForResolution || lookupDecision?.needsResolution
  );
  const approvedFactCandidates = shouldUseLocalHints
    ? filterAllowedApprovedFacts(
        contextPackage.approvedFactRecords || contextPackage.approvedFacts || []
      ).slice(0, 3)
    : [];
  const approvedFacts = approvedFactCandidates.map((fact) => fact.fact_text);
  const approvedFactCategories = [...new Set(
    approvedFactCandidates
      .map((fact) => fact.category)
      .filter(Boolean)
  )];
  const recentTurns = shouldUseLocalHints
    ? (contextPackage.recentTurns || []).slice(-2).map((turn) => ({
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

async function decideExternalLookupNeed(question, contextPackage, routing) {
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
      model: routing?.["lookup.decision"]?.model,
    });
    const normalizedModelDecision = normalizeLookupDecision(
      {
        ...modelDecision,
        decisionSource: "model",
      },
      fallbackDecision
    );
    if (shouldPreferFallbackDecision(normalizedModelDecision, fallbackDecision)) {
      return fallbackDecision;
    }

    return normalizedModelDecision;
  } catch {
    return fallbackDecision;
  }
}

function shouldPreferFallbackDecision(modelDecision, fallbackDecision) {
  if (!modelDecision || !fallbackDecision) {
    return false;
  }

  const materiallyDisagrees =
    modelDecision.needed !== fallbackDecision.needed ||
    modelDecision.questionKind !== fallbackDecision.questionKind ||
    modelDecision.answerMode !== fallbackDecision.answerMode;
  if (!materiallyDisagrees) {
    return false;
  }

  const confidence =
    typeof modelDecision.confidence === "number" ? modelDecision.confidence : null;
  return confidence === null || confidence < 0.35;
}

async function buildLookupQueryDetails({
  originalQuestion,
  safeQuery,
  contextPackage,
  lookupContext,
  lookupDecision,
  routing,
}) {
  const baseQuery = String(safeQuery || "").trim();
  if (!baseQuery) {
    return {
      query: "",
      queryEnrichment: null,
      resolutionStatus: "unresolved",
      resolutionConfidence: null,
    };
  }

  const locationHint = await resolveLocationHint({
    originalQuestion,
    contextPackage,
    lookupContext,
    lookupDecision,
    routing,
  });
  if (!locationHint) {
    return {
      query: baseQuery,
      queryEnrichment: null,
      resolutionStatus: shouldTreatQuestionAsAmbiguousLocalReference(originalQuestion, lookupDecision)
        ? "ambiguous"
        : "unresolved",
      resolutionConfidence: null,
    };
  }

  const normalizedResolution = normalizeResolutionHint(locationHint);
  const normalizedLocation = String(normalizedResolution.location || "").trim();
  if (!normalizedLocation) {
    return {
      query: baseQuery,
      queryEnrichment: null,
      resolutionStatus: normalizedResolution.status,
      resolutionConfidence: normalizedResolution.confidence,
    };
  }

  if (normalizedResolution.status !== "resolved") {
    return {
      query: baseQuery,
      queryEnrichment: null,
      resolutionStatus: normalizedResolution.status,
      resolutionConfidence: normalizedResolution.confidence,
    };
  }

  if (baseQuery.toLowerCase().includes(normalizedLocation.toLowerCase())) {
    return {
      query: baseQuery,
      queryEnrichment: {
        source: normalizedResolution.source,
        entity: normalizedResolution.entity,
        location: normalizedLocation,
        confidence: normalizedResolution.confidence,
      },
      resolutionStatus: normalizedResolution.status,
      resolutionConfidence: normalizedResolution.confidence,
    };
  }

  return {
    query: `${baseQuery} in ${normalizedLocation}`.replace(/\s+/g, " ").trim(),
    queryEnrichment: {
      source: normalizedResolution.source,
      entity: normalizedResolution.entity,
      location: normalizedLocation,
      confidence: normalizedResolution.confidence,
    },
    resolutionStatus: normalizedResolution.status,
    resolutionConfidence: normalizedResolution.confidence,
  };
}

async function resolveLocationHint({
  originalQuestion,
  contextPackage,
  lookupContext,
  lookupDecision,
  routing,
}) {
  const normalizedQuestion = String(originalQuestion || "").trim();
  if (!normalizedQuestion) {
    return null;
  }

  const candidates = [
    ...(lookupContext?.approvedFacts || []).map((fact) => parseLocationFact(fact, "balanced_approved_fact")),
  ].filter(Boolean);

  const recentTurnMatches = (lookupContext?.recentTurns || [])
    .slice()
    .reverse()
    .map((turn) => parseLocationTurn(turn))
    .filter(Boolean);
  candidates.push(...recentTurnMatches);
  const uniqueCandidates = dedupeLocationCandidates(candidates);

  const heuristicMatch = findBestLocationCandidate(normalizedQuestion, uniqueCandidates);
  if (shouldTreatQuestionAsAmbiguousLocalReference(normalizedQuestion, lookupDecision, heuristicMatch)) {
    return null;
  }

  const defaultMatch = findDefaultLocationCandidate(
    uniqueCandidates,
    lookupDecision,
    heuristicMatch,
    normalizedQuestion
  );
  if (!provider.isConfigured() || !lookupDecision?.canUseLocalMemoryForResolution) {
    return heuristicMatch || defaultMatch;
  }

  try {
    const modelMatch = await provider.resolveLookupEntity({
      question: normalizedQuestion,
      questionKind: lookupDecision?.questionKind || "other",
      candidates: uniqueCandidates,
      model: routing?.["lookup.decision"]?.model,
    });
    return selectResolvedLocation(modelMatch, uniqueCandidates) || heuristicMatch || defaultMatch;
  } catch {
    return heuristicMatch || defaultMatch;
  }
}

function dedupeLocationCandidates(candidates) {
  const byKey = new Map();

  for (const candidate of candidates || []) {
    const entity = String(candidate?.entity || "").trim();
    const location = String(candidate?.location || "").trim();
    if (!entity || !location) {
      continue;
    }

    const key = `${normalizeEntity(entity)}::${location.toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing || getLocationSourcePriority(candidate.source) > getLocationSourcePriority(existing.source)) {
      byKey.set(key, candidate);
    }
  }

  return [...byKey.values()];
}

function getLocationSourcePriority(source = "") {
  if (/balanced_approved_fact/.test(source)) {
    return 4;
  }

  if (/approved_fact/.test(source)) {
    return 3;
  }

  if (/recent_turn/.test(source)) {
    return 2;
  }

  return 1;
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
  if (!userText || !assistantText || !isEntityLikeText(userText)) {
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

function findBestLocationCandidate(question, candidates) {
  for (const match of candidates) {
    if (questionMentionsEntity(question, match.entity)) {
      return match;
    }
  }

  return null;
}

function findDefaultLocationCandidate(candidates, lookupDecision, explicitMatch, question = "") {
  if (explicitMatch) {
    return null;
  }

  if (!lookupDecision?.canUseLocalMemoryForResolution) {
    return null;
  }

  if (!["weather", "hours"].includes(lookupDecision?.questionKind || "")) {
    return null;
  }

  if (shouldTreatQuestionAsAmbiguousLocalReference(question, lookupDecision, explicitMatch)) {
    return null;
  }

  const approvedCandidates = (candidates || []).filter((candidate) =>
    /approved_fact/.test(candidate?.source || "")
  );
  if (approvedCandidates.length !== 1) {
    return null;
  }

  return {
    ...approvedCandidates[0],
    confidence: approvedCandidates[0].confidence ?? 0.72,
    source: `${approvedCandidates[0].source}_default_local_hint`,
  };
}

function selectResolvedLocation(modelMatch, candidates) {
  if (!modelMatch || !Array.isArray(candidates) || !candidates.length) {
    return null;
  }

  if (typeof modelMatch.candidateIndex === "number") {
    const indexed = candidates[modelMatch.candidateIndex];
    if (indexed && isEntityLikeText(indexed.entity)) {
      return {
        ...indexed,
        confidence: modelMatch.confidence ?? null,
        source: `${indexed.source}_model_resolved`,
      };
    }
  }

  if (modelMatch.entity) {
    const normalizedEntity = normalizeEntity(modelMatch.entity);
    const matched = candidates.find(
      (candidate) => isEntityLikeText(candidate.entity) && normalizeEntity(candidate.entity) === normalizedEntity
    );
    if (matched) {
      return {
        ...matched,
        confidence: modelMatch.confidence ?? null,
        source: `${matched.source}_model_resolved`,
      };
    }
  }

  return null;
}

function isEntityLikeText(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return false;
  }

  if (/[?]/.test(normalized)) {
    return false;
  }

  if (normalized.split(/\s+/).length > 8) {
    return false;
  }

  if (/^(what|what's|whats|where|when|why|how|is|are|do|does|can|could|would|should|tell|check)\b/i.test(normalized)) {
    return false;
  }

  return /[A-Za-z]/.test(normalized);
}

function normalizeResolutionHint(locationHint) {
  if (!locationHint) {
    return {
      status: "unresolved",
      confidence: null,
      source: null,
      entity: "",
      location: "",
    };
  }

  const confidence = normalizeResolutionConfidence(locationHint.confidence, locationHint.source);
  const status =
    confidence == null ? "resolved" : confidence >= MIN_RESOLUTION_CONFIDENCE ? "resolved" : "ambiguous";

  return {
    ...locationHint,
    status,
    confidence,
  };
}

function normalizeResolutionConfidence(value, source = "") {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.max(0, Math.min(1, numeric));
  }

  if (/approved_fact/.test(source)) {
    return 0.85;
  }

  if (/recent_turn/.test(source)) {
    return 0.55;
  }

  return null;
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

function shouldTreatQuestionAsAmbiguousLocalReference(question, lookupDecision, explicitMatch = null) {
  if (explicitMatch) {
    return false;
  }

  if (!["weather", "hours"].includes(lookupDecision?.questionKind || "")) {
    return false;
  }

  const normalizedQuestion = String(question || "").trim().toLowerCase();
  if (!normalizedQuestion) {
    return false;
  }

  if (/\b(near me|nearby|around here|close by|local)\b/.test(normalizedQuestion)) {
    return true;
  }

  return /\b(golf course|golf club|that course|that club|that place)\b/.test(normalizedQuestion);
}
