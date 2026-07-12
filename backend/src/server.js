import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { buildContextPackage } from "./context.js";
import {
  buildExternalLookupPlan,
  composeExternalLookupResult,
  performExternalLookupRetrieval,
} from "./externalLookupService.js";
import {
  buildLookupCacheDescriptor,
  buildLookupCacheEntry,
  getLookupCacheAgeMs,
  isLookupCacheEntryExpired,
} from "./lookupCache.js";
import { memoryScheduler } from "./memoryScheduler.js";
import { provider } from "./provider/index.js";
import {
  buildSelfKnowledgeDebugState,
  buildSelfKnowledgeResponse,
} from "./selfKnowledgeService.js";
import { store } from "./store.js";
import { summaryScheduler } from "./summaryScheduler.js";

export const app = Fastify({ logger: true });
const activeTurns = new Map();

await app.register(cors, {
  origin: config.corsOrigin,
});

await app.register(multipart, {
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
});

app.get("/api/health", async () => ({
  ok: true,
  providerConfigured: provider.isConfigured(),
}));

app.post("/api/voice/cancel", async (request, reply) => {
  const { sessionId } = request.body || {};
  if (!sessionId) {
    reply.code(400);
    return { error: "sessionId is required." };
  }

  const active = activeTurns.get(sessionId);
  if (active) {
    active.abortController.abort();
    activeTurns.delete(sessionId);
  }

  return { cancelled: true };
});

app.post("/api/voice/retry", async (request, reply) => {
  const { sessionId = "default-session", turnId = randomUUID(), transcriptText = "" } = request.body || {};
  const lookupPrivacyMode =
    request.body?.lookupPrivacyMode === "balanced" || request.body?.lookupPrivacyMode === "strict"
      ? request.body.lookupPrivacyMode
      : null;

  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": config.corsOrigin,
    Vary: "Origin",
  });
  reply.raw.flushHeaders?.();

  const sendEvent = (event) => {
    reply.raw.write(`${JSON.stringify(event)}\n`);
  };

  if (!transcriptText.trim()) {
    sendEvent({
      type: "error",
      stage: "stt",
      turnId,
      message: "Retry requires a previous transcript.",
    });
    reply.raw.end();
    return;
  }

  const abortController = new AbortController();
  const existing = activeTurns.get(sessionId);
  if (existing) {
    existing.abortController.abort();
    activeTurns.delete(sessionId);
  }

  activeTurns.set(sessionId, {
    turnId,
    abortController,
  });

  sendEvent({
    type: "transcript",
    text: transcriptText,
    turnId,
  });

  const timings = {
    captureEnd: null,
    sttComplete: null,
    chatFirstToken: null,
    chatFinalToken: null,
    ttsComplete: null,
    playbackStart: null,
  };

  await runAssistantTurn({
    sessionId,
    turnId,
    transcriptText,
    lookupPrivacyMode,
    transcriptMimeType: "retry/text",
    audioBytes: 0,
    abortController,
    timings,
    sendEvent,
    reply,
  });
});

app.get("/api/debug/turns", async () => ({
  turns: store.getDebugTurns(),
  rollingSummary: store.getRollingSummary(),
  approvedFacts: store.getApprovedFacts(),
}));

app.get("/api/debug/self-knowledge", async () => ({
  selfKnowledge: buildSelfKnowledgeDebugState(),
}));

app.get("/api/memory", async () => ({
  candidateFacts: store.getCandidateFacts(),
  approvedFacts: store.getApprovedFacts(),
}));

app.post("/api/debug/external-lookup/preview", async (request, reply) => {
  const question = typeof request.body?.question === "string" ? request.body.question : "";
  const privacyMode =
    typeof request.body?.privacyMode === "string"
      ? request.body.privacyMode
      : config.externalLookupPrivacyMode;

  if (!question.trim()) {
    reply.code(400);
    return { error: "question is required." };
  }

  const contextPackage = buildContextPackage(question);
  return {
    preview: (
      await buildExternalLookupPlan(question, contextPackage, privacyMode)
    ).preview,
  };
});

app.post("/api/memory/candidates/:id/approve", async (request, reply) => {
  const approvedFact = store.approveCandidateFact(request.params.id);
  if (!approvedFact) {
    reply.code(404);
    return { error: "Pending candidate fact not found." };
  }

  return { approvedFact };
});

app.post("/api/memory/candidates/:id/reject", async (request, reply) => {
  const resolutionNote =
    request.body?.resolutionNote === "dismissed_by_user"
      ? "dismissed_by_user"
      : "rejected_by_user";
  const candidateFact = store.rejectCandidateFact(request.params.id, resolutionNote);
  if (!candidateFact) {
    reply.code(404);
    return { error: "Pending candidate fact not found." };
  }

  return { candidateFact };
});

app.delete("/api/memory/approved/:id", async (request, reply) => {
  const deleted = store.deleteApprovedFact(request.params.id);
  if (!deleted) {
    reply.code(404);
    return { error: "Approved fact not found." };
  }

  return { deleted: true };
});

app.get("/api/debug/turns/:id", async (request, reply) => {
  const turn = store.getTurnById(request.params.id);
  if (!turn) {
    reply.code(404);
    return { error: "Turn not found." };
  }

  return { turn };
});

app.post("/api/voice/turn", async (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": config.corsOrigin,
    Vary: "Origin",
  });
  reply.raw.flushHeaders?.();

  const startedAt = new Date();
  const abortController = new AbortController();
  let sessionId = "default-session";
  let activeTurnId = randomUUID();

  const sendEvent = (event) => {
    reply.raw.write(`${JSON.stringify(event)}\n`);
  };

  try {
    const file = await request.file();
    if (!file) {
      sendEvent({ type: "error", message: "Audio file is required." });
      reply.raw.end();
      return;
    }

    const fields = file.fields || {};
    sessionId = fields.sessionId?.value || sessionId;
    activeTurnId = fields.turnId?.value || activeTurnId;
    const lookupPrivacyMode =
      fields.lookupPrivacyMode?.value === "balanced" || fields.lookupPrivacyMode?.value === "strict"
        ? fields.lookupPrivacyMode.value
        : null;

    const existing = activeTurns.get(sessionId);
    if (existing) {
      existing.abortController.abort();
      activeTurns.delete(sessionId);
    }

    activeTurns.set(sessionId, {
      turnId: activeTurnId,
      abortController,
    });

    const audioBuffer = await file.toBuffer();
    const timings = {
      captureEnd: fields.captureEndedAt?.value || startedAt.toISOString(),
      sttComplete: null,
      chatFirstToken: null,
      chatFinalToken: null,
      ttsComplete: null,
      playbackStart: null,
    };

    sendEvent({ type: "status", phase: "transcribing", turnId: activeTurnId });

    const transcription = await provider.transcribe({
      audioBuffer,
      mimeType: file.mimetype,
      signal: abortController.signal,
    });

    timings.sttComplete = new Date().toISOString();

    if (!transcription.text) {
      const failedTurn = buildStoredTurn({
        id: activeTurnId,
        sessionId,
        transcriptText: "",
        assistantText: "",
        status: "stt_failed",
        contextPackage: buildContextPackage(""),
        timings,
        tokenUsage: {},
        failure: {
          stage: "stt",
          message: "Transcription was empty.",
        },
        transcriptMimeType: file.mimetype,
        audioBytes: audioBuffer.byteLength,
      });

      store.insertTurn(failedTurn);
      sendEvent({
        type: "error",
        stage: "stt",
        message: "Transcription was empty, so no turn was sent.",
      });
      reply.raw.end();
      activeTurns.delete(sessionId);
      return;
    }

    sendEvent({
      type: "transcript",
      text: transcription.text,
      turnId: activeTurnId,
    });
    await runAssistantTurn({
      sessionId,
      turnId: activeTurnId,
      transcriptText: transcription.text,
      lookupPrivacyMode,
      transcriptMimeType: file.mimetype,
      audioBytes: audioBuffer.byteLength,
      abortController,
      timings,
      sendEvent,
      reply,
    });
    return;
  } catch (error) {
    const isAbort = error.name === "AbortError";

    sendEvent({
      type: "error",
      stage: isAbort ? "cancelled" : "server",
      message: isAbort ? "Turn cancelled." : error.message,
    });
    reply.raw.end();
    activeTurns.delete(sessionId);
    return;
  }
});

async function runAssistantTurn({
  sessionId,
  turnId,
  transcriptText,
  lookupPrivacyMode,
  transcriptMimeType,
  audioBytes,
  abortController,
  timings,
  sendEvent,
  reply,
}) {
  try {
    const selfKnowledgeResponse = buildSelfKnowledgeResponse(transcriptText);
    const contextPackage = buildContextPackage(transcriptText, {
      selfKnowledge: selfKnowledgeResponse?.context || null,
      recentExplainability: selfKnowledgeResponse?.explainability || null,
    });
    const lookupPlan = selfKnowledgeResponse
      ? null
      : await buildExternalLookupPlan(transcriptText, contextPackage, lookupPrivacyMode);

    sendEvent({
      type: "context",
      preview: {
        ...contextPackage,
        ...(lookupPlan ? { externalLookup: lookupPlan.preview } : {}),
      },
      turnId,
    });

    let assistantText = "";
    let spokenAnswerText = "";
    let providerMetadata = buildProviderMetadata();
    let providerUsage = null;

    if (selfKnowledgeResponse) {
      assistantText = selfKnowledgeResponse.text;
      spokenAnswerText = selfKnowledgeResponse.text;
      timings.chatFirstToken = new Date().toISOString();
      sendEvent({ type: "text-delta", delta: assistantText, turnId });

      providerMetadata = buildProviderMetadata({
        provider: "local_self_knowledge",
        api: "local_self_knowledge",
        selfKnowledge: {
          status: "used",
          topic: selfKnowledgeResponse.topic,
          evidence: selfKnowledgeResponse.evidence,
          inference: selfKnowledgeResponse.inference,
          unknowns: selfKnowledgeResponse.unknowns,
          nextChecks: selfKnowledgeResponse.explainability?.nextChecks || [],
          answerMode: selfKnowledgeResponse.explainability?.answerMode || selfKnowledgeResponse.topic,
          latestTurnId: selfKnowledgeResponse.latestTurnId,
        },
        lookup: {
          status: "not_applicable",
          reason: "self_knowledge_answer",
          key: "",
          keyParts: null,
          ttlMs: 0,
        },
      });
    } else if (lookupPlan.shouldLookup) {
      sendEvent({ type: "status", phase: "researching", turnId });

      try {
        const cacheDescriptor = buildLookupCacheDescriptor(lookupPlan);
        let cacheMetadata = {
          status: cacheDescriptor.cacheable ? "miss" : "skipped",
          reason: cacheDescriptor.cacheable ? "not_checked" : cacheDescriptor.reason,
          key: cacheDescriptor.key || "",
          keyParts: cacheDescriptor.keyParts,
          ttlMs: cacheDescriptor.ttlMs || 0,
          ageMs: null,
          expiresAt: null,
          storedAt: null,
          tier: null,
        };
        let lookupArtifacts = null;

        if (cacheDescriptor.cacheable) {
          store.purgeExpiredLookupCacheEntries();
          const cachedEntry = store.getLookupCacheEntry(cacheDescriptor.key);

          if (cachedEntry && !isLookupCacheEntryExpired(cachedEntry)) {
            store.touchLookupCacheEntry(cacheDescriptor.key);
            cacheMetadata = {
              ...cacheMetadata,
              status: "hit",
              reason: "fresh_cached_artifacts",
              ageMs: getLookupCacheAgeMs(cachedEntry),
              expiresAt: cachedEntry.expires_at,
              storedAt: cachedEntry.created_at,
              tier: cachedEntry.extraction_json?.answerExtractability || null,
            };
            lookupArtifacts = {
              rawText: cachedEntry.retrieval_json?.rawText || "",
              citations: cachedEntry.citations_json || [],
              webSearches: cachedEntry.web_searches_json || [],
              usage: null,
            };
          } else if (cachedEntry) {
            cacheMetadata = {
              ...cacheMetadata,
              status: "expired",
              reason: "expired_cached_artifacts",
              ageMs: getLookupCacheAgeMs(cachedEntry),
              expiresAt: cachedEntry.expires_at,
              storedAt: cachedEntry.created_at,
            };
          } else {
            cacheMetadata.reason = "no_cached_artifacts";
          }
        }

        if (!lookupArtifacts) {
          const freshArtifacts = await performExternalLookupRetrieval({
            question: transcriptText,
            lookupPlan,
            signal: abortController.signal,
          });
          providerUsage = freshArtifacts.usage;
          lookupArtifacts = freshArtifacts;
          if (cacheDescriptor.cacheable) {
            cacheMetadata = {
              ...cacheMetadata,
              status: cacheMetadata.status === "expired" ? "expired_then_refreshed" : "miss_then_stored",
              reason: "fresh_lookup",
            };
          }
        }

        const lookupResult = await composeExternalLookupResult({
          question: transcriptText,
          lookupPlan,
          artifacts: lookupArtifacts,
        });

        assistantText = lookupResult.displayText || lookupResult.text;
        spokenAnswerText = lookupResult.spokenText || assistantText;
        timings.chatFirstToken = new Date().toISOString();
        sendEvent({ type: "text-delta", delta: assistantText, turnId });

        if (cacheMetadata.status !== "hit") {
          const cacheEntry = buildLookupCacheEntry({
            lookupPlan,
            artifacts: lookupArtifacts,
            evidence: lookupResult.evidence,
            extraction: lookupResult.extraction,
            answerStatus: lookupResult.answerStatus,
          });
          if (cacheEntry) {
            store.upsertLookupCacheEntry(cacheEntry);
            cacheMetadata = {
              ...cacheMetadata,
              status: "stored",
              reason: cacheEntry.cache_policy.reason,
              ttlMs: cacheEntry.cache_policy.ttlMs,
              ageMs: 0,
              expiresAt: cacheEntry.expires_at,
              storedAt: cacheEntry.created_at,
              tier: cacheEntry.cache_policy.tier,
            };
          } else if (cacheDescriptor.cacheable) {
            cacheMetadata = {
              ...cacheMetadata,
              status: "skipped",
              reason: "result_not_cacheable",
            };
          }
        } else if (cacheDescriptor.cacheable) {
          cacheMetadata = {
            ...cacheMetadata,
            reason: "fresh_cached_artifacts",
          };
        }

        providerMetadata = buildProviderMetadata({
          api: "responses",
          chatModel: config.externalLookupModel,
          lookup: {
            status: "used",
            requestedPrivacyMode: lookupPlan.requestedPrivacyMode,
            privacyMode: lookupPlan.privacyMode,
            contextMode: lookupPlan.contextMode,
            safeQuery: lookupPlan.query,
            queryEnrichment: lookupPlan.queryEnrichment,
            resolutionStatus: lookupPlan.resolutionStatus,
            resolutionConfidence: lookupPlan.resolutionConfidence,
            matchedSignals: lookupPlan.matchedSignals,
            questionKind: lookupPlan.questionKind,
            answerMode: lookupPlan.answerMode,
            needsResolution: lookupPlan.needsResolution,
            canUseLocalMemoryForResolution: lookupPlan.canUseLocalMemoryForResolution,
            decisionSource: lookupPlan.decisionSource,
            decisionConfidence: lookupPlan.decisionConfidence,
            redactions: lookupPlan.redactions,
            answerStatus: lookupResult.answerStatus || "answered",
            evidenceStatus: lookupResult.evidence?.evidenceStatus || null,
            evidenceConfidence: lookupResult.evidence?.confidence ?? null,
            supportsDirectAnswer: lookupResult.evidence?.supportsDirectAnswer ?? null,
            retrievalStatus: lookupResult.extraction?.retrievalStatus || null,
            answerExtractability: lookupResult.extraction?.answerExtractability || null,
            resultTopicMatch: lookupResult.extraction?.resultTopicMatch || null,
            displayText: assistantText,
            spokenText: spokenAnswerText,
            showSources: lookupResult.showSources !== false,
            citations: lookupResult.citations,
            webSearches: lookupResult.webSearches,
            retrievalSource: cacheMetadata.status === "hit" ? "cache" : "fresh_lookup",
            cache: cacheMetadata,
          },
        });
      } catch (error) {
        const cacheDescriptor = buildLookupCacheDescriptor(lookupPlan);
        providerMetadata = buildProviderMetadata({
          lookup: {
            status: "failed_then_fell_back",
            requestedPrivacyMode: lookupPlan.requestedPrivacyMode,
            privacyMode: lookupPlan.privacyMode,
            contextMode: lookupPlan.contextMode,
            safeQuery: lookupPlan.query,
            queryEnrichment: lookupPlan.queryEnrichment,
            resolutionStatus: lookupPlan.resolutionStatus,
            resolutionConfidence: lookupPlan.resolutionConfidence,
            matchedSignals: lookupPlan.matchedSignals,
            questionKind: lookupPlan.questionKind,
            answerMode: lookupPlan.answerMode,
            needsResolution: lookupPlan.needsResolution,
            canUseLocalMemoryForResolution: lookupPlan.canUseLocalMemoryForResolution,
            decisionSource: lookupPlan.decisionSource,
            decisionConfidence: lookupPlan.decisionConfidence,
            redactions: lookupPlan.redactions,
            error: error.message,
            cache: {
              status: cacheDescriptor.cacheable ? "lookup_failed" : "skipped",
              reason: error.message,
              key: cacheDescriptor.key || "",
              keyParts: cacheDescriptor.keyParts,
              ttlMs: cacheDescriptor.ttlMs || 0,
            },
          },
        });
      }
    } else {
      providerMetadata = buildProviderMetadata({
        lookup: {
          status: lookupPlan.enabled
            ? lookupPlan.providerReady
              ? "not_needed"
              : "provider_unavailable"
            : "disabled",
          requestedPrivacyMode: lookupPlan.requestedPrivacyMode,
          privacyMode: lookupPlan.privacyMode,
          contextMode: lookupPlan.contextMode,
          safeQuery: lookupPlan.query,
          queryEnrichment: lookupPlan.queryEnrichment,
          resolutionStatus: lookupPlan.resolutionStatus,
          resolutionConfidence: lookupPlan.resolutionConfidence,
          matchedSignals: lookupPlan.matchedSignals,
          questionKind: lookupPlan.questionKind,
          answerMode: lookupPlan.answerMode,
          needsResolution: lookupPlan.needsResolution,
          canUseLocalMemoryForResolution: lookupPlan.canUseLocalMemoryForResolution,
          decisionSource: lookupPlan.decisionSource,
          decisionConfidence: lookupPlan.decisionConfidence,
          redactions: lookupPlan.redactions,
          cache: {
            status: "not_applicable",
            reason: "lookup_not_used",
            key: "",
            keyParts: null,
            ttlMs: 0,
          },
        },
      });
    }

    if (!assistantText) {
      sendEvent({ type: "status", phase: "thinking", turnId });

      const chatResult = await provider.streamChat({
        contextPackage,
        signal: abortController.signal,
        onDelta(delta) {
          assistantText += delta;
          if (!timings.chatFirstToken) {
            timings.chatFirstToken = new Date().toISOString();
          }
          sendEvent({ type: "text-delta", delta, turnId });
        },
      });

      providerUsage = chatResult.usage || null;
    }

    timings.chatFinalToken = new Date().toISOString();
    sendEvent({ type: "status", phase: "speaking", turnId });

    let audioBase64 = null;
    let spokenText = "";
    let ttsFailure = null;
    const speechText = spokenAnswerText || assistantText;

    try {
      const speech = await provider.synthesizeSpeech({
        text: speechText,
        signal: abortController.signal,
      });

      timings.ttsComplete = new Date().toISOString();
      timings.playbackStart = timings.ttsComplete;
      audioBase64 = speech.audioBuffer.toString("base64");
      spokenText = speech.speechInput || "";
      sendEvent({ type: "playback-ready", turnId });
    } catch (error) {
      ttsFailure = {
        stage: "tts",
        message: error.message,
      };
    }

    const tokenUsage = {
      context: contextPackage.tokenBudget,
      provider: providerUsage,
    };

    const storedTurn = buildStoredTurn({
      id: turnId,
      sessionId,
      transcriptText,
      assistantText,
      status: ttsFailure ? "completed_with_tts_failure" : "completed",
      contextPackage,
      timings,
      tokenUsage,
      providerMetadata,
      spokenText,
      failure: ttsFailure,
      transcriptMimeType,
      audioBytes,
    });

    store.insertTurn(storedTurn);
    summaryScheduler.markTurnCompleted();
    memoryScheduler.queueFactExtraction({
      id: turnId,
      transcriptText,
      assistantText,
    });

    sendEvent({
      type: "turn-complete",
      turn: {
        id: turnId,
        sessionId,
        transcriptText,
        assistantText,
        displayText: assistantText,
        spokenAnswerText: speechText,
        timings,
        tokenUsage,
        provider: providerMetadata,
        spokenText,
        failure: ttsFailure,
        audioBase64,
        audioMimeType: "audio/mpeg",
      },
    });

    reply.raw.end();
    activeTurns.delete(sessionId);
  } catch (error) {
    const isAbort = error.name === "AbortError";

    sendEvent({
      type: "error",
      stage: isAbort ? "cancelled" : "server",
      turnId,
      message: isAbort ? "Turn cancelled." : error.message,
    });
    reply.raw.end();
    activeTurns.delete(sessionId);
  }
}

export async function startServer() {
  return app.listen({ port: config.port, host: config.host });
}

const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  startServer().catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}

function buildStoredTurn({
  id,
  sessionId,
  transcriptText,
  assistantText,
  status,
  contextPackage,
  timings,
  tokenUsage,
  providerMetadata,
  spokenText,
  failure,
  transcriptMimeType,
  audioBytes,
}) {
  return {
    id,
    session_id: sessionId,
    created_at: new Date().toISOString(),
    transcript_text: transcriptText,
    assistant_text: assistantText,
    turn_status: status,
    latency_json: JSON.stringify(timings),
    token_json: JSON.stringify(tokenUsage),
    provider_json: JSON.stringify(providerMetadata),
    failure_json: failure ? JSON.stringify(failure) : null,
    context_json: JSON.stringify({
      ...contextPackage,
      spokenText,
    }),
    transcript_mime_type: transcriptMimeType || "",
    audio_bytes: audioBytes,
  };
}

function buildProviderMetadata(overrides = {}) {
  return {
    provider: "openai",
    api: "chat_completions",
    sttModel: config.sttModel,
    chatModel: config.chatModel,
    ttsModel: config.ttsModel,
    ...overrides,
  };
}
