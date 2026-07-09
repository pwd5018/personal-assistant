import OpenAI from "openai";
import { toFile } from "openai/uploads";
import { config } from "../config.js";

const ALLOWED_MEMORY_CATEGORIES = new Set([
  "user_identity",
  "user_preference",
  "relationship_context",
  "stable_routine",
  "assistant_identity",
]);

const MIN_MEMORY_CONFIDENCE = 0.7;
const ALLOWED_MEMORY_RECOMMENDATIONS = new Set(["approve", "dismiss", "reject"]);

export class OpenAiProvider {
  constructor() {
    this.client = config.openAiApiKey
      ? new OpenAI({ apiKey: config.openAiApiKey })
      : null;
  }

  isConfigured() {
    return Boolean(this.client);
  }

  assertConfigured() {
    if (!this.client) {
      throw new Error("OPENAI_API_KEY is not configured.");
    }
  }

  async transcribe({ audioBuffer, mimeType, signal }) {
    this.assertConfigured();

    const file = await toFile(audioBuffer, "voice-input.webm", {
      type: mimeType || "audio/webm",
    });

    const result = await this.client.audio.transcriptions.create(
      {
        file,
        model: config.sttModel,
      },
      { signal }
    );

    return {
      text: result.text?.trim() || "",
      raw: result,
    };
  }

  async streamChat({ contextPackage, signal, onDelta }) {
    this.assertConfigured();

    const messages = buildChatMessages(contextPackage);
    const stream = await this.client.chat.completions.create(
      {
        model: config.chatModel,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal }
    );

    let text = "";
    let usage = null;
    let firstTokenAt = null;

    for await (const chunk of stream) {
      if (signal.aborted) {
        break;
      }

      const delta = chunk.choices?.[0]?.delta?.content || "";
      if (delta) {
        if (!firstTokenAt) {
          firstTokenAt = new Date().toISOString();
        }
        text += delta;
        onDelta(delta);
      }

      if (chunk.usage) {
        usage = chunk.usage;
      }
    }

    return {
      text: text.trim(),
      usage,
      firstTokenAt,
    };
  }

  async answerWithExternalLookup({ question, lookupPlan, signal }) {
    this.assertConfigured();

    const response = await this.client.responses.create(
      {
        model: config.externalLookupModel,
        tools: [
          {
            type: "web_search_preview",
            search_context_size: config.externalLookupSearchContextSize,
          },
        ],
        include: ["web_search_call.action.sources"],
        input: buildExternalLookupMessages({
          question,
          lookupPlan,
        }),
      },
      { signal }
    );

    const citations = extractResponseCitations(response);
    const webSearches = extractWebSearches(response);
    const evidence = await gradeLookupEvidence.call(this, {
      question,
      lookupPlan,
      rawText: extractResponseText(response),
      citations,
      webSearches,
    });
    const extraction = await extractLookupAnswerData.call(this, {
      question,
      lookupPlan,
      rawText: extractResponseText(response),
      citations,
      webSearches,
      evidence,
    });
    const composition = await composeExternalLookupResponse.call(this, {
      question,
      lookupPlan,
      rawText: extractResponseText(response),
      citations,
      webSearches,
      evidence,
      extraction,
    });

    return {
      text: composition.displayAnswer,
      displayText: composition.displayAnswer,
      spokenText: composition.spokenAnswer,
      answerStatus: composition.answerStatus,
      showSources: composition.showSources,
      evidence,
      extraction,
      usage: response.usage || null,
      citations,
      webSearches,
    };
  }

  async classifyExternalLookupNeed({ question, recentTurns = [] }) {
    this.assertConfigured();

    const response = await this.client.chat.completions.create(
      {
        model: config.externalLookupDecisionModel,
        messages: buildExternalLookupDecisionMessages({ question, recentTurns }),
        response_format: { type: "json_object" },
      }
    );

    return parseExternalLookupDecision(
      response.choices?.[0]?.message?.content?.trim() || "",
      question
    );
  }

  async resolveLookupEntity({ question, questionKind = "other", candidates = [] }) {
    this.assertConfigured();

    if (!Array.isArray(candidates) || !candidates.length) {
      return null;
    }

    const response = await this.client.chat.completions.create({
      model: config.externalLookupDecisionModel,
      messages: buildLookupEntityResolutionMessages({
        question,
        questionKind,
        candidates,
      }),
      response_format: { type: "json_object" },
    });

    return parseLookupEntityResolution(
      response.choices?.[0]?.message?.content?.trim() || ""
    );
  }

  async synthesizeSpeech({ text, signal }) {
    this.assertConfigured();
    const speechInput = normalizeSpeechInput(text);

    if (!speechInput) {
      throw new Error("No assistant text was available for speech synthesis.");
    }

    const response = await this.client.audio.speech.create(
      {
        model: config.ttsModel,
        voice: config.ttsVoice,
        input: speechInput,
        format: "mp3",
      },
      { signal }
    );

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    return {
      audioBuffer,
      mimeType: "audio/mpeg",
      speechInput,
    };
  }

  async summarizeConversation({ transcriptWindow, existingSummary, approvedFacts = [] }) {
    this.assertConfigured();

    const prompt = [
      "Update a compact rolling conversation summary for future turns.",
      "Use only evidence from the existing summary and the recent turns below.",
      "Keep it factual, privacy-conscious, and under 180 words.",
      "Do not promote unapproved facts into certainty.",
      "Do not mention assistant capabilities, generic rapport, tone, or flattering meta commentary unless directly useful later.",
      "Do not mention product, model, provider, policy, system, or knowledge-cutoff details.",
      "Do not repeat approved durable facts unless the recent turns materially changed them.",
      "Focus on concrete continuity: confirmed user context, active real-world topics, and open follow-ups.",
      "Return exactly these lines:",
      "Confirmed context: ...",
      "Active threads: ...",
      "Open loops: ...",
      existingSummary ? `Existing summary:\n${existingSummary}` : "",
      approvedFacts.length
        ? `Approved facts already stored separately:\n- ${approvedFacts.map((fact) => fact.fact_text).join("\n- ")}`
        : "",
      "Recent turns:",
      transcriptWindow
        .map(
          (turn) =>
            `User: ${turn.transcript_text || ""}\nAssistant: ${turn.assistant_text || ""}`
        )
        .join("\n\n"),
    ]
      .filter(Boolean)
      .join("\n\n");

    const response = await this.client.chat.completions.create({
      model: config.summaryModel,
      messages: [{ role: "system", content: prompt }],
    });

    return sanitizeRollingSummary(response.choices?.[0]?.message?.content?.trim() || "");
  }

  async extractCandidateFacts({
    transcriptText,
    assistantText,
    existingApprovedFacts,
  }) {
    this.assertConfigured();

    if (looksEphemeral(transcriptText, assistantText)) {
      return [];
    }

    const directAssistantIdentityFacts = extractDirectAssistantIdentityFacts(transcriptText);
    const directUserIdentityFacts = extractDirectUserIdentityFacts(transcriptText);
    const directIdentityFacts = [...directAssistantIdentityFacts, ...directUserIdentityFacts];

    const prompt = [
      "Review the conversation and propose only durable, low-risk memory candidates for future conversations.",
      "Return a JSON array of objects and nothing else.",
      'Each object must be: {"fact":"...","category":"...","confidence":0.0,"recommendation":"approve|dismiss|reject","reason":"..."}',
      "Allowed categories: user_identity, user_preference, relationship_context, stable_routine, assistant_identity, assistant_meta, system_meta, ephemeral, uncertain.",
      "Base candidates only on what the user explicitly said in the current utterance.",
      "Do not use prior approved facts, rolling summaries, recent turns, or the assistant's reply as evidence for a new memory candidate.",
      "Do not store the user's question itself as memory unless it reveals a stable preference, identity detail, routine, or relationship context.",
      "Use assistant_identity only when the user explicitly defines the assistant's durable identity, such as naming it.",
      "Use assistant_meta or system_meta for capability, limitation, safety, policy, provider, product, or knowledge-cutoff content.",
      "Use ephemeral for one-off requests, momentary states, temporary turn instructions, and same-day plans like doing something today, later today, tonight, or this weekend.",
      "Do not recommend approve for temporary plans, one-day intentions, or current-session logistics.",
      "Use uncertain when the fact is speculative, weakly supported, or inferred rather than explicit.",
      "Set confidence between 0.0 and 1.0 based on how clearly and directly supported the fact is by the user's words.",
      "Set recommendation to approve for durable, high-value memory; dismiss for plausible but low-value or temporary memory; reject for bad, misleading, or meta memory.",
      "Keep reason very short, like durable identity, stable preference, temporary plan, duplicate, too broad, or weak support.",
      "Keep facts short, explicit, and reviewable.",
      "Do not restate or paraphrase an already-known identity or routine fact as a new candidate.",
      "Do not output absence-of-information statements.",
      `User said:\n${transcriptText || ""}`,
      "Return at most 3 candidate objects.",
    ]
      .filter(Boolean)
      .join("\n\n");

    try {
      const response = await this.client.chat.completions.create({
        model: config.factExtractionModel,
        messages: [{ role: "system", content: prompt }],
      });

      const content = response.choices?.[0]?.message?.content?.trim() || "[]";
      const extractedFacts = sanitizeCandidateFacts(parseCandidateMemoryDecisions(content), {
        transcriptText,
        existingApprovedFacts,
      });
      const filteredModelFacts = directIdentityFacts.length
        ? extractedFacts.filter(
            (fact) => !isAssistantIdentityFact(fact.fact) && !isUserIdentityFact(fact.fact)
          )
        : extractedFacts;

      return sanitizeCandidateFacts([...directIdentityFacts, ...filteredModelFacts], {
        transcriptText,
        existingApprovedFacts,
      });
    } catch (error) {
      if (directIdentityFacts.length) {
        return directIdentityFacts;
      }

      throw error;
    }
  }
}

function buildChatMessages(contextPackage) {
  const messages = [{ role: "system", content: contextPackage.systemPrompt }];

  messages.push({
    role: "system",
    content: [
      "Voice reply guidance:",
      "- Sound natural and present, not scripted.",
      "- Avoid repeating the user's wording unless emphasis helps.",
      "- Do not turn background context into a recap unless it is directly relevant.",
      "- If personal context seems incomplete, respond gently without overcommitting.",
    ].join("\n"),
  });

  if (contextPackage.rollingSummary) {
    messages.push({
      role: "system",
      content: [
        "Background summary for continuity.",
        "Use it only when it improves the current reply.",
        "Do not quote or summarize it back to the user unless asked.",
        "",
        contextPackage.rollingSummary,
      ].join("\n"),
    });
  }

  if (contextPackage.approvedFacts.length) {
    messages.push({
      role: "system",
      content: [
        "Approved durable facts.",
        "Treat these as optional background context, not a checklist to mention.",
        "Only use a fact when it is relevant to the current turn.",
        `- ${contextPackage.approvedFacts.join("\n- ")}`,
      ].join("\n"),
    });
  }

  for (const turn of contextPackage.recentTurns) {
    if (turn.user) {
      messages.push({ role: "user", content: turn.user });
    }

    if (turn.assistant) {
      messages.push({ role: "assistant", content: turn.assistant });
    }
  }

  messages.push({ role: "user", content: contextPackage.currentUserText });

  return messages;
}

function buildExternalLookupMessages({ question, lookupPlan }) {
  const messages = [
    {
      role: "system",
      content: [
        config.systemPrompt,
        "External lookup mode:",
        "- Use current web sources for factual claims when they are relevant to the user's question.",
        "- Keep the answer voice-friendly and concise.",
        "- Default to 2 to 4 short sentences before any attribution line.",
        "- Do not use markdown headings, bullet lists, tables, or long structured dumps unless the user explicitly asked for detail.",
        "- Do not include hourly forecasts, long business schedules, market metadata blocks, or repeated source summaries by default.",
        "- For weather, give the current condition, approximate temperature, and the main practical note for today.",
        "- For stocks, give the current price and one or two key facts only, usually change and market cap.",
        "- For hours or open-now questions, answer open or closed first, then include only the most relevant hours.",
        "- If the search results do not clearly answer the question, say that plainly and ask for the missing detail or name the uncertainty instead of reading source titles back.",
        "- If a question like 'near me' depends on context and the context is still ambiguous, ask a concise follow-up instead of guessing.",
        "- Make it clear in the answer when current sources informed the reply.",
        "- Include a brief source attribution line using the retrieved source domains or titles when web search was used.",
        "- If current sources are weak, conflicting, or incomplete, say that plainly.",
        "- Do not invent source details, dates, prices, or quotes that were not supported by retrieved material.",
      ].join("\n"),
    },
  ];

  const localHints = buildLookupContextHints(lookupPlan.lookupContext);
  if (localHints) {
    messages.push({
      role: "system",
      content: localHints,
    });
  }

  messages.push({
    role: "user",
    content: [
      `Original user question: ${String(question || "").trim()}`,
      `Privacy-safe lookup query: ${lookupPlan.query}`,
      "Answer the original user question using current sources when needed.",
    ].join("\n"),
  });

  return messages;
}

function buildExternalLookupDecisionMessages({ question, recentTurns = [] }) {
  const recentTurnBlock = recentTurns.length
    ? recentTurns
        .map(
          (turn) =>
            `User: ${turn.user || ""}\nAssistant: ${turn.assistant || ""}`
        )
        .join("\n\n")
    : "none";

  return [
    {
      role: "system",
      content: [
        "Decide whether the app should use external web lookup for the user's latest question.",
        "Use reasoning, not keyword matching.",
        "The latest user question is the main signal. Recent turns are only there to resolve references like there, that place, that one, or tomorrow.",
        "Do not let recent turns override a new unrelated question.",
        "Choose needsLookup=true when the answer likely depends on current, live, source-sensitive, or web-verifiable information.",
        "Choose needsLookup=true for follow-up questions that rely on earlier lookup context, even if the latest wording is short or indirect.",
        "Choose needsLookup=false when the question is general knowledge, personal conversation, opinion, creative writing, or can be answered well without fresh sources.",
        "Simple greetings, check-ins, social niceties, and casual conversation should be needsLookup=false.",
        "If the question is underspecified for lookup, you can still set needsLookup=true when a lookup-oriented follow-up question is the right next step.",
        "Set needsResolution=true when the question likely refers to a business, place, or entity that should be resolved locally before lookup.",
        "Set canUseLocalMemoryForResolution=true when approved facts or recent turns could safely help resolve that entity.",
        "Return JSON only with this shape:",
        '{"needsLookup":true,"questionKind":"weather","answerMode":"lookup_required","needsResolution":true,"canUseLocalMemoryForResolution":true,"reason":"short_machine_reason","signals":["signal"],"confidence":0.0}',
        "Use a short snake_case reason.",
        "Question kinds: weather, market_price, hours, news, sports, general_chat, other.",
        "Answer modes: model_only, lookup_or_model, lookup_required.",
        "Keep signals short, like weather, time_sensitive, local_hours, follow_up_reference, ambiguous_location, finance, sports, news.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Latest user question:\n${String(question || "").trim()}`,
        `Recent turns for context:\n${recentTurnBlock}`,
      ].join("\n\n"),
    },
  ];
}

function buildLookupEntityResolutionMessages({ question, questionKind, candidates }) {
  const candidateBlock = candidates
    .map(
      (candidate, index) =>
        `${index}. entity=${candidate.entity || ""}; location=${candidate.location || ""}; source=${candidate.source || ""}`
    )
    .join("\n");

  return [
    {
      role: "system",
      content: [
        "Resolve whether the user's question refers to one of the local entity candidates.",
        "Use semantic matching, not literal keyword overlap only.",
        "Return JSON only.",
        "If one candidate clearly matches, return its index and confidence.",
        "If none clearly match, return matched=false.",
        'Return this shape: {"matched":true,"candidateIndex":0,"entity":"...","confidence":0.0}',
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Question kind: ${questionKind}`,
        `User question: ${String(question || "").trim()}`,
        `Candidates:\n${candidateBlock}`,
      ].join("\n\n"),
    },
  ];
}

function buildLookupContextHints(lookupContext) {
  const sections = [];

  if (lookupContext.approvedFacts?.length) {
    sections.push(
      [
        "Approved facts allowed for balanced lookup:",
        `Categories: ${(lookupContext.approvedFactCategories || []).join(", ") || "none"}`,
        `- ${lookupContext.approvedFacts.join("\n- ")}`,
      ].join("\n")
    );
  }

  if (lookupContext.recentTurns?.length) {
    const recentTurnBlock = lookupContext.recentTurns
      .map(
        (turn) =>
          `User: ${turn.user || ""}\nAssistant: ${turn.assistant || ""}`
      )
      .join("\n\n");
    sections.push(`Recent turn hints:\n${recentTurnBlock}`);
  }

  if (lookupContext.rollingSummary) {
    sections.push(`Rolling summary hint:\n${lookupContext.rollingSummary}`);
  }

  if (!sections.length) {
    return "";
  }

  return [
    "Local context hints were intentionally minimized for privacy.",
    "Use them only if they are necessary to interpret the user's question.",
    ...sections,
  ].join("\n\n");
}

function parseExternalLookupDecision(content, question) {
  const parsed = safeJsonParse(content);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Lookup decision model returned invalid JSON for question: ${String(question || "").trim()}`);
  }

  return {
    needed: Boolean(parsed.needsLookup),
    questionKind: normalizeLookupQuestionKind(parsed.questionKind),
    answerMode: normalizeLookupAnswerMode(parsed.answerMode),
    needsResolution: typeof parsed.needsResolution === "boolean" ? parsed.needsResolution : null,
    canUseLocalMemoryForResolution:
      typeof parsed.canUseLocalMemoryForResolution === "boolean"
        ? parsed.canUseLocalMemoryForResolution
        : null,
    reason: String(parsed.reason || "").trim() || "model_only_is_probably_enough",
    matchedSignals: Array.isArray(parsed.signals)
      ? parsed.signals
          .map((signal) => String(signal || "").trim())
          .filter(Boolean)
          .slice(0, 6)
      : [],
    confidence: typeof parsed.confidence === "number" ? normalizeMemoryConfidence(parsed.confidence) : null,
  };
}

function parseLookupEntityResolution(content) {
  const parsed = safeJsonParse(content);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  if (!parsed.matched) {
    return null;
  }

  const candidateIndex = Number.isInteger(parsed.candidateIndex) ? parsed.candidateIndex : null;
  const confidence =
    typeof parsed.confidence === "number" ? normalizeMemoryConfidence(parsed.confidence) : null;

  return {
    candidateIndex,
    entity: typeof parsed.entity === "string" ? parsed.entity.trim() : "",
    confidence,
  };
}

async function composeExternalLookupAnswerWithModel({
  question,
  lookupPlan,
  compactedText,
  citations,
}) {
  if (!compactedText) {
    return null;
  }

  const response = await this.client.chat.completions.create({
    model: config.externalLookupCompositionModel,
    messages: buildExternalLookupCompositionMessages({
      question,
      questionKind: lookupPlan?.questionKind || "other",
      compactedText,
      citations,
    }),
    response_format: { type: "json_object" },
  });

  return parseExternalLookupComposition(
    response.choices?.[0]?.message?.content?.trim() || ""
  );
}

async function gradeLookupEvidence({ question, lookupPlan, rawText, citations, webSearches }) {
  const fallback = buildFallbackEvidenceGrade({ citations, webSearches, rawText });
  const sourceLabels = citations
    .slice(0, 4)
    .map((citation) => formatCitationLabel(citation))
    .filter(Boolean);

  try {
    const response = await this.client.chat.completions.create({
      model: config.externalLookupCompositionModel,
      messages: [
        {
          role: "system",
          content: [
            "Grade whether the retrieved evidence supports answering the user's current-information question.",
            "Return JSON only.",
            "Evidence statuses: strong, weak, mismatched, missing.",
            "supportsDirectAnswer should be true only when the retrieved material clearly supports a direct answer to the user's question.",
            'Return this shape: {"evidenceStatus":"strong","supportsDirectAnswer":true,"confidence":0.0}',
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Question kind: ${lookupPlan?.questionKind || "other"}`,
            `Original question: ${String(question || "").trim()}`,
            `Resolved entity: ${String(lookupPlan?.queryEnrichment?.entity || "").trim() || "none"}`,
            `Resolved location: ${String(lookupPlan?.queryEnrichment?.location || "").trim() || "none"}`,
            `Raw lookup answer: ${String(rawText || "").trim() || "none"}`,
            `Citations: ${sourceLabels.join("; ") || "none"}`,
            `Web searches: ${JSON.stringify((webSearches || []).slice(0, 2))}`,
          ].join("\n\n"),
        },
      ],
      response_format: { type: "json_object" },
    });

    return parseLookupEvidenceGrade(
      response.choices?.[0]?.message?.content?.trim() || "",
      fallback
    );
  } catch {
    return fallback;
  }
}

async function extractLookupAnswerData({
  question,
  lookupPlan,
  rawText,
  citations,
  webSearches,
  evidence,
}) {
  const fallback = buildFallbackAnswerExtraction({
    question,
    lookupPlan,
    rawText,
    citations,
    webSearches,
    evidence,
  });
  const sourceLabels = citations
    .slice(0, 4)
    .map((citation) => formatCitationLabel(citation))
    .filter(Boolean);

  try {
    const response = await this.client.chat.completions.create({
      model: config.externalLookupCompositionModel,
      messages: [
        {
          role: "system",
          content: [
            "Decide whether the retrieved material actually answers the user's current-information question.",
            "Return JSON only.",
            "retrievalStatus: results_found or no_results.",
            "answerExtractability: direct_answer, summary_answer, insufficient, or off_topic.",
            "resultTopicMatch: high, medium, or low.",
            "If the result supports an answer, provide short displayAnswer and spokenAnswer.",
            "Never include URLs, markdown links, or source attributions in the answer fields.",
            'Return this shape: {"retrievalStatus":"results_found","answerExtractability":"direct_answer","resultTopicMatch":"high","displayAnswer":"...","spokenAnswer":"..."}',
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Question kind: ${lookupPlan?.questionKind || "other"}`,
            `Original question: ${String(question || "").trim()}`,
            `Evidence status: ${evidence?.evidenceStatus || "unknown"}`,
            `Supports direct answer: ${String(Boolean(evidence?.supportsDirectAnswer))}`,
            `Raw lookup answer: ${String(rawText || "").trim() || "none"}`,
            `Citations: ${sourceLabels.join("; ") || "none"}`,
            `Web searches: ${JSON.stringify((webSearches || []).slice(0, 2))}`,
          ].join("\n\n"),
        },
      ],
      response_format: { type: "json_object" },
    });

    return parseLookupAnswerExtraction(
      response.choices?.[0]?.message?.content?.trim() || "",
      fallback
    );
  } catch {
    return fallback;
  }
}

function buildExternalLookupCompositionMessages({
  question,
  questionKind,
  compactedText,
  citations = [],
}) {
  const sourceLabels = citations
    .slice(0, 3)
    .map((citation) => formatCitationLabel(citation))
    .filter(Boolean);

  return [
    {
      role: "system",
      content: [
        "Rewrite an externally researched answer into a product-ready reply.",
        "Return JSON only.",
        "Never include source attributions, URLs, markdown links, or 'Current sources checked' in either answer field.",
        "spokenAnswer is for TTS and should sound natural out loud.",
        "displayAnswer is for on-screen text and can be slightly fuller, but still concise.",
        "Keep uncertainty honest and human if the source evidence is weak.",
        "Question kinds: weather, market_price, hours, news, sports, general_chat, other.",
        "For weather, keep it to at most 2 short sentences.",
        "For market_price, keep it to the price, the move, and at most one extra key fact unless the user asked for more.",
        "For hours, answer open, closed, or cannot confirm first.",
        'Return this shape: {"displayAnswer":"...","spokenAnswer":"...","answerStatus":"answered|partial|uncertain|needs_clarification","showSources":true}',
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Question kind: ${questionKind}`,
        `Original question: ${String(question || "").trim()}`,
        `Raw researched answer: ${String(compactedText || "").trim()}`,
        `Sources: ${sourceLabels.join("; ") || "none"}`,
      ].join("\n\n"),
    },
  ];
}

function parseExternalLookupComposition(content) {
  const parsed = safeJsonParse(content);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const displayAnswer = normalizeAssistantAnswerText(parsed.displayAnswer);
  const spokenAnswer = normalizeAssistantAnswerText(parsed.spokenAnswer || displayAnswer);
  const answerStatus = normalizeAnswerStatus(parsed.answerStatus);
  const showSources = typeof parsed.showSources === "boolean" ? parsed.showSources : true;

  if (!displayAnswer || !spokenAnswer) {
    return null;
  }

  return {
    displayAnswer,
    spokenAnswer,
    answerStatus,
    showSources,
  };
}

function parseLookupEvidenceGrade(content, fallback) {
  const parsed = safeJsonParse(content);
  if (!parsed || typeof parsed !== "object") {
    return fallback;
  }

  const evidenceStatus = normalizeEvidenceStatus(parsed.evidenceStatus, fallback.evidenceStatus);
  const supportsDirectAnswer =
    typeof parsed.supportsDirectAnswer === "boolean"
      ? parsed.supportsDirectAnswer
      : fallback.supportsDirectAnswer;
  const confidence =
    typeof parsed.confidence === "number"
      ? normalizeMemoryConfidence(parsed.confidence)
      : fallback.confidence;

  return {
    evidenceStatus,
    supportsDirectAnswer,
    confidence,
  };
}

function parseLookupAnswerExtraction(content, fallback) {
  const parsed = safeJsonParse(content);
  if (!parsed || typeof parsed !== "object") {
    return fallback;
  }

  const displayAnswer = normalizeAssistantAnswerText(parsed.displayAnswer);
  const spokenAnswer = normalizeAssistantAnswerText(parsed.spokenAnswer || displayAnswer);

  return {
    retrievalStatus: normalizeRetrievalStatus(parsed.retrievalStatus, fallback.retrievalStatus),
    answerExtractability: normalizeAnswerExtractability(
      parsed.answerExtractability,
      fallback.answerExtractability
    ),
    resultTopicMatch: normalizeResultTopicMatch(parsed.resultTopicMatch, fallback.resultTopicMatch),
    displayAnswer: displayAnswer || fallback.displayAnswer,
    spokenAnswer: spokenAnswer || fallback.spokenAnswer || displayAnswer || fallback.displayAnswer,
  };
}

function looksEphemeral(transcriptText, assistantText) {
  const joined = `${transcriptText || ""} ${assistantText || ""}`.trim().toLowerCase();
  if (!joined) {
    return true;
  }

  const shortGreetingPattern =
    /^(hi|hello|hey|good morning|good afternoon|good evening|how are you|thanks|thank you)[.!? ]*$/i;

  return joined.length < 80 && shortGreetingPattern.test((transcriptText || "").trim());
}

function sanitizeCandidateFacts(content, options = {}) {
  if (Array.isArray(content)) {
    return finalizeCandidateFacts(content, options);
  }

  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return finalizeCandidateFacts(parsed, options);
  } catch {
    return [];
  }
}

function parseCandidateMemoryDecisions(content) {
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) {
      return [];
    }

    const seenCategories = new Set();

    return parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        fact: typeof item.fact === "string" ? item.fact : "",
        category: normalizeMemoryCategory(item.category),
        confidence: normalizeMemoryConfidence(item.confidence),
        recommendation: normalizeMemoryRecommendation(item.recommendation),
        recommendationReason: normalizeRecommendationReason(item.reason),
      }))
      .filter(
        (item) =>
          item.fact &&
          ALLOWED_MEMORY_CATEGORIES.has(item.category) &&
          item.confidence >= MIN_MEMORY_CONFIDENCE &&
          ALLOWED_MEMORY_RECOMMENDATIONS.has(item.recommendation)
      )
      .filter((item) => {
        if (seenCategories.has(item.category)) {
          return false;
        }

        seenCategories.add(item.category);
        return true;
      })
      .map((item) => ({
        fact: item.fact,
        category: item.category,
        recommendation: item.recommendation,
        recommendationReason: item.recommendationReason,
      }));
  } catch {
    return [];
  }
}

function extractDirectAssistantIdentityFacts(transcriptText) {
  const normalized = String(transcriptText || "").trim();
  if (!normalized) {
    return [];
  }

  const patterns = [
    /\byour name is\s+("?)([A-Za-z][A-Za-z0-9' -]{0,39})\1(?=[,.!?]|$)/i,
    /\bi(?: want to| am going to| will)? call you\s+("?)([A-Za-z][A-Za-z0-9' -]{0,39})\1(?=[,.!?]|$)/i,
    /\byou(?:'re| are) called\s+("?)([A-Za-z][A-Za-z0-9' -]{0,39})\1(?=[,.!?]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) {
      continue;
    }

    const assistantName = normalizeIdentityValue(match[2]);
    if (!assistantName) {
      continue;
    }

    return [buildDeterministicCandidateFact(
      `The assistant's name is ${assistantName}.`,
      "assistant_identity",
      "approve",
      "durable identity"
    )];
  }

  return [];
}

function extractDirectUserIdentityFacts(transcriptText) {
  const normalized = String(transcriptText || "").trim();
  if (!normalized) {
    return [];
  }

  const patterns = [
    /\bmy name is\s+("?)([A-Za-z][A-Za-z0-9' -]{0,39})\1(?=[,.!?]|$)/i,
    /\bcall me\s+("?)([A-Za-z][A-Za-z0-9' -]{0,39})\1(?=[,.!?]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) {
      continue;
    }

    const userName = normalizeIdentityValue(match[2]);
    if (!userName) {
      continue;
    }

    return [buildDeterministicCandidateFact(
      `The user's name is ${userName}.`,
      "user_identity",
      "approve",
      "durable identity"
    )];
  }

  return [];
}

function normalizeIdentityValue(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/^[`"'“”]+|[`"'“”]+$/g, "")
    .replace(/\s+/g, " ");

  if (!normalized || normalized.length > 40) {
    return "";
  }

  return normalized;
}

function sanitizeRollingSummary(value) {
  const normalized = String(value || "")
    .replace(/\r\n/g, "\n")
    .trim();

  if (!normalized) {
    return "";
  }

  const allowedPrefixes = ["Confirmed context:", "Active threads:", "Open loops:"];
  const blockedPatterns = [
    /\bknowledge cutoff\b/i,
    /\bopenai\b/i,
    /\bgpt[- ]?[\w.]+\b/i,
    /\bprovider\b/i,
    /\bpolicy\b/i,
    /\bsystem\b/i,
    /\bcapabilit(?:y|ies)\b/i,
    /\bfriendly rapport\b/i,
    /\bpersonalized rapport\b/i,
  ];

  const cleanedLines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => allowedPrefixes.some((prefix) => line.startsWith(prefix)))
    .filter((line) => !blockedPatterns.some((pattern) => pattern.test(line)))
    .map((line) => line.replace(/\s+/g, " "));
  const summaryByPrefix = new Map(cleanedLines.map((line) => [line.split(":")[0], line]));
  const normalizedLines = allowedPrefixes.map((prefix) => {
    const key = prefix.slice(0, -1);
    return summaryByPrefix.get(key) || `${prefix} none`;
  });

  return normalizedLines.join("\n").trim();
}

function finalizeCandidateFacts(items, options = {}) {
  const normalizedApprovedFacts = new Set(
    (options.existingApprovedFacts || [])
      .map((fact) => buildFactFingerprint(fact.fact_text || fact))
      .filter(Boolean)
  );
  const transcriptText = String(options.transcriptText || "");
  const transcriptLooksLikeMetaMemoryTalk = isMetaMemoryConversation(transcriptText);

  return [...new Set(
    items
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        fact: normalizeCandidateFact(item.fact),
        category: normalizeMemoryCategory(item.category),
        recommendation: normalizeMemoryRecommendation(item.recommendation),
        recommendationReason: normalizeRecommendationReason(item.recommendationReason),
      }))
      .filter((item) => item.fact.length > 0 && item.fact.length <= 160)
      .filter((item) => ALLOWED_MEMORY_CATEGORIES.has(item.category))
      .filter((item) => !isFilteredCandidateFact(item.fact))
      .filter((item) => !isTemporaryPlanCandidate(item.fact, item.category, item.recommendation, transcriptText))
      .filter((item) => !isMetaConversationCandidate(item.fact, item.category, transcriptText, transcriptLooksLikeMetaMemoryTalk))
      .filter((item) => {
        const fingerprint = buildFactFingerprint(item.fact);
        return fingerprint && !normalizedApprovedFacts.has(fingerprint);
      })
      .map((item) => JSON.stringify(item))
  )]
    .map((item) => JSON.parse(item))
    .slice(0, 3);
}

function normalizeCandidateFact(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^[-*]\s*/, "");

  if (!normalized) {
    return "";
  }

  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}

function normalizeMemoryCategory(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function normalizeMemoryConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.max(0, Math.min(1, numeric));
}

function normalizeMemoryRecommendation(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  return ALLOWED_MEMORY_RECOMMENDATIONS.has(normalized) ? normalized : "dismiss";
}

function normalizeRecommendationReason(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized) {
    return "Needs review";
  }

  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`;
}

function buildDeterministicCandidateFact(fact, category, recommendation, recommendationReason) {
  return {
    fact,
    category,
    recommendation,
    recommendationReason,
  };
}

function isFilteredCandidateFact(factText) {
  const normalized = String(factText || "").trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  if (normalized.includes("assistant") && !isAssistantIdentityFact(normalized)) {
    return true;
  }

  const blockedPatterns = [
    /\bknowledge cutoff\b/,
    /\bopenai\b/,
    /\bprovider\b/,
    /\bpolicy\b/,
    /\bassistant'?s knowledge\b/,
    /\btrained on data up to\b/,
    /\bdoes not have access to\b/,
    /\breal[- ]time\b/,
    /\bpre[- ]existing data\b/,
    /\bcapabilit(?:y|ies)\b/,
    /\bnot specified\b/,
    /\bnot provided\b/,
    /\bnot mentioned\b/,
    /\bthe user asked\b/,
  ];

  if (blockedPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  return false;
}

function isTemporaryPlanCandidate(factText, category, recommendation, transcriptText) {
  const normalizedFact = String(factText || "").trim().toLowerCase();
  const normalizedTranscript = String(transcriptText || "").trim().toLowerCase();

  if (!normalizedFact) {
    return true;
  }

  const hasTemporarySignal =
    /\b(today|tonight|tomorrow|this morning|this afternoon|this evening|this weekend|later today)\b/.test(normalizedFact) ||
    /\b(plan|plans|planning|going to|gonna|will)\b/.test(normalizedFact);

  const likelySingleDayPlan =
    category === "relationship_context" &&
    recommendation === "approve" &&
    /\b(plan|plans|going golfing|go golfing|skip|do|visit|call|text|meet)\b/.test(normalizedFact);

  return hasTemporarySignal || likelySingleDayPlan || /\b(today|tonight|tomorrow)\b/.test(normalizedTranscript);
}

function isMetaConversationCandidate(factText, category, transcriptText, transcriptLooksLikeMetaMemoryTalk = false) {
  const normalizedFact = String(factText || "").trim().toLowerCase();
  const normalizedTranscript = String(transcriptText || "").trim().toLowerCase();

  if (!normalizedFact) {
    return true;
  }

  const blockedFactPatterns = [
    /\binterested in family member names\b/,
    /\bprefers specific questions about family members\b/,
    /\bmessage was casual chit-chat\b/,
    /\bclarified that .* casual chit-chat\b/,
    /\blocation discussed was\b/,
    /\btesting conversational style\b/,
    /\bprivacy practices\b/,
    /\bexample question\b/,
    /\bquestion i could ask\b/,
    /\bcurrent weather details\b/,
  ];

  if (blockedFactPatterns.some((pattern) => pattern.test(normalizedFact))) {
    return true;
  }

  const transcriptMetaPatterns = [
    /\bexample question\b/,
    /\btest this out\b/,
    /\btrying to work and improve you\b/,
    /\bmaking you sound more like a human\b/,
    /\bhow strict we are with sending data\b/,
    /\bfamily member name\b/,
    /\bcasual chit-chat\b/,
    /\bjust chit-chatting\b/,
    /\bquestion more specific\b/,
  ];

  const factMetaPatterns = [
    /\binterested in\b/,
    /\bprefers\b/,
    /\bcasual chit-chat\b/,
    /\blocation discussed\b/,
    /\bprivacy\b/,
    /\bconversation\b/,
    /\btesting\b/,
  ];

  if (transcriptLooksLikeMetaMemoryTalk && factMetaPatterns.some((pattern) => pattern.test(normalizedFact))) {
    return true;
  }

  if (transcriptMetaPatterns.some((pattern) => pattern.test(normalizedTranscript)) && factMetaPatterns.some((pattern) => pattern.test(normalizedFact))) {
    return true;
  }

  if (
    category === "relationship_context" &&
    /\bwaterford, pa\b/.test(normalizedFact) &&
    /\bthe one we talked about\b|\bwaterford, pa\b/.test(normalizedTranscript)
  ) {
    return true;
  }

  return false;
}

function isMetaMemoryConversation(transcriptText) {
  const normalizedTranscript = String(transcriptText || "").trim().toLowerCase();
  if (!normalizedTranscript) {
    return false;
  }

  return [
    /\bexample question\b/,
    /\btest this out\b/,
    /\btrying to work and improve you\b/,
    /\bmaking you sound more like a human\b/,
    /\bhow strict we are with sending data\b/,
    /\bfamily member name\b/,
    /\bcasual chit-chat\b/,
    /\bjust chit-chatting\b/,
    /\bquestion more specific\b/,
  ].some((pattern) => pattern.test(normalizedTranscript));
}

function isAssistantIdentityFact(factText) {
  const normalized = String(factText || "").trim().toLowerCase();
  return (
    normalized.includes("assistant's name is") ||
    normalized.includes("assistants name is") ||
    normalized.includes("name for the assistant") ||
    normalized.includes("call the assistant") ||
    normalized.includes("assistant is called")
  );
}

function isUserIdentityFact(factText) {
  const normalized = String(factText || "").trim().toLowerCase();
  return (
    normalized.includes("user's name is") ||
    normalized.includes("users name is") ||
    normalized.includes("call the user") ||
    normalized.includes("identified as")
  );
}

function normalizeSpeechInput(text) {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[`*_#>]+/g, " ")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "";
  }

  return /[.!?]"?$/.test(normalized) ? normalized : `${normalized}.`;
}

function buildFactFingerprint(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/^[Tt]he\s+/, "")
    .replace(/\buser's\b/g, "user")
    .replace(/\bassistant's\b/g, "assistant")
    .replace(/\bthe user's\b/g, "user")
    .replace(/\bthe assistant's\b/g, "assistant")
    .replace(/\bhas a routine of\b/g, "follows a routine")
    .replace(/\bworkout routine\b/g, "routine")
    .replace(/\blifting weights\b/g, "lift weights")
    .replace(/\blikes to lift weights\b/g, "lift weights")
    .replace(/\btypically\b/g, "")
    .replace(/\bfour days a week\b/g, "4 days a week")
    .replace(/[.?!]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();

  if (!normalized) {
    return "";
  }

  if (/\bname is mira\b/.test(normalized)) {
    return "assistant:name:mira";
  }

  const userNameMatch = normalized.match(/\bname is ([a-z][a-z0-9' -]{0,39})$/);
  if (userNameMatch && /\buser\b/.test(normalized)) {
    return `user:name:${userNameMatch[1].trim()}`;
  }

  if (/\b4 days a week\b/.test(normalized) && /\broutine\b/.test(normalized)) {
    return "user:routine:4-days-week";
  }

  if (/\blift weights\b/.test(normalized)) {
    return "user:preference:lift-weights";
  }

  return normalized;
}

function extractResponseText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const textParts = [];

  for (const item of response?.output || []) {
    if (!Array.isArray(item?.content)) {
      continue;
    }

    for (const contentItem of item.content) {
      if (typeof contentItem?.text === "string" && contentItem.text.trim()) {
        textParts.push(contentItem.text.trim());
      }
    }
  }

  return textParts.join("\n\n").trim();
}

async function composeExternalLookupResponse({
  question,
  lookupPlan,
  rawText,
  citations,
  webSearches,
  evidence,
  extraction,
}) {
  const resolvedEvidence = evidence || buildFallbackEvidenceGrade({ citations, webSearches, rawText });
  const resolvedExtraction =
    extraction ||
    buildFallbackAnswerExtraction({
      question,
      lookupPlan,
      rawText,
      citations,
      webSearches,
      evidence: resolvedEvidence,
    });
  const compactedText = compactExternalLookupAnswer(rawText);
  const answerStatus = determineLookupAnswerStatus({
    lookupPlan,
    evidence: resolvedEvidence,
    extraction: resolvedExtraction,
    compactedText,
  });
  const fallbackComposition = buildLookupAnswerFallback({
    question,
    lookupPlan,
    compactedText,
    citations,
    webSearches,
    answerStatus,
    evidence: resolvedEvidence,
    extraction: resolvedExtraction,
  });

  if (
    needsLookupAnswerFallback(question, compactedText, lookupPlan.questionKind) ||
    answerStatus !== "answered"
  ) {
    return {
      ...fallbackComposition,
      evidence: resolvedEvidence,
      extraction: resolvedExtraction,
    };
  }

  let modelComposition = null;
  try {
    modelComposition = await composeExternalLookupAnswerWithModel.call(this, {
      question,
      lookupPlan,
      compactedText,
      citations,
    });
  } catch {
    modelComposition = null;
  }

  if (!modelComposition) {
    return {
      ...fallbackComposition,
      evidence: resolvedEvidence,
      extraction: resolvedExtraction,
    };
  }

  return {
    displayAnswer:
      resolvedExtraction.displayAnswer ||
      modelComposition.displayAnswer ||
      fallbackComposition.displayAnswer,
    spokenAnswer:
      resolvedExtraction.spokenAnswer ||
      modelComposition.spokenAnswer ||
      fallbackComposition.spokenAnswer,
    answerStatus: preferComposedAnswerStatus(
      modelComposition.answerStatus,
      answerStatus,
      resolvedExtraction
    ),
    showSources:
      typeof modelComposition.showSources === "boolean"
        ? modelComposition.showSources
        : fallbackComposition.showSources,
    evidence: resolvedEvidence,
    extraction: resolvedExtraction,
  };
}

function compactExternalLookupAnswer(text) {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .trim();

  if (!normalized) {
    return "";
  }

  const sourceLineMatch = normalized.match(/Current sources checked:.*$/im);
  const sourceLine = sourceLineMatch?.[0]?.trim() || "";
  const bodyWithoutSource = sourceLine
    ? normalized.slice(0, sourceLineMatch.index).trim()
    : normalized;

  const paragraphs = bodyWithoutSource
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  let mainBody = paragraphs[0] || bodyWithoutSource;
  mainBody = stripVerboseLookupFormatting(mainBody);

  return mainBody.trim();
}

function needsLookupAnswerFallback(question, text, questionKind = "other") {
  const normalizedQuestion = String(question || "").trim().toLowerCase();
  const normalizedText = String(text || "").trim();
  const normalizedBody = normalizedText
    .replace(/Current sources checked:.*$/im, "")
    .trim();

  if (!normalizedBody) {
    return true;
  }

  if (/^Current sources checked:/i.test(normalizedBody)) {
    return true;
  }

  const lineCount = normalizedBody.split("\n").filter(Boolean).length;
  const wordCount = normalizedBody.split(/\s+/).filter(Boolean).length;
  const looksLikeHeadingOnly =
    /^#{1,6}\s*\[.*\]\(.*\)\s*$/m.test(normalizedBody) ||
    /^\[.*\]\(.*\)\s*$/m.test(normalizedBody);
  const lacksAnswerVerbs =
    !/\b(open|closed|hours|price|trading|market cap|temperature|rain|showers|cloudy|sunny|private|public)\b/i.test(normalizedBody);
  const isOpenHoursQuestion = /\b(open|closed|hours)\b/.test(normalizedQuestion);

  if (looksLikeHeadingOnly) {
    return true;
  }

  if (isOpenHoursQuestion && wordCount <= 12 && lacksAnswerVerbs) {
    return true;
  }

  if (lineCount <= 2 && wordCount <= 8 && lacksAnswerVerbs) {
    return true;
  }

  if (questionKind === "market_price" && wordCount > 45) {
    return true;
  }

  if (
    questionKind === "weather" &&
    wordCount > 55 &&
    !/\b\d{2,3}°f\b|\b\d{1,2}°c\b|\bhigh\b|\blow\b|\bchance of\b/i.test(normalizedBody)
  ) {
    return true;
  }

  return false;
}

function buildLookupAnswerFallback({
  question,
  lookupPlan,
  compactedText,
  citations,
  webSearches,
  answerStatus = "partial",
  evidence = null,
  extraction = null,
}) {
  const businessName =
    extractBusinessNameFromCitations(citations) ||
    extractBusinessNameFromSearches(webSearches) ||
    "that place";
  const assumedPlace = inferAssumedPlace(lookupPlan, businessName);
  const questionKind = lookupPlan?.questionKind || inferQuestionKindFromQuestion(question);
  const resolutionStatus = lookupPlan?.resolutionStatus || "unresolved";
  const answerExtractability = extraction?.answerExtractability || "insufficient";
  const resultTopicMatch = extraction?.resultTopicMatch || "medium";

  if (answerStatus === "needs_clarification") {
    const displayAnswer =
      questionKind === "hours" || questionKind === "weather"
        ? "I need the golf course name or your location to answer that confidently."
        : "I need a little more detail before I can answer that confidently.";
    return {
      displayAnswer,
      spokenAnswer: displayAnswer,
      answerStatus,
      showSources: false,
    };
  }

  if (questionKind === "hours") {
    const officialDomain = findOfficialDomain(webSearches);
    const displayAnswer = officialDomain
      ? `I found ${assumedPlace}, but I still can't confirm whether it is open today from the sources I found. The best next check is the official site at ${officialDomain}.`
      : `I found ${assumedPlace}, but I still can't confirm whether it is open today from the sources I found.`;
    return {
      displayAnswer,
      spokenAnswer: displayAnswer,
      answerStatus: "uncertain",
      showSources: citations.length > 0 && evidence?.evidenceStatus !== "missing",
    };
  }

  if (questionKind === "weather") {
    const placeLabel = formatLookupPlaceLabel(lookupPlan, assumedPlace, businessName);
    const displayAnswer =
      resolutionStatus === "ambiguous"
        ? "I need the golf course name or your location to answer that confidently."
        : citations.length
          ? `I couldn't confidently pin down the weather for ${placeLabel} from the sources I found.`
          : `I couldn't find a reliable weather result for ${placeLabel} yet.`;
    return {
      displayAnswer,
      spokenAnswer: displayAnswer,
      answerStatus:
        resolutionStatus === "ambiguous"
          ? "needs_clarification"
          : displayAnswer.startsWith("I couldn't")
            ? "uncertain"
            : answerStatus,
      showSources: citations.length > 0 && evidence?.evidenceStatus !== "missing",
    };
  }

  if (questionKind === "sports" || questionKind === "news") {
    const displayAnswer =
      answerExtractability === "off_topic" || resultTopicMatch === "low"
        ? "I found results, but they don't clearly match what you asked, so I don't want to guess."
        : answerExtractability === "insufficient"
          ? `I found results for that, but they still don't clearly answer your ${questionKind === "sports" ? "sports" : "news"} question.`
          : compactedText || "I found something, but I couldn't turn it into a clean answer yet.";
    return {
      displayAnswer,
      spokenAnswer: displayAnswer,
      answerStatus,
      showSources: citations.length > 0 && evidence?.evidenceStatus !== "missing",
    };
  }

  if (questionKind === "market_price") {
    const displayAnswer = compactedText || "I found current market data, but I couldn't shape it into a short answer yet.";
    return {
      displayAnswer,
      spokenAnswer: displayAnswer,
      answerStatus,
      showSources: citations.length > 0 && evidence?.evidenceStatus !== "missing",
    };
  }

  const displayAnswer = compactedText || "I found something, but I couldn't shape it into a confident answer yet.";
  return {
    displayAnswer,
    spokenAnswer: displayAnswer,
    answerStatus,
    showSources: citations.length > 0 && evidence?.evidenceStatus !== "missing",
  };
}

function stripVerboseLookupFormatting(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const keptLines = [];

  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      break;
    }

    if (/^(Hourly Forecast|Current Conditions|Stock market information|Weather for )/i.test(line)) {
      break;
    }

    if (/^[-*]\s/.test(line)) {
      break;
    }

    keptLines.push(line);
  }

  const compact = keptLines.join(" ").replace(/\s+/g, " ").trim();
  return compact || "";
}

function extractBusinessNameFromCitations(citations) {
  for (const citation of citations || []) {
    const title = String(citation?.title || "").trim();
    if (!title) {
      continue;
    }

    const cleaned = title
      .replace(/^The Ridge FAQ'?s\s*-\s*/i, "")
      .replace(/\s+[|:-]\s+.*$/, "")
      .trim();

    if (cleaned) {
      return cleaned;
    }
  }

  return "";
}

function extractBusinessNameFromSearches(webSearches) {
  for (const search of webSearches || []) {
    for (const source of search?.sources || []) {
      const hostname = formatCitationDomain(source?.url);
      if (!hostname) {
        continue;
      }

      if (!/google\.com|wikipedia\.org|restaurantmenuprice\.com/i.test(hostname)) {
        return hostname.replace(/\.(com|net|org|io|golf)$/i, "").replace(/[-.]/g, " ").trim();
      }
    }
  }

  return "";
}

function findOfficialDomain(webSearches) {
  for (const search of webSearches || []) {
    for (const source of search?.sources || []) {
      const hostname = formatCitationDomain(source?.url);
      if (!hostname) {
        continue;
      }

      if (/google\.com|wikipedia\.org|restaurantmenuprice\.com|yellowpages\.com|1golf\.eu|pga\.com|golfify\.io|grassy\.golf|driving-ranges\.com/i.test(hostname)) {
        continue;
      }

      return hostname;
    }
  }

  return "";
}

function inferAssumedPlace(lookupPlan, businessName) {
  const enrichedEntity = String(lookupPlan?.queryEnrichment?.entity || "").trim();
  const enrichedLocation = String(lookupPlan?.queryEnrichment?.location || "").trim();
  if (isEntityLikePlaceLabel(enrichedEntity) && enrichedLocation) {
    return `${enrichedEntity} in ${enrichedLocation}`;
  }

  const recentTurns = lookupPlan?.lookupContext?.recentTurns || [];

  for (const turn of recentTurns) {
    const userText = String(turn?.user || "").trim();
    if (isEntityLikePlaceLabel(userText)) {
      return userText;
    }
  }

  const approvedFacts = lookupPlan?.lookupContext?.approvedFacts || [];
  for (const fact of approvedFacts) {
    const match = String(fact || "").match(/^(.+?)\s+is located in\s+(.+?)\.?$/i);
    if (match) {
      return `${match[1]} in ${match[2]}`;
    }
  }

  return businessName;
}

function formatLookupPlaceLabel(lookupPlan, assumedPlace, businessName) {
  const enrichedLocation = String(lookupPlan?.queryEnrichment?.location || "").trim();
  const enrichedEntity = String(lookupPlan?.queryEnrichment?.entity || "").trim();
  if (isEntityLikePlaceLabel(enrichedEntity) && enrichedLocation) {
    return `${enrichedEntity} in ${enrichedLocation}`;
  }

  const normalizedAssumedPlace = String(assumedPlace || "").trim();
  if (isEntityLikePlaceLabel(normalizedAssumedPlace)) {
    return normalizedAssumedPlace;
  }

  if (enrichedLocation) {
    return enrichedLocation;
  }

  return String(businessName || "that place").trim();
}

function buildSourceAttributionLine(citations) {
  const sourceLabels = [...new Set(
    citations
      .slice(0, 3)
      .map((citation) => formatCitationLabel(citation))
      .filter(Boolean)
  )];

  if (!sourceLabels.length) {
    return "";
  }

  if (sourceLabels.length === 1) {
    return `Current sources checked: ${sourceLabels[0]}.`;
  }

  if (sourceLabels.length === 2) {
    return `Current sources checked: ${sourceLabels[0]} and ${sourceLabels[1]}.`;
  }

  return `Current sources checked: ${sourceLabels[0]}, ${sourceLabels[1]}, and ${sourceLabels[2]}.`;
}

function formatCitationLabel(citation) {
  const title = String(citation?.title || "").trim();
  const domain = formatCitationDomain(citation?.url);

  if (title && domain) {
    return `${title} (${domain})`;
  }

  return title || domain;
}

function formatCitationDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function extractResponseCitations(response) {
  const citations = [];
  const seen = new Set();

  for (const item of response?.output || []) {
    if (!Array.isArray(item?.content)) {
      continue;
    }

    for (const contentItem of item.content) {
      for (const annotation of contentItem?.annotations || []) {
        if (annotation?.type !== "url_citation" || !annotation.url) {
          continue;
        }

        const key = `${annotation.url}::${annotation.title || ""}`;
        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        citations.push({
          title: annotation.title || annotation.url,
          url: annotation.url,
        });
      }
    }
  }

  return citations;
}

function extractWebSearches(response) {
  const searches = [];

  for (const item of response?.output || []) {
    if (item?.type !== "web_search_call") {
      continue;
    }

    searches.push({
      id: item.id || "",
      status: item.status || "completed",
      action: item.action?.type || "",
      query: item.action?.query || "",
      sources: Array.isArray(item.action?.sources)
        ? item.action.sources
            .filter((source) => source?.type === "url" && source.url)
            .map((source) => ({ url: source.url }))
        : [],
    });
  }

  return searches;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeLookupQuestionKind(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  return ["weather", "market_price", "hours", "news", "sports", "general_chat", "other"].includes(normalized)
    ? normalized
    : "other";
}

function normalizeLookupAnswerMode(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  return ["model_only", "lookup_or_model", "lookup_required"].includes(normalized)
    ? normalized
    : "lookup_or_model";
}

function normalizeAnswerStatus(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  return ["answered", "partial", "uncertain", "needs_clarification"].includes(normalized)
    ? normalized
    : "partial";
}

function normalizeAssistantAnswerText(value) {
  const normalized = String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/Current sources checked:.*$/gim, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "";
  }

  return /[.!?]"?$/.test(normalized) ? normalized : `${normalized}.`;
}

function inferQuestionKindFromQuestion(question) {
  const normalizedQuestion = String(question || "").toLowerCase();
  if (/\bweather|forecast|temperature|rain|snow|wind\b/.test(normalizedQuestion)) {
    return "weather";
  }

  if (/\bstock|price|market cap|earnings|after-hours\b/.test(normalizedQuestion)) {
    return "market_price";
  }

  if (/\bopen|closed|hours\b/.test(normalizedQuestion)) {
    return "hours";
  }

  if (/\bnews|headline|breaking\b/.test(normalizedQuestion)) {
    return "news";
  }

  if (/\bscore|schedule|standings|record\b/.test(normalizedQuestion)) {
    return "sports";
  }

  if (/\bhi|hello|hey|how are you|thanks|thank you\b/.test(normalizedQuestion)) {
    return "general_chat";
  }

  return "other";
}

function buildFallbackEvidenceGrade({ citations, webSearches, rawText }) {
  const citationCount = Array.isArray(citations) ? citations.length : 0;
  const searchCount = Array.isArray(webSearches) ? webSearches.length : 0;
  const normalizedText = String(rawText || "").trim();

  if (!citationCount && !searchCount) {
    return {
      evidenceStatus: "missing",
      supportsDirectAnswer: false,
      confidence: 0.9,
    };
  }

  if (!normalizedText) {
    return {
      evidenceStatus: "weak",
      supportsDirectAnswer: false,
      confidence: 0.7,
    };
  }

  return {
    evidenceStatus: citationCount > 0 ? "weak" : "missing",
    supportsDirectAnswer: citationCount > 0 && normalizedText.length > 40,
    confidence: citationCount > 0 ? 0.55 : 0.8,
  };
}

function buildFallbackAnswerExtraction({
  question,
  lookupPlan,
  rawText,
  citations,
  webSearches,
  evidence,
}) {
  const compactedText = compactExternalLookupAnswer(rawText);
  const questionKind = lookupPlan?.questionKind || inferQuestionKindFromQuestion(question);
  const evidenceStatus = evidence?.evidenceStatus || "missing";
  const retrievalStatus =
    (Array.isArray(citations) && citations.length) || (Array.isArray(webSearches) && webSearches.length)
      ? "results_found"
      : "no_results";
  const hasDirectAnswer = textLooksLikeDirectLookupAnswer(compactedText, questionKind);

  return {
    retrievalStatus,
    answerExtractability:
      retrievalStatus === "no_results"
        ? "insufficient"
        : hasDirectAnswer
          ? questionKind === "news"
            ? "summary_answer"
            : "direct_answer"
          : evidenceStatus === "mismatched"
            ? "off_topic"
            : "insufficient",
    resultTopicMatch: evidenceStatus === "mismatched" ? "low" : hasDirectAnswer ? "high" : "medium",
    displayAnswer: hasDirectAnswer ? compactedText : "",
    spokenAnswer: hasDirectAnswer ? compactedText : "",
  };
}

function determineLookupAnswerStatus({ lookupPlan, evidence, extraction, compactedText = "" }) {
  const resolutionStatus = lookupPlan?.resolutionStatus || "unresolved";
  const questionKind = lookupPlan?.questionKind || "other";
  const evidenceStatus = evidence?.evidenceStatus || "missing";
  const supportsDirectAnswer = Boolean(evidence?.supportsDirectAnswer);
  const answerExtractability = extraction?.answerExtractability || "insufficient";
  const resultTopicMatch = extraction?.resultTopicMatch || "medium";
  const hasDirectAnswer = textLooksLikeDirectLookupAnswer(compactedText, questionKind);
  const asksForClarification = textLooksLikeClarificationRequest(compactedText);

  if (resolutionStatus === "ambiguous") {
    return "needs_clarification";
  }

  if (asksForClarification) {
    return "needs_clarification";
  }

  if (answerExtractability === "off_topic" || resultTopicMatch === "low") {
    return resolutionStatus === "resolved" ? "uncertain" : "needs_clarification";
  }

  if (answerExtractability === "insufficient") {
    return resolutionStatus === "resolved" ? "uncertain" : "needs_clarification";
  }

  if (answerExtractability === "summary_answer" && questionKind === "news") {
    return "answered";
  }

  if (hasDirectAnswer) {
    if (evidenceStatus === "mismatched") {
      return resolutionStatus === "resolved" ? "uncertain" : "needs_clarification";
    }

    if (questionKind === "market_price") {
      return "answered";
    }

    return evidenceStatus === "weak" ? "partial" : "answered";
  }

  if (evidenceStatus === "missing") {
    return resolutionStatus === "resolved" ? "uncertain" : "needs_clarification";
  }

  if (evidenceStatus === "mismatched") {
    return resolutionStatus === "resolved" ? "uncertain" : "needs_clarification";
  }

  if (!supportsDirectAnswer) {
    return resolutionStatus === "resolved" ? "uncertain" : "needs_clarification";
  }

  if (evidenceStatus === "weak") {
    return "partial";
  }

  return "answered";
}

function normalizeRetrievalStatus(value, fallback = "results_found") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  return ["results_found", "no_results"].includes(normalized) ? normalized : fallback;
}

function normalizeAnswerExtractability(value, fallback = "insufficient") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  return ["direct_answer", "summary_answer", "insufficient", "off_topic"].includes(normalized)
    ? normalized
    : fallback;
}

function normalizeResultTopicMatch(value, fallback = "medium") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  return ["high", "medium", "low"].includes(normalized) ? normalized : fallback;
}

function preferComposedAnswerStatus(modelStatus, computedStatus, extraction) {
  const normalizedModelStatus = normalizeAnswerStatus(modelStatus);
  const normalizedComputedStatus = normalizeAnswerStatus(computedStatus);
  const extractability = extraction?.answerExtractability || "insufficient";

  if (
    normalizedComputedStatus === "answered" &&
    ["direct_answer", "summary_answer"].includes(extractability) &&
    normalizedModelStatus !== "needs_clarification"
  ) {
    return normalizedComputedStatus;
  }

  return normalizedModelStatus || normalizedComputedStatus;
}

function textLooksLikeClarificationRequest(text) {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.startsWith("i need ") ||
    normalized.startsWith("can you clarify") ||
    normalized.startsWith("i couldn't confidently") ||
    normalized.startsWith("i could not confidently")
  );
}

function textLooksLikeDirectLookupAnswer(text, questionKind = "other") {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return false;
  }

  const lower = normalized.toLowerCase();
  if (textLooksLikeClarificationRequest(lower)) {
    return false;
  }

  if (questionKind === "market_price") {
    return /\$\s?\d[\d,.]*/.test(normalized) || /\btrading at\b|\bpriced at\b|\bup\b|\bdown\b/i.test(normalized);
  }

  if (questionKind === "sports") {
    return /\b\d+\s*[-–]\s*\d+\b/.test(normalized) || /\b(inning|quarter|period|final|leading|trailing|tied)\b/i.test(normalized);
  }

  if (questionKind === "news") {
    return normalized.split(/\s+/).length >= 12 && /\b(openai|announced|said|released|launch|partnership|funding|deal|report)\b/i.test(normalized);
  }

  if (questionKind === "weather") {
    return /\b(cloudy|sunny|rain|showers|storms?|forecast|highs?|lows?|°f|°c)\b/i.test(lower);
  }

  if (questionKind === "hours") {
    return /\b(open|closed|can't confirm|cannot confirm|hours)\b/i.test(lower);
  }

  return normalized.split(/\s+/).length >= 8;
}

function normalizeEvidenceStatus(value, fallback = "weak") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  return ["strong", "weak", "mismatched", "missing"].includes(normalized) ? normalized : fallback;
}

function isEntityLikePlaceLabel(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return false;
  }

  if (/[?]/.test(normalized)) {
    return false;
  }

  if (/^(what|what's|whats|where|when|why|how|is|are|do|does|can|could|would|should|tell|check)\b/i.test(normalized)) {
    return false;
  }

  return true;
}
