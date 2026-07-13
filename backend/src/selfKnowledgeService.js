import { config } from "./config.js";
import { store } from "./store.js";

const SELF_KNOWLEDGE_SAMPLE_QUESTIONS = [
  "How do you work?",
  "What do you store locally?",
  "What model handled my last turn?",
  "Why did you answer that way?",
  "Why didn't audio play?",
  "Help me debug the last failure.",
  "What data did you use for that turn?",
  "What was stored from that turn?",
  "Was that model-only or lookup-backed?",
  "Did approved facts affect that reply?",
];

export function buildSelfKnowledgeResponse(question, options = {}) {
  const normalizedQuestion = normalizeQuestion(question);
  const topic = classifySelfKnowledgeTopic(normalizedQuestion);
  if (!topic) {
    return null;
  }

  const selectedTurn = getSelectedExplainableTurn(options.explainTurnId);
  const selectedTurnExplanation = selectedTurn ? buildLatestTurnExplanation(selectedTurn) : null;
  const selectedTurnExplainability = selectedTurn ? buildTurnExplainability(selectedTurn) : null;
  const selectedFailureTurn = getSelectedFailureTurn(options.explainTurnId);
  const selectedFailureExplanation = selectedFailureTurn ? buildFailureDebugExplanation(selectedFailureTurn) : null;
  const overview = buildSelfKnowledgeOverview();
  const selectedTurnLabel = describeRequestedTurnLabel(options.explainTurnId, selectedTurn?.id);

  switch (topic) {
    case "architecture":
      return {
        topic,
        text: buildArchitectureAnswer(overview),
        context: {
          topic,
          sampleQuestions: overview.sampleQuestions,
          facts: [overview.architectureSummary, overview.providerSummary],
        },
        evidence: [
          "Local frontend captures audio and talks only to the local backend.",
          "The backend orchestrates transcription, replies, optional external lookup, speech synthesis, and SQLite persistence.",
          "Recent turns, approved facts, and a rolling summary can be packaged into a turn.",
        ],
        inference: [
          "The app is intentionally narrow and local-first rather than a cloud-synced assistant.",
        ],
        unknowns: [
          "I cannot expose hidden model internals beyond the stored turn metadata and configured routing.",
        ],
        latestTurnId: selectedTurn?.id || null,
      };
    case "storage":
      return {
        topic,
        text: buildStorageAnswer(overview),
        context: {
          topic,
          sampleQuestions: overview.sampleQuestions,
          facts: overview.storageFacts,
        },
        evidence: overview.storageFacts,
        inference: [
          "The current product scope is local persistence and debugging, not cross-device sync.",
        ],
        unknowns: [
          "I cannot prove what happened outside the app process, only what this code stores locally.",
        ],
        latestTurnId: selectedTurn?.id || null,
      };
    case "provider_path":
      return {
        topic,
        text: selectedTurnExplanation
          ? `${selectedTurnLabel}${selectedTurnExplanation.providerAnswer}`
          : "I do not have a previous completed turn yet, so I cannot name a provider or model path.",
        context: {
          topic,
          sampleQuestions: overview.sampleQuestions,
          latestTurnId: selectedTurn?.id || null,
          latestTurnProvider: selectedTurnExplanation?.providerPath || null,
        },
        evidence: selectedTurnExplanation?.evidence || ["No previous completed turn is available yet."],
        inference: selectedTurnExplanation?.inference || [],
        unknowns: selectedTurnExplanation?.unknowns || [
          "Without a stored turn, I cannot confirm a provider or model path.",
        ],
        latestTurnId: selectedTurn?.id || null,
      };
    case "recent_reply":
      return {
        topic,
        text: selectedTurnExplanation
          ? `${selectedTurnLabel}${selectedTurnExplanation.explainAnswer}`
          : "I do not have a previous completed turn to explain yet.",
        context: {
          topic,
          sampleQuestions: overview.sampleQuestions,
          latestTurnId: selectedTurn?.id || null,
          latestTurnSummary: selectedTurnExplanation?.summary || null,
        },
        evidence: selectedTurnExplanation?.evidence || ["No previous completed turn is available yet."],
        inference: selectedTurnExplanation?.inference || [],
        unknowns: selectedTurnExplanation?.unknowns || [
          "Without a stored turn, I cannot separate confirmed evidence from inference for a reply.",
        ],
        latestTurnId: selectedTurn?.id || null,
        explainability: selectedTurnExplanation
          ? {
              summary: selectedTurnExplanation.summary,
              answerMode: selectedTurnExplanation.answerMode,
              evidence: selectedTurnExplanation.evidence,
              inference: selectedTurnExplanation.inference,
              unknowns: selectedTurnExplanation.unknowns,
              nextChecks: selectedTurnExplanation.nextChecks,
              turnStatus: selectedTurnExplanation.turnStatus,
              latestTurnId: selectedTurn.id,
            }
          : null,
      };
    case "debug_help":
      return {
        topic,
        text: selectedFailureExplanation
          ? `${selectedTurnLabel}${selectedFailureExplanation.debugAnswer}`
          : "I do not have a recent failed or degraded turn to debug yet.",
        context: {
          topic,
          sampleQuestions: overview.sampleQuestions,
          latestTurnId: selectedFailureTurn?.id || null,
          failureCategory: selectedFailureExplanation?.failureCategory || null,
        },
        evidence: selectedFailureExplanation?.evidence || ["No recent failed or degraded turn is available yet."],
        inference: selectedFailureExplanation?.inference || [],
        unknowns: selectedFailureExplanation?.unknowns || [
          "Without a failed or degraded stored turn, I cannot ground debugging help in local evidence.",
        ],
        latestTurnId: selectedFailureTurn?.id || null,
        explainability: selectedFailureExplanation
          ? {
              summary: selectedFailureExplanation.summary,
              answerMode: "debug_help",
              evidence: selectedFailureExplanation.evidence,
              inference: selectedFailureExplanation.inference,
              unknowns: selectedFailureExplanation.unknowns,
              nextChecks: selectedFailureExplanation.nextChecks,
              turnStatus: selectedFailureTurn.turn_status,
              latestTurnId: selectedFailureTurn.id,
            }
          : null,
      };
    case "turn_data_usage":
      return buildTurnSpecificSelfKnowledgeResponse({
        topic,
        selectedTurn,
        selectedTurnExplanation,
        turnExplainability: selectedTurnExplainability,
        overview,
        selectedTurnLabel,
        textBuilder: (explainability, turnLabel) => [
          turnLabel,
          explainability.dataUsage.summary,
          explainability.routing.approvedFactsImpact,
          explainability.routing.lookupBacked
            ? "This reply was lookup-backed, so retrieved current-source material was also part of what the app used."
            : "This reply did not depend on external lookup evidence.",
        ].join(" "),
      });
    case "turn_storage":
      return buildTurnSpecificSelfKnowledgeResponse({
        topic,
        selectedTurn,
        selectedTurnExplanation,
        turnExplainability: selectedTurnExplainability,
        overview,
        selectedTurnLabel,
        textBuilder: (explainability, turnLabel) => [
          turnLabel,
          explainability.storedArtifacts.summary,
          `Stored fields for that turn included ${explainability.storedArtifacts.storedFields.join(", ")}.`,
        ].join(" "),
      });
    case "turn_routing":
      return buildTurnSpecificSelfKnowledgeResponse({
        topic,
        selectedTurn,
        selectedTurnExplanation,
        turnExplainability: selectedTurnExplainability,
        overview,
        selectedTurnLabel,
        textBuilder: (explainability, turnLabel) => [
          turnLabel,
          explainability.routing.summary,
          explainability.routing.approvedFactsImpact,
          explainability.routing.lookupBacked
            ? "The stored lookup metadata shows that retrieval contributed to the answer path."
            : "The stored lookup metadata does not show a lookup-backed answer path.",
        ].join(" "),
      });
    default:
      return null;
  }
}

export function buildSelfKnowledgeDebugState() {
  const overview = buildSelfKnowledgeOverview();
  const latestTurn = getLatestExplainableTurn();
  const latestTurnExplanation = latestTurn ? buildLatestTurnExplanation(latestTurn) : null;
  const latestFailureTurn = getLatestFailureTurn();
  const latestFailureExplanation = latestFailureTurn ? buildFailureDebugExplanation(latestFailureTurn) : null;

  return {
    overview,
    latestTurnExplanation: latestTurnExplanation
      ? {
          latestTurnId: latestTurn.id,
          ...latestTurnExplanation,
        }
      : null,
    latestFailureExplanation: latestFailureExplanation
      ? {
          latestTurnId: latestFailureTurn.id,
          ...latestFailureExplanation,
        }
      : null,
  };
}

export function buildTurnExplainability(turn) {
  if (!turn) {
    return null;
  }

  const latestTurnExplanation = buildLatestTurnExplanation(turn);
  const dataUsage = buildTurnDataUsage(turn);
  const storedArtifacts = buildStoredArtifactsSummary(turn);
  const routing = buildTurnRoutingSummary(turn);
  const failureExplanation =
    turn.turn_status !== "completed" || turn.failure_json
      ? buildFailureDebugExplanation(turn)
      : null;

  return {
    summary: latestTurnExplanation.summary,
    answerMode: latestTurnExplanation.answerMode,
    turnStatus: latestTurnExplanation.turnStatus,
    evidence: latestTurnExplanation.evidence,
    inference: latestTurnExplanation.inference,
    unknowns: latestTurnExplanation.unknowns,
    nextChecks: latestTurnExplanation.nextChecks,
    providerPath: latestTurnExplanation.providerPath,
    dataUsage,
    storedArtifacts,
    routing,
    failure:
      failureExplanation
        ? {
            summary: failureExplanation.summary,
            failureCategory: failureExplanation.failureCategory,
            evidence: failureExplanation.evidence,
            inference: failureExplanation.inference,
            unknowns: failureExplanation.unknowns,
            nextChecks: failureExplanation.nextChecks,
          }
        : null,
  };
}

export function buildSelfKnowledgeOverview() {
  const defaultPrivacyMode = config.externalLookupPrivacyMode === "balanced" ? "balanced" : "strict";

  return {
    architectureSummary:
      "This is a local voice-first app with a React frontend, a Fastify backend, and SQLite persistence.",
    providerSummary:
      "The browser only talks to the local backend, which handles STT, replies, optional external lookup, TTS, and debug metadata.",
    storageFacts: [
      "Raw turns are stored locally in backend/data/assistant.sqlite.",
      "Stored turn data includes transcript text, assistant text, timings, provider metadata, failure details, transcript mime type, and audio byte count.",
      "The app also stores a rolling summary, approved facts, candidate facts, and external lookup cache entries locally.",
    ],
    lookupFacts: [
      `Current-information lookup is backend-mediated and defaults to ${defaultPrivacyMode} privacy mode.`,
      "Balanced mode can use limited local hints for resolution, while strict mode keeps lookup question-only.",
      "Lookup metadata records whether the reply used fresh retrieval, cached retrieval, or no lookup at all.",
    ],
    runtimeFacts: [
      `Default chat model: ${config.chatModel}.`,
      `Default speech-to-text model: ${config.sttModel}.`,
      `Default text-to-speech model: ${config.ttsModel}.`,
    ],
    sampleQuestions: SELF_KNOWLEDGE_SAMPLE_QUESTIONS,
  };
}

export const __testables = {
  classifySelfKnowledgeTopic,
  buildLatestTurnExplanation,
  buildFailureDebugExplanation,
};

function classifySelfKnowledgeTopic(question) {
  if (!question) {
    return null;
  }

  if (
    /\b(how do you work|how does this (assistant|app) work|how are you built|how are you wired|what is your architecture)\b/.test(
      question
    )
  ) {
    return "architecture";
  }

  if (
    /\b(what do you store|what data do you store|what do you keep locally|what is stored locally|where do you store)\b/.test(
      question
    )
  ) {
    return "storage";
  }

  if (
    /\b(what model handled my last turn|what provider handled my last turn|what model handled that turn|which model handled my last reply|which provider handled my last reply)\b/.test(
      question
    )
  ) {
    return "provider_path";
  }

  if (
    /\b(why did you say that|why did you answer that way|explain your last reply|why that reply|why did you respond that way)\b/.test(
      question
    )
  ) {
    return "recent_reply";
  }

  if (
    /\b(why did(?:n't| not) audio play|why did the audio fail|help me debug the last failure|help debug the last turn|why did that fail|what went wrong last turn)\b/.test(
      question
    )
  ) {
    return "debug_help";
  }

  if (
    /\b(what data did you use for that turn|what data did you use for this turn|what context did you use for that turn|what context did you use for this turn|did approved facts affect that reply|did approved facts affect this reply)\b/.test(
      question
    )
  ) {
    return "turn_data_usage";
  }

  if (
    /\b(what was stored from that turn|what was stored from this turn|what did you store from that turn|what did you store from this turn)\b/.test(
      question
    )
  ) {
    return "turn_storage";
  }

  if (
    /\b(was that model only or lookup backed|was this model only or lookup backed|was that model-only or lookup-backed|was this model-only or lookup-backed|was that reply model only or lookup backed|was that reply model-only or lookup-backed)\b/.test(
      question
    )
  ) {
    return "turn_routing";
  }

  return null;
}

function buildArchitectureAnswer(overview) {
  return [
    overview.architectureSummary,
    overview.providerSummary,
    "For each turn, the backend can package recent turns, approved facts, and a rolling summary before generating the reply.",
    "If the question looks current or source-sensitive, lookup is still routed through the backend instead of directly from the browser.",
  ].join(" ");
}

function buildStorageAnswer(overview) {
  return [
    overview.storageFacts[0],
    overview.storageFacts[1],
    overview.storageFacts[2],
    "This app is local-first today, so the durable records live on this machine rather than in a shared cloud account.",
  ].join(" ");
}

function buildTurnSpecificSelfKnowledgeResponse({
  topic,
  selectedTurn,
  selectedTurnExplanation,
  turnExplainability,
  overview,
  selectedTurnLabel,
  textBuilder,
}) {
  if (!selectedTurn || !turnExplainability) {
    return {
      topic,
      text: "I do not have a previous completed turn to answer that from yet.",
      context: {
        topic,
        sampleQuestions: overview.sampleQuestions,
        latestTurnId: null,
      },
      evidence: ["No previous completed turn is available yet."],
      inference: [],
      unknowns: ["Without a stored turn, I cannot ground that answer in local evidence."],
      latestTurnId: null,
      explainability: null,
    };
  }

  return {
    topic,
    text: textBuilder(turnExplainability, selectedTurnLabel),
    context: {
      topic,
      sampleQuestions: overview.sampleQuestions,
      latestTurnId: selectedTurn.id,
      latestTurnSummary: selectedTurnExplanation?.summary || turnExplainability.summary,
    },
    evidence: turnExplainability.evidence,
    inference: turnExplainability.inference,
    unknowns: turnExplainability.unknowns,
    latestTurnId: selectedTurn.id,
    explainability: {
      ...turnExplainability,
      latestTurnId: selectedTurn.id,
    },
  };
}

function describeRequestedTurnLabel(requestedTurnId, resolvedTurnId) {
  if (requestedTurnId && resolvedTurnId && requestedTurnId === resolvedTurnId) {
    return `For the selected turn ${summarizeTurnReference(resolvedTurnId)}: `;
  }

  return "";
}

function buildLatestTurnExplanation(turn) {
  const providerInfo = turn.provider_json || {};
  const contextInfo = turn.context_json || {};
  const lookupInfo = providerInfo.lookup || null;
  const failureInfo = turn.failure_json || null;
  const timings = turn.latency_json || {};
  const tokenInfo = turn.token_json || {};
  const approvedFactCount = Array.isArray(contextInfo.approvedFacts) ? contextInfo.approvedFacts.length : 0;
  const recentTurnCount = Array.isArray(contextInfo.recentTurns) ? contextInfo.recentTurns.length : 0;
  const hasSummary = Boolean(String(contextInfo.rollingSummary || "").trim());
  const providerPath = describeProviderPath(providerInfo);
  const lookupSummary = describeLookupSummary(lookupInfo);
  const answerMode = determineExplainabilityAnswerMode(providerInfo, failureInfo);
  const evidence = [
    `The latest completed turn used ${providerPath}.`,
    lookupSummary,
    `The stored context package included ${recentTurnCount} recent turn ${recentTurnCount === 1 ? "snippet" : "snippets"}, ${approvedFactCount} approved ${approvedFactCount === 1 ? "fact" : "facts"}, and ${hasSummary ? "a rolling summary" : "no rolling summary"}.`,
    `The final stored assistant text was: "${String(turn.assistant_text || "").trim() || "(empty)"}".`,
    describeLatencyEvidence(timings),
  ];
  const inference = [
    "The reply was likely shaped to stay brief and voice-friendly because the system prompt and lookup composition both bias toward concise spoken answers.",
    describeContextContribution({ approvedFactCount, recentTurnCount, hasSummary }),
  ];

  if (lookupInfo?.status === "used") {
    inference.push("Because lookup ran, the backend likely prioritized current-source evidence over model-only recall.");
  }

  if ((tokenInfo?.provider?.total_tokens || 0) > 0) {
    inference.push(`The provider reported ${tokenInfo.provider.total_tokens} total tokens for that turn, which suggests a normal generated reply path rather than a stubbed response.`);
  }

  const unknowns = [
    "I cannot see hidden chain-of-thought or token-by-token reasoning inside the model.",
    "I can only explain the stored inputs, routing decisions, and final outputs that the app recorded.",
  ];
  const nextChecks = buildRecentReplyNextChecks({ providerInfo, lookupInfo, failureInfo });

  return {
    summary: `${providerPath}. ${lookupSummary}`,
    providerPath,
    answerMode,
    turnStatus: turn.turn_status,
    evidence,
    inference,
    unknowns,
    nextChecks,
    providerAnswer: `Your latest completed turn used ${providerPath}. ${lookupSummary}`,
    explainAnswer: [
      `Confirmed evidence: ${evidence[0]} ${evidence[1]} ${evidence[2]} ${evidence[3]}`,
      `Inference: ${inference.join(" ")}`,
      `Unknown: ${unknowns.join(" ")}`,
      nextChecks.length ? `Useful next checks: ${nextChecks.join(" ")}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

function buildTurnDataUsage(turn) {
  const contextInfo = turn.context_json || {};
  const providerInfo = turn.provider_json || {};
  const lookupInfo = providerInfo.lookup || null;
  const approvedFactCount = Array.isArray(contextInfo.approvedFacts) ? contextInfo.approvedFacts.length : 0;
  const recentTurnCount = Array.isArray(contextInfo.recentTurns) ? contextInfo.recentTurns.length : 0;
  const hasSummary = Boolean(String(contextInfo.rollingSummary || "").trim());
  const citationsCount = Array.isArray(lookupInfo?.citations) ? lookupInfo.citations.length : 0;

  const evidence = [
    `The stored current user text was "${String(contextInfo.currentUserText || turn.transcript_text || "").trim() || "(empty)"}".`,
    `The context package included ${recentTurnCount} recent turn ${recentTurnCount === 1 ? "snippet" : "snippets"}, ${approvedFactCount} approved ${approvedFactCount === 1 ? "fact" : "facts"}, and ${hasSummary ? "a rolling summary" : "no rolling summary"}.`,
    lookupInfo?.status === "used"
      ? `Lookup supplied ${citationsCount} cited ${citationsCount === 1 ? "source" : "sources"} and used ${lookupInfo.retrievalSource === "cache" ? "cached retrieval artifacts" : "fresh retrieval"}.`
      : "No external lookup sources were attached to this turn.",
  ];

  const summary =
    approvedFactCount || recentTurnCount || hasSummary || lookupInfo?.status === "used"
      ? "This turn used the current utterance plus some stored or retrieved context."
      : "This turn appears to have relied mostly on the current utterance and provider defaults.";

  return {
    summary,
    approvedFactCount,
    recentTurnCount,
    usedRollingSummary: hasSummary,
    lookupUsed: lookupInfo?.status === "used",
    retrievalSource: lookupInfo?.retrievalSource || null,
    evidence,
  };
}

function buildStoredArtifactsSummary(turn) {
  const providerInfo = turn.provider_json || {};
  const failureInfo = turn.failure_json || null;
  const storedFields = [
    "transcript_text",
    "assistant_text",
    "context_json",
    "latency_json",
    "token_json",
    "provider_json",
  ];

  if (failureInfo) {
    storedFields.push("failure_json");
  }

  if (turn.transcript_mime_type) {
    storedFields.push("transcript_mime_type");
  }

  if (typeof turn.audio_bytes === "number") {
    storedFields.push("audio_bytes");
  }

  const evidence = [
    `Transcript text ${turn.transcript_text ? "was" : "was not"} stored for this turn.`,
    `Assistant text ${turn.assistant_text ? "was" : "was not"} stored for this turn.`,
    `Provider metadata ${providerInfo ? "was" : "was not"} stored for this turn.`,
    failureInfo
      ? "A failure record was stored for this turn."
      : "No failure record was stored for this turn.",
  ];

  return {
    summary: "The app stores the transcript, reply, context/debug metadata, and optional failure details for this turn locally.",
    storedFields,
    transcriptMimeType: turn.transcript_mime_type || "",
    audioBytes: typeof turn.audio_bytes === "number" ? turn.audio_bytes : null,
    evidence,
  };
}

function buildTurnRoutingSummary(turn) {
  const providerInfo = turn.provider_json || {};
  const lookupInfo = providerInfo.lookup || null;
  const contextInfo = turn.context_json || {};
  const approvedFactCount = Array.isArray(contextInfo.approvedFacts) ? contextInfo.approvedFacts.length : 0;
  const answerMode = determineExplainabilityAnswerMode(providerInfo, turn.failure_json || null);
  const lookupBacked = lookupInfo?.status === "used";
  const modelOnly = lookupInfo?.status === "not_needed" || !lookupInfo;
  const selfKnowledge = providerInfo?.selfKnowledge?.status === "used";

  let approvedFactsImpact = "No approved facts were packaged for this turn.";
  if (approvedFactCount > 0) {
    approvedFactsImpact =
      "Approved facts were available in the context package, but the app cannot prove exactly which wording came from them.";
  }

  return {
    summary: selfKnowledge
      ? "This turn was answered by the local self-knowledge path."
      : lookupBacked
        ? "This turn was lookup-backed rather than model-only."
        : modelOnly
          ? "This turn was model-only with no external lookup needed."
          : `This turn used routing mode ${answerMode}.`,
    answerMode,
    lookupStatus: lookupInfo?.status || "none",
    lookupBacked,
    modelOnly,
    selfKnowledge,
    approvedFactsImpact,
    evidence: [
      `Provider path: ${describeProviderPath(providerInfo)}.`,
      `Lookup status: ${lookupInfo?.status || "none"}.`,
      approvedFactsImpact,
    ],
  };
}

function buildFailureDebugExplanation(turn) {
  const failureInfo = turn.failure_json || {};
  const providerInfo = turn.provider_json || {};
  const timings = turn.latency_json || {};
  const lookupInfo = providerInfo.lookup || null;
  const failureCategory = failureInfo.stage || inferFailureCategoryFromTurn(turn);
  const evidence = [
    `The stored turn status was ${turn.turn_status}.`,
    failureInfo.message
      ? `The stored failure message was "${failureInfo.message}".`
      : "No explicit failure message was stored for that turn.",
    describeLatencyEvidence(timings),
    describeLookupSummary(lookupInfo),
  ];
  const inference = [inferFailureCause(failureCategory, failureInfo.message, lookupInfo)].filter(Boolean);
  const unknowns = [
    "I cannot see browser internals beyond the stored playback and failure metadata.",
    "If the failure happened outside the stored turn lifecycle, I may only have a partial picture.",
  ];
  const nextChecks = buildFailureNextChecks(failureCategory, lookupInfo);

  return {
    failureCategory,
    summary: `${formatFailureCategoryLabel(failureCategory)} issue on turn ${summarizeTurnReference(turn.id)}.`,
    evidence,
    inference,
    unknowns,
    nextChecks,
    debugAnswer: [
      `Confirmed evidence: ${evidence.join(" ")}`,
      inference.length ? `Inference: ${inference.join(" ")}` : "",
      `Unknown: ${unknowns.join(" ")}`,
      nextChecks.length ? `Useful next checks: ${nextChecks.join(" ")}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

function getLatestExplainableTurn() {
  const turns = store.getRecentCompletedTurns(8);
  return turns.length ? turns[turns.length - 1] : null;
}

function getSelectedExplainableTurn(turnId) {
  if (turnId) {
    const turn = store.getTurnById(turnId);
    if (turn) {
      return turn;
    }
  }

  return getLatestExplainableTurn();
}

function getLatestFailureTurn() {
  const turns = store.getDebugTurns(20);
  return turns.find((turn) => turn.turn_status !== "completed" || turn.failure_json) || null;
}

function getSelectedFailureTurn(turnId) {
  if (turnId) {
    const turn = store.getTurnById(turnId);
    if (turn && (turn.turn_status !== "completed" || turn.failure_json)) {
      return turn;
    }
  }

  return getLatestFailureTurn();
}

function describeProviderPath(providerInfo) {
  const providerLabel = providerInfo?.provider || "unknown provider";
  const apiLabel = providerInfo?.api || "unknown api path";
  const chatModel = providerInfo?.chatModel || "unknown chat model";
  const ttsModel = providerInfo?.ttsModel || "unknown tts model";

  if (providerLabel === "local_self_knowledge") {
    return "the local self-knowledge path";
  }

  return `${providerLabel} via ${apiLabel}, with chat model ${chatModel} and TTS model ${ttsModel}`;
}

function describeLookupSummary(lookupInfo) {
  if (!lookupInfo) {
    return "No external lookup metadata was attached to that turn.";
  }

  if (lookupInfo.status === "used") {
    const source = lookupInfo.retrievalSource === "cache" ? "cached retrieval artifacts" : "fresh retrieval";
    const privacyMode = lookupInfo.privacyMode || "strict";
    const questionKind = lookupInfo.questionKind || "other";
    return `Lookup ran in ${privacyMode} mode for a ${questionKind} question, and the reply was shaped from ${source}.`;
  }

  if (lookupInfo.status === "failed_then_fell_back") {
    return "Lookup was attempted but failed, so the backend fell back to a model-only reply.";
  }

  if (lookupInfo.status === "not_needed") {
    return "The backend marked that turn as model-only, with no external lookup needed.";
  }

  if (lookupInfo.status === "provider_unavailable") {
    return "The backend wanted lookup help, but the lookup-capable provider path was unavailable.";
  }

  if (lookupInfo.status === "disabled") {
    return "External lookup was disabled for that turn.";
  }

  if (lookupInfo.status === "not_applicable") {
    return "Lookup was not part of that local self-knowledge answer.";
  }

  return `Lookup status for that turn was ${lookupInfo.status}.`;
}

function describeLatencyEvidence(timings) {
  const capture = timings?.captureEnd ? "capture end was recorded" : "capture end was not recorded";
  const stt = timings?.sttComplete ? "STT completion was recorded" : "STT completion was not recorded";
  const firstToken = timings?.chatFirstToken ? "first reply token time was recorded" : "first reply token time was not recorded";
  const tts = timings?.ttsComplete ? "TTS completion was recorded" : "TTS completion was not recorded";

  return `Timing evidence shows ${capture}, ${stt}, ${firstToken}, and ${tts}.`;
}

function describeContextContribution({ approvedFactCount, recentTurnCount, hasSummary }) {
  if (!approvedFactCount && !recentTurnCount && !hasSummary) {
    return "Because the stored context was minimal, the reply likely leaned mostly on the current utterance and provider behavior.";
  }

  if (approvedFactCount && hasSummary) {
    return "Because both approved facts and a rolling summary were present, the reply may have drawn on durable context as well as the current utterance.";
  }

  if (recentTurnCount) {
    return "Because recent turns were packaged, the reply may have used short-range conversational continuity rather than treating the question as isolated.";
  }

  return "The stored context suggests some continuity was available, but not enough to prove exactly which context fragment changed the wording.";
}

function determineExplainabilityAnswerMode(providerInfo, failureInfo) {
  if (providerInfo?.selfKnowledge?.status === "used") {
    return "self_knowledge";
  }

  if (failureInfo?.stage === "tts") {
    return "text_reply_with_tts_failure";
  }

  if (providerInfo?.lookup?.status === "used") {
    return "current_source_answer";
  }

  if (providerInfo?.lookup?.status === "failed_then_fell_back") {
    return "model_only_fallback";
  }

  return "model_only_answer";
}

function buildRecentReplyNextChecks({ providerInfo, lookupInfo, failureInfo }) {
  const checks = [];

  if (lookupInfo?.status === "used") {
    checks.push("Review the stored citations and retrieval source in the technical details card.");
  }

  if (lookupInfo?.status === "failed_then_fell_back") {
    checks.push("Inspect the lookup error and cache metadata in the stored provider payload.");
  }

  if (failureInfo?.stage === "tts") {
    checks.push("Compare the display text to the spoken text path, since the reply succeeded but audio generation failed.");
  }

  if (providerInfo?.chatModel) {
    checks.push(`Confirm whether ${providerInfo.chatModel} was the intended chat model for that turn.`);
  }

  return checks;
}

function inferFailureCategoryFromTurn(turn) {
  if (turn.turn_status === "completed_with_tts_failure") {
    return "tts";
  }

  if (turn.turn_status === "stt_failed") {
    return "stt";
  }

  return "server";
}

function inferFailureCause(failureCategory, message = "", lookupInfo = null) {
  if (failureCategory === "tts") {
    return "The reply text completed, so the failure likely happened in speech synthesis rather than in reply generation.";
  }

  if (failureCategory === "stt") {
    return "The turn appears to have failed before a usable transcript was available, so reply generation probably never had reliable user text.";
  }

  if (failureCategory === "cancelled") {
    return "The stored data suggests the turn was intentionally interrupted rather than failing spontaneously.";
  }

  if (lookupInfo?.status === "failed_then_fell_back") {
    return "Lookup trouble may have contributed, but the app still attempted to recover with a model-only answer.";
  }

  if (/failed to fetch/i.test(String(message || ""))) {
    return "The failure pattern looks network or local-backend connectivity related.";
  }

  return "The stored evidence shows a failure, but the exact runtime cause is only partially visible from local metadata.";
}

function buildFailureNextChecks(failureCategory, lookupInfo) {
  const checks = [];

  if (failureCategory === "tts") {
    checks.push("Verify that the turn still contains assistant text and compare it with the playback-ready state.");
    checks.push("Retry a short reply to see whether the failure is content-specific or persistent.");
  } else if (failureCategory === "stt") {
    checks.push("Check microphone permission and whether the transcript arrived empty.");
    checks.push("Retry a short utterance and confirm that STT completion appears in the timing markers.");
  } else if (failureCategory === "cancelled") {
    checks.push("Confirm whether the interruption was user-initiated or caused by a new turn starting.");
  } else {
    checks.push("Inspect the stored failure message and timing markers in the technical details card.");
  }

  if (lookupInfo?.status === "failed_then_fell_back") {
    checks.push("Inspect lookup error details to separate retrieval failure from reply-generation failure.");
  }

  return checks;
}

function formatFailureCategoryLabel(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "Unknown";
  }

  if (normalized.toLowerCase() === "tts") {
    return "TTS";
  }

  if (normalized.toLowerCase() === "stt") {
    return "STT";
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function summarizeTurnReference(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "unknown";
  }

  const uuidMatch = normalized.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  if (uuidMatch) {
    return uuidMatch[0].slice(0, 8);
  }

  return normalized.slice(0, 8);
}

function normalizeQuestion(question) {
  return String(question || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}
