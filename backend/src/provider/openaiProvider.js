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
    const text = finalizeExternalLookupAnswer({
      question,
      lookupPlan,
      text: extractResponseText(response),
      citations,
      webSearches,
    });

    return {
      text,
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
        "Return JSON only with this shape:",
        '{"needsLookup":true,"reason":"short_machine_reason","signals":["signal"],"confidence":0.0}',
        "Use a short snake_case reason.",
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
    reason: String(parsed.reason || "").trim() || "model_only_is_probably_enough",
    matchedSignals: Array.isArray(parsed.signals)
      ? parsed.signals
          .map((signal) => String(signal || "").trim())
          .filter(Boolean)
          .slice(0, 6)
      : [],
    confidence: normalizeMemoryConfidence(parsed.confidence),
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

function applySourceAttribution(text, citations) {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) {
    return "";
  }

  if (!Array.isArray(citations) || !citations.length) {
    return normalizedText;
  }

  const attribution = buildSourceAttributionLine(citations);
  if (!attribution) {
    return normalizedText;
  }

  if (/checked current sources|current sources|source:/i.test(normalizedText)) {
    return normalizedText;
  }

  return `${normalizedText}\n\n${attribution}`;
}

function finalizeExternalLookupAnswer({ question, lookupPlan, text, citations, webSearches }) {
  const attributedText = applySourceAttribution(text, citations);
  const compactedText = compactExternalLookupAnswer(attributedText);

  if (!needsLookupAnswerFallback(question, compactedText)) {
    return compactedText;
  }

  return buildLookupAnswerFallback({
    question,
    lookupPlan,
    compactedText,
    citations,
    webSearches,
  });
}

function compactExternalLookupAnswer(text) {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
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

  return sourceLine ? `${mainBody}\n\n${sourceLine}`.trim() : mainBody.trim();
}

function needsLookupAnswerFallback(question, text) {
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

  return false;
}

function buildLookupAnswerFallback({ question, lookupPlan, compactedText, citations, webSearches }) {
  const normalizedQuestion = String(question || "").trim().toLowerCase();
  const businessName =
    extractBusinessNameFromCitations(citations) ||
    extractBusinessNameFromSearches(webSearches) ||
    "that place";
  const assumedPlace = inferAssumedPlace(lookupPlan, businessName);
  const sourceAttribution = buildSourceAttributionLine(citations) || "";

  if (/\b(open|closed|hours)\b/.test(normalizedQuestion)) {
    const officialDomain = findOfficialDomain(webSearches);
    const baseAnswer = officialDomain
      ? `I think you mean ${assumedPlace}. I could find it, but these sources do not clearly confirm whether it is open today. The best next check is the official site at ${officialDomain}.`
      : `I think you mean ${assumedPlace}. I could find it, but these sources do not clearly confirm whether it is open today.`;

    return sourceAttribution ? `${baseAnswer}\n\n${sourceAttribution}` : baseAnswer;
  }

  if (/\b(weather|forecast|temperature|rain|snow|wind)\b/.test(normalizedQuestion)) {
    const placeLabel = formatLookupPlaceLabel(lookupPlan, assumedPlace, businessName);
    const baseAnswer = citations.length
      ? `I couldn't confidently pin down tomorrow's weather for ${placeLabel} from the sources I found.`
      : `I couldn't find a reliable weather result for ${placeLabel} yet.`;

    return sourceAttribution ? `${baseAnswer}\n\n${sourceAttribution}` : baseAnswer;
  }

  return compactedText;
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
  const recentTurns = lookupPlan?.lookupContext?.recentTurns || [];

  for (const turn of recentTurns) {
    const userText = String(turn?.user || "").trim();
    if (userText) {
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
  if (enrichedEntity && enrichedLocation) {
    return `${enrichedEntity} in ${enrichedLocation}`;
  }

  const normalizedAssumedPlace = String(assumedPlace || "").trim();
  if (normalizedAssumedPlace) {
    return normalizedAssumedPlace;
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
