import { useEffect, useReducer, useRef, useState } from "react";

const API_BASE = "http://127.0.0.1:8787";
const SESSION_ID = "desktop-local-user";

const initialTurnState = {
  phase: "idle",
  activeTurnId: null,
  transcriptText: "",
  assistantText: "",
  timings: null,
  tokenUsage: null,
  contextPreview: null,
  provider: null,
  failure: null,
  playback: {
    status: "idle",
    message: "",
    hasAudio: false,
  },
  lastRecoverableTranscript: "",
  clientTimeline: {},
  cancellationReason: null,
};

function voiceReducer(state, action) {
  switch (action.type) {
    case "RESET_FOR_NEW_TURN":
      return {
        ...initialTurnState,
        phase: "listening",
        activeTurnId: action.turnId,
        clientTimeline: action.clientTimeline,
      };
    case "TURN_PHASE":
      if (!matchesTurn(state, action.turnId)) {
        return state;
      }

      return {
        ...state,
        phase: action.phase,
      };
    case "TRANSCRIPT_READY":
      if (!matchesTurn(state, action.turnId)) {
        return state;
      }

      return {
        ...state,
        transcriptText: action.text,
        lastRecoverableTranscript: action.text,
      };
    case "CONTEXT_READY":
      if (!matchesTurn(state, action.turnId)) {
        return state;
      }

      return {
        ...state,
        contextPreview: action.preview,
      };
    case "TEXT_DELTA":
      if (!matchesTurn(state, action.turnId)) {
        return state;
      }

      return {
        ...state,
        assistantText: `${state.assistantText}${action.delta}`,
      };
    case "TURN_COMPLETE":
      if (!matchesTurn(state, action.turnId)) {
        return state;
      }

      const isTtsFailure = action.turn.failure?.stage === "tts";

      return {
        ...state,
        phase:
          action.turn.failure && !isTtsFailure
            ? "error"
            : action.turn.audioBase64
              ? "speaking"
              : "idle",
        transcriptText: action.turn.transcriptText,
        assistantText: action.turn.assistantText,
        timings: action.turn.timings,
        tokenUsage: action.turn.tokenUsage,
        provider: action.turn.provider || null,
        failure: action.turn.failure ? normalizeFailure(action.turn.failure) : null,
      };
    case "PLAYBACK_READY":
      if (!matchesTurn(state, action.turnId)) {
        return state;
      }

      return {
        ...state,
        playback: {
          status: "ready",
          message: "Audio is ready. Attempting playback.",
          hasAudio: true,
        },
      };
    case "PLAYBACK_STARTED":
      if (!matchesTurn(state, action.turnId)) {
        return state;
      }

      return {
        ...state,
        phase: "speaking",
        playback: {
          status: "playing",
          message: "Playing spoken reply.",
          hasAudio: true,
        },
        clientTimeline: {
          ...state.clientTimeline,
          playbackStartedAt: action.at,
        },
      };
    case "PLAYBACK_STOPPED":
      if (!matchesTurn(state, action.turnId)) {
        return state;
      }

      return {
        ...state,
        phase: "idle",
        playback: {
          status: "stopped",
          message: action.message,
          hasAudio: action.hasAudio ?? state.playback.hasAudio,
        },
      };
    case "PLAYBACK_FAILED":
      if (!matchesTurn(state, action.turnId)) {
        return state;
      }

      return {
        ...state,
        phase: "idle",
        playback: {
          status: action.kind === "blocked" ? "blocked" : "failed",
          message: action.message,
          hasAudio: true,
        },
        clientTimeline: {
          ...state.clientTimeline,
          playbackFailedAt: action.at,
        },
      };
    case "CLIENT_TIMELINE":
      if (!matchesTurn(state, action.turnId)) {
        return state;
      }

      return {
        ...state,
        clientTimeline: {
          ...state.clientTimeline,
          ...action.patch,
        },
      };
    case "START_CANCELLING":
      return {
        ...state,
        phase: "cancelling",
        cancellationReason: action.reason,
      };
    case "CANCELLED":
      return {
        ...state,
        phase: "idle",
        playback: {
          status: "idle",
          message: "",
          hasAudio: false,
        },
        cancellationReason: action.reason,
      };
    case "TURN_ERROR":
      if (!matchesTurn(state, action.turnId, true)) {
        return state;
      }

      return {
        ...state,
        phase: action.failure.category === "cancelled" ? "idle" : "error",
        failure: action.failure.category === "cancelled" ? null : action.failure,
        cancellationReason:
          action.failure.category === "cancelled" ? action.failure.message : state.cancellationReason,
      };
    default:
      return state;
  }
}

export default function App() {
  const [mode, setMode] = useState("voice");
  const [lookupPrivacyMode, setLookupPrivacyMode] = useState("strict");
  const [history, setHistory] = useState([]);
  const [rollingSummary, setRollingSummary] = useState({ summary_text: "", updated_at: "" });
  const [candidateFacts, setCandidateFacts] = useState([]);
  const [approvedFacts, setApprovedFacts] = useState([]);
  const [selfKnowledgeState, setSelfKnowledgeState] = useState({
    overview: null,
    latestTurnExplanation: null,
    latestFailureExplanation: null,
  });
  const [turnExplainabilityById, setTurnExplainabilityById] = useState({});
  const [selectedExplainTurnId, setSelectedExplainTurnId] = useState("");
  const [appStatus, setAppStatus] = useState({
    backendReachable: false,
    providerConfigured: false,
    checkedAt: "",
  });
  const [providerCatalog, setProviderCatalog] = useState(null);
  const [modelCatalog, setModelCatalog] = useState(null);
  const [providerSettingsDraft, setProviderSettingsDraft] = useState({});
  const [providerSettingsState, setProviderSettingsState] = useState({
    saving: false,
    error: "",
    saved: false,
  });
  const [recorderReady, setRecorderReady] = useState(false);
  const [voiceState, dispatch] = useReducer(voiceReducer, initialTurnState);

  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const audioRef = useRef(null);
  const audioObjectUrlRef = useRef(null);
  const activeReaderRef = useRef(null);
  const activeFetchControllerRef = useRef(null);
  const currentTurnIdRef = useRef(null);
  const activeTurnSourceRef = useRef(null);
  const audioPayloadRef = useRef(null);
  const pendingRecordingStopRef = useRef(null);
  const memoryRefreshTimeoutsRef = useRef([]);

  useEffect(() => {
    loadDebugState();
    return () => {
      clearScheduledMemoryRefreshes();
      stopPlayback();
      abortActiveReader();
      abortActiveFetch();
      stopRecorderStream();
    };
  }, []);

  const isRecording = voiceState.phase === "listening";
  const isBusy = ["transcribing", "researching", "thinking", "speaking", "cancelling"].includes(voiceState.phase);
  const isPlayingAudio = voiceState.playback.status === "playing";
  const canPlayAudio = Boolean(audioPayloadRef.current?.audioBase64) && !isPlayingAudio;
  const retryTranscript = getRecoverableTranscript(voiceState, history);
  const canRetry =
    Boolean(retryTranscript) &&
    voiceState.phase !== "listening" &&
    voiceState.phase !== "transcribing" &&
    voiceState.phase !== "thinking" &&
    voiceState.phase !== "cancelling";
  const avatarState = AVATAR_STATES[voiceState.phase] || AVATAR_STATES.idle;
  const selectedExplainTurn = history.find((turn) => turn.id === selectedExplainTurnId) || null;
  const pendingFacts = candidateFacts.filter((fact) => fact.status === "pending");
  const resolvedFacts = candidateFacts.filter((fact) => fact.status !== "pending");
  const pendingFactGroups = MEMORY_REVIEW_GROUPS.map((group) => ({
    ...group,
    facts: pendingFacts.filter((fact) => (fact.recommendation || "review") === group.key),
  })).filter((group) => group.facts.length > 0);
  const hasProviderSettingsChanges = Object.keys(providerSettingsDraft).length > 0;

  async function loadDebugState() {
    try {
      const [healthResponse, debugResponse, memoryResponse, selfKnowledgeResponse, modelCatalogResponse] = await Promise.all([
        fetch(`${API_BASE}/api/health`),
        fetch(`${API_BASE}/api/debug/turns`),
        fetch(`${API_BASE}/api/memory`),
        fetch(`${API_BASE}/api/debug/self-knowledge`),
        fetch(`${API_BASE}/api/providers/catalog`),
      ]);
      if (!healthResponse.ok) {
        throw new Error(`Health fetch failed with ${healthResponse.status}.`);
      }
      if (!debugResponse.ok) {
        throw new Error(`Debug fetch failed with ${debugResponse.status}.`);
      }
      if (!memoryResponse.ok) {
        throw new Error(`Memory fetch failed with ${memoryResponse.status}.`);
      }
      if (!selfKnowledgeResponse.ok) {
        throw new Error(`Self-knowledge fetch failed with ${selfKnowledgeResponse.status}.`);
      }
      if (!modelCatalogResponse.ok) {
        throw new Error(`Model catalog fetch failed with ${modelCatalogResponse.status}.`);
      }

      const healthData = await healthResponse.json();
      const debugData = await debugResponse.json();
      const memoryData = await memoryResponse.json();
      const selfKnowledgeData = await selfKnowledgeResponse.json();
      const modelCatalogData = await modelCatalogResponse.json();
      const nextHistory = debugData.turns || [];
      setAppStatus({
        backendReachable: Boolean(healthData.ok),
        providerConfigured: Boolean((healthData.providerCatalog?.providers || []).some((item) => item.configured)),
        checkedAt: new Date().toISOString(),
      });
      setProviderCatalog(healthData.providerCatalog || null);
      setModelCatalog(modelCatalogData || null);
      setHistory(nextHistory);
      setRollingSummary(debugData.rollingSummary || { summary_text: "", updated_at: "" });
      setCandidateFacts(memoryData.candidateFacts || []);
      setApprovedFacts(memoryData.approvedFacts || []);
      setSelfKnowledgeState(
        selfKnowledgeData.selfKnowledge || { overview: null, latestTurnExplanation: null, latestFailureExplanation: null }
      );
      setSelectedExplainTurnId((current) => (current && !nextHistory.some((turn) => turn.id === current) ? "" : current));
    } catch (error) {
      setAppStatus({
        backendReachable: false,
        providerConfigured: false,
        checkedAt: new Date().toISOString(),
      });
      dispatch({
        type: "TURN_ERROR",
        turnId: currentTurnIdRef.current,
        failure: normalizeFailure({
          stage: "debug",
          message: error.message,
        }),
      });
    }
  }

  async function saveProviderSettings() {
    setProviderSettingsState({ saving: true, error: "", saved: false });
    try {
      const response = await fetch(`${API_BASE}/api/settings/providers`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routes: providerSettingsDraft }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `Provider settings save failed with ${response.status}.`);
      }

      setProviderCatalog(data.providerCatalog || null);
      setProviderSettingsDraft({});
      setProviderSettingsState({ saving: false, error: "", saved: true });
    } catch (error) {
      setProviderSettingsState({ saving: false, error: error.message, saved: false });
    }
  }

  function updateProviderSetting(route, field, value) {
    const routeSetting = providerCatalog?.routes?.[route] || {};
    const nextSelection = {
      ...(providerSettingsDraft[route] || routeSetting || {}),
      [field]: value,
    };

    if (field === "provider") {
      const modelCatalogProvider = (modelCatalog?.providers || []).find((item) => item.id === value);
      const providerDescriptor = (providerCatalog?.providers || []).find((item) => item.id === value);
      const compatibleModels = (modelCatalogProvider?.models || []).filter((model) =>
        model.capabilities?.includes(routeSetting.capability)
      );
      nextSelection.model =
        compatibleModels[0]?.id ||
        modelCatalogProvider?.models?.find((model) => model.capabilities?.includes(routeSetting.capability))?.id ||
        "";
      const voices = getProviderVoices(providerDescriptor, nextSelection.model);
      if (route === "voice.tts") {
        nextSelection.voice = voices[0] || "";
      }
    }

    setProviderSettingsDraft((current) => ({
      ...current,
      [route]: nextSelection,
    }));
    setProviderSettingsState((current) => ({ ...current, saved: false, error: "" }));
  }

  async function resolveCandidateFact(id, resolutionNote) {
    const isApprove = resolutionNote === "approved_by_user";
    const response = await fetch(
      `${API_BASE}/api/memory/candidates/${id}/${isApprove ? "approve" : "reject"}`,
      {
        method: "POST",
        headers: isApprove ? undefined : { "Content-Type": "application/json" },
        body: isApprove ? undefined : JSON.stringify({ resolutionNote }),
      }
    );

    if (!response.ok) {
      throw new Error(`Memory action failed with ${response.status}.`);
    }

    await loadDebugState();
  }

  async function removeApprovedFact(id) {
    const response = await fetch(`${API_BASE}/api/memory/approved/${id}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      throw new Error(`Approved fact removal failed with ${response.status}.`);
    }

    await loadDebugState();
  }

  async function loadTurnExplainability(turnId) {
    const response = await fetch(`${API_BASE}/api/debug/turns/${turnId}`);
    if (!response.ok) {
      throw new Error(`Turn explainability fetch failed with ${response.status}.`);
    }

    const data = await response.json();
    setTurnExplainabilityById((current) => ({
      ...current,
      [turnId]: data.explainability || null,
    }));
  }

  async function ensureRecorder() {
    if (mediaRecorderRef.current) {
      return mediaRecorderRef.current;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      throw new Error(error?.message || "Microphone access failed.");
    }
    const preferredMimeType = MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : "";
    const recorder = preferredMimeType
      ? new MediaRecorder(stream, { mimeType: preferredMimeType })
      : new MediaRecorder(stream);

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };

    streamRef.current = stream;
    mediaRecorderRef.current = recorder;
    setRecorderReady(true);
    return recorder;
  }

  async function startRecording() {
    if (isRecording || isBusy) {
      return;
    }

    await interruptTurn("start_new_recording");
    clearPlaybackPayload();

    const turnId = crypto.randomUUID();
    currentTurnIdRef.current = turnId;
    activeTurnSourceRef.current = "microphone";

    try {
      const recorder = await ensureRecorder();
      chunksRef.current = [];
      dispatch({
        type: "RESET_FOR_NEW_TURN",
        turnId,
        clientTimeline: {
          recordStartedAt: new Date().toISOString(),
        },
      });
      recorder.start();
    } catch (error) {
      dispatch({
        type: "TURN_ERROR",
        turnId,
        failure: normalizeFailure({
          stage: "mic",
          message: error.message,
        }),
      });
    }
  }

  async function stopRecording() {
    if (!mediaRecorderRef.current || !isRecording) {
      return;
    }

    const recorder = mediaRecorderRef.current;
    const turnId = currentTurnIdRef.current;
    const stopRequest = { turnId, cancelled: false };
    pendingRecordingStopRef.current = stopRequest;
    dispatch({
      type: "TURN_PHASE",
      turnId,
      phase: "transcribing",
    });

    const blob = await new Promise((resolve) => {
      recorder.onstop = () => {
        resolve(new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" }));
      };
      recorder.stop();
    });

    if (pendingRecordingStopRef.current === stopRequest) {
      pendingRecordingStopRef.current = null;
    }

    if (stopRequest.cancelled || currentTurnIdRef.current !== turnId) {
      return;
    }

    dispatch({
      type: "CLIENT_TIMELINE",
      turnId,
      patch: {
        recordStoppedAt: new Date().toISOString(),
      },
    });

    await submitVoiceTurn(blob, turnId);
  }

  async function handleTalkToggle() {
    if (isRecording) {
      await stopRecording();
      return;
    }

    await startRecording();
  }

  async function handleRetryLastTurn() {
    if (!canRetry) {
      return;
    }

    const transcriptToRetry = retryTranscript;
    if (!transcriptToRetry) {
      return;
    }

    await interruptTurn("retry_last_turn");
    clearPlaybackPayload();

    const turnId = crypto.randomUUID();
    currentTurnIdRef.current = turnId;
    activeTurnSourceRef.current = "retry";

    dispatch({
      type: "RESET_FOR_NEW_TURN",
      turnId,
      clientTimeline: {
        retryTriggeredAt: new Date().toISOString(),
      },
    });
    dispatch({
      type: "TRANSCRIPT_READY",
      turnId,
      text: transcriptToRetry,
    });
    dispatch({
      type: "TURN_PHASE",
      turnId,
      phase: "thinking",
    });

    await submitRetryTurn(transcriptToRetry, turnId);
  }

  async function handleTextPromptTurn(transcriptText, source = "self_knowledge_action") {
    const trimmedTranscript = String(transcriptText || "").trim();
    if (!trimmedTranscript) {
      return;
    }

    await interruptTurn(source);
    clearPlaybackPayload();

    const turnId = crypto.randomUUID();
    currentTurnIdRef.current = turnId;
    activeTurnSourceRef.current = source;

    dispatch({
      type: "RESET_FOR_NEW_TURN",
      turnId,
      clientTimeline: {
        promptTriggeredAt: new Date().toISOString(),
      },
    });
    dispatch({
      type: "TRANSCRIPT_READY",
      turnId,
      text: trimmedTranscript,
    });
    dispatch({
      type: "TURN_PHASE",
      turnId,
      phase: "thinking",
    });

    await submitRetryTurn(trimmedTranscript, turnId);
  }

  async function submitVoiceTurn(blob, turnId) {
    const formData = new FormData();
    formData.append("sessionId", SESSION_ID);
    formData.append("turnId", turnId);
    formData.append("captureEndedAt", new Date().toISOString());
    formData.append("lookupPrivacyMode", lookupPrivacyMode);
    if (selectedExplainTurnId) {
      formData.append("explainTurnId", selectedExplainTurnId);
    }
    formData.append("audio", blob, "voice-input.webm");

    await consumeTurnStream({
      turnId,
      request: () =>
        fetch(`${API_BASE}/api/voice/turn`, {
          method: "POST",
          body: formData,
          signal: createActiveFetchController().signal,
        }),
    });
  }

  async function submitRetryTurn(transcriptText, turnId) {
    await consumeTurnStream({
      turnId,
      request: () =>
        fetch(`${API_BASE}/api/voice/retry`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: SESSION_ID,
            turnId,
            transcriptText,
            lookupPrivacyMode,
            explainTurnId: selectedExplainTurnId || null,
          }),
          signal: createActiveFetchController().signal,
        }),
    });
  }

  async function consumeTurnStream({ turnId, request }) {
    try {
      const response = await request();

      if (!response.ok || !response.body) {
        throw new Error(`Voice turn failed with ${response.status}.`);
      }

      dispatch({
        type: "CLIENT_TIMELINE",
        turnId,
        patch: {
          responseStreamOpenedAt: new Date().toISOString(),
        },
      });

      const reader = response.body.getReader();
      activeReaderRef.current = reader;
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }

          const event = JSON.parse(line);
          applyStreamEvent(turnId, event);
        }
      }

      await loadDebugState();
      schedulePostTurnMemoryRefreshes();
    } catch (error) {
      if (isExpectedAbort(error)) {
        dispatch({
          type: "CANCELLED",
          reason: "Turn cancelled.",
        });
        return;
      }

      dispatch({
        type: "TURN_ERROR",
        turnId,
        failure: normalizeFailure(error),
      });
    } finally {
      activeReaderRef.current = null;
      activeFetchControllerRef.current = null;
    }
  }

  function schedulePostTurnMemoryRefreshes() {
    clearScheduledMemoryRefreshes();

    for (const delayMs of [1500, 4000]) {
      const timeoutId = window.setTimeout(() => {
        loadDebugState().catch(() => {});
      }, delayMs);
      memoryRefreshTimeoutsRef.current.push(timeoutId);
    }
  }

  function clearScheduledMemoryRefreshes() {
    for (const timeoutId of memoryRefreshTimeoutsRef.current) {
      window.clearTimeout(timeoutId);
    }
    memoryRefreshTimeoutsRef.current = [];
  }

  function applyStreamEvent(turnId, event) {
    if (event.turnId && event.turnId !== currentTurnIdRef.current) {
      return;
    }

    if (event.type === "status") {
      dispatch({
        type: "TURN_PHASE",
        turnId,
        phase: mapBackendPhase(event.phase),
      });
      return;
    }

    if (event.type === "transcript") {
      dispatch({
        type: "TRANSCRIPT_READY",
        turnId,
        text: event.text,
      });
      return;
    }

    if (event.type === "context") {
      dispatch({
        type: "CONTEXT_READY",
        turnId,
        preview: event.preview,
      });
      return;
    }

    if (event.type === "text-delta") {
      dispatch({
        type: "TEXT_DELTA",
        turnId,
        delta: event.delta,
      });
      return;
    }

    if (event.type === "playback-ready") {
      dispatch({
        type: "PLAYBACK_READY",
        turnId,
      });
      return;
    }

    if (event.type === "turn-complete") {
      dispatch({
        type: "TURN_COMPLETE",
        turnId,
        turn: event.turn,
      });
      if (event.turn.audioBase64) {
        playReturnedAudio(turnId, event.turn.audioBase64, event.turn.audioMimeType);
      } else if (event.turn.failure?.stage === "tts") {
        dispatch({
          type: "PLAYBACK_STOPPED",
          turnId,
          message: "Reply completed, but spoken audio generation failed.",
          hasAudio: false,
        });
      } else if (!event.turn.failure) {
        dispatch({
          type: "PLAYBACK_STOPPED",
          turnId,
          message: "Reply finished without audio playback.",
        });
      }
      return;
    }

    if (event.type === "error") {
      dispatch({
        type: "TURN_ERROR",
        turnId,
        failure: normalizeFailure({
          stage: event.stage || "server",
          message: event.message,
        }),
      });
    }
  }

  async function interruptTurn(reason = "manual_interrupt") {
    const hadActiveRecording = mediaRecorderRef.current?.state === "recording";
    const hadPlayback = Boolean(audioRef.current);
    const hadActiveNetwork = Boolean(activeFetchControllerRef.current || activeReaderRef.current);

    if (!hadActiveRecording && !hadPlayback && !hadActiveNetwork && voiceState.phase === "idle") {
      return;
    }

    dispatch({
      type: "START_CANCELLING",
      reason,
    });
    cancelPendingRecordingStop();
    stopPlayback();
    abortActiveFetch();
    abortActiveReader();
    stopActiveRecording();
    await cancelActiveTurn(reason);
    clearPlaybackPayload();
    activeTurnSourceRef.current = null;
    dispatch({
      type: "CANCELLED",
      reason,
    });
  }

  async function cancelActiveTurn(reason) {
    try {
      await fetch(`${API_BASE}/api/voice/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: SESSION_ID, reason }),
      });
    } catch {
      // Keep local interruption responsive even if the backend request races or fails.
    }
  }

  function stopActiveRecording() {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    chunksRef.current = [];
  }

  function cancelPendingRecordingStop() {
    if (pendingRecordingStopRef.current) {
      pendingRecordingStopRef.current.cancelled = true;
      pendingRecordingStopRef.current = null;
    }
  }

  function abortActiveReader() {
    activeReaderRef.current?.cancel().catch(() => {});
    activeReaderRef.current = null;
  }

  function createActiveFetchController() {
    abortActiveFetch();
    const controller = new AbortController();
    activeFetchControllerRef.current = controller;
    return controller;
  }

  function abortActiveFetch() {
    activeFetchControllerRef.current?.abort();
    activeFetchControllerRef.current = null;
  }

  function playReturnedAudio(turnId, audioBase64, mimeType) {
    audioPayloadRef.current = {
      turnId,
      audioBase64,
      mimeType,
    };
    stopPlayback();
    const audioBytes = Uint8Array.from(atob(audioBase64), (char) => char.charCodeAt(0));
    const audioBlob = new Blob([audioBytes], { type: mimeType });
    const audioUrl = URL.createObjectURL(audioBlob);
    audioObjectUrlRef.current = audioUrl;
    const audio = new Audio(audioUrl);
    audioRef.current = audio;
    audio.onplaying = () => {
      dispatch({
        type: "PLAYBACK_STARTED",
        turnId,
        at: new Date().toISOString(),
      });
    };
    audio.onended = () => {
      dispatch({
        type: "PLAYBACK_STOPPED",
        turnId,
        message: "Playback completed.",
        hasAudio: true,
      });
      releaseAudioObjectUrl(audioUrl);
      audioRef.current = null;
    };
    audio.onerror = () => {
      dispatch({
        type: "PLAYBACK_FAILED",
        turnId,
        kind: "failed",
        message: "Audio playback failed in the browser. Use Play audio to try again.",
        at: new Date().toISOString(),
      });
      releaseAudioObjectUrl(audioUrl);
    };
    audio.play().catch(() => {
      dispatch({
        type: "PLAYBACK_FAILED",
        turnId,
        kind: "blocked",
        message: "Browser autoplay blocked playback. Use Play audio to hear the reply.",
        at: new Date().toISOString(),
      });
      releaseAudioObjectUrl(audioUrl);
    });
  }

  function replayAudio() {
    const payload = audioPayloadRef.current;
    if (!payload) {
      return;
    }

    playReturnedAudio(payload.turnId, payload.audioBase64, payload.mimeType);
  }

  function stopPlayback() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
      releaseAudioObjectUrl();
      dispatch({
        type: "PLAYBACK_STOPPED",
        turnId: currentTurnIdRef.current,
        message: "Playback stopped.",
        hasAudio: Boolean(audioPayloadRef.current?.audioBase64),
      });
    }
  }

  function clearPlaybackPayload() {
    audioPayloadRef.current = null;
  }

  function releaseAudioObjectUrl(expectedUrl = null) {
    if (!audioObjectUrlRef.current) {
      return;
    }

    if (expectedUrl && audioObjectUrlRef.current !== expectedUrl) {
      return;
    }

    URL.revokeObjectURL(audioObjectUrlRef.current);
    audioObjectUrlRef.current = null;
  }

  function stopRecorderStream() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Personal Assistant</p>
          <h1>Voice-first local desktop loop</h1>
          <p className="lede">
            Thin frontend, local orchestration, bounded context, and explicit debug visibility.
          </p>
        </div>
        <div className="nav">
          <button className={mode === "voice" ? "active" : ""} onClick={() => setMode("voice")}>
            Voice
          </button>
          <button className={mode === "memories" ? "active" : ""} onClick={() => setMode("memories")}>
            Memories
          </button>
          <button className={mode === "debug" ? "active" : ""} onClick={() => setMode("debug")}>
            Debug / History
          </button>
          <button className={mode === "settings" ? "active" : ""} onClick={() => setMode("settings")}>
            Settings
          </button>
        </div>
        <div className="status-card">
          <span>State</span>
          <strong>{voiceState.phase}</strong>
          <small>
            {recorderReady
              ? `${capitalizePlaybackStatus(voiceState.playback.status)} playback state`
              : "Mic permission needed on first press"}
          </small>
        </div>
      </aside>

      <main className="main-panel">
        {mode === "voice" ? (
          <section className="voice-panel">
            <div className={`visualizer status-${voiceState.phase}`}>
              <div className="visualizer-glow" />
              <div className="portrait-ring">
                <div className={`avatar-face avatar-${avatarState.mood}`}>
                  <div className="avatar-brow avatar-brow-left" />
                  <div className="avatar-brow avatar-brow-right" />
                  <div className="avatar-eyes">
                    <span className="avatar-eye" />
                    <span className="avatar-eye" />
                  </div>
                  <div className={`avatar-mouth avatar-mouth-${avatarState.mouth}`} />
                  <div className="avatar-blush avatar-blush-left" />
                  <div className="avatar-blush avatar-blush-right" />
                </div>
              </div>
              <div className="wave wave-a" />
              <div className="wave wave-b" />
              <div className="wave wave-c" />
              <div className="avatar-caption">
                <span className="status-pill avatar-pill">{avatarState.label}</span>
                <p>{avatarState.copy}</p>
              </div>
            </div>

            <div className="turn-panel">
              <div className="status-detail-card quickstart-card">
                <label>First run</label>
                <p>{buildSetupMessage(appStatus, recorderReady)}</p>
                <div className="quickstart-list">
                  <div className="quickstart-row">
                    <span>Backend</span>
                    <strong>{appStatus.backendReachable ? "Connected" : "Start local server"}</strong>
                  </div>
                  <div className="quickstart-row quickstart-provider-row">
                    <span>Provider access</span>
                    <strong>{getConfiguredProviderSummary(providerCatalog)}</strong>
                  </div>
                  <div className="provider-status-list">
                    {providerCatalog?.providers?.length ? providerCatalog.providers.map((item) => (
                      <div className="provider-status-item" key={item.id}>
                        <span>{item.label}</span>
                        <strong className={item.configured ? "provider-ready" : "provider-missing"}>
                          {item.configured ? "Configured" : "Missing"}
                        </strong>
                      </div>
                    )) : (
                      <div className="provider-status-item">
                        <span>No provider status available</span>
                        <strong className="provider-missing">Check backend</strong>
                      </div>
                    )}
                  </div>
                  <div className="quickstart-row">
                    <span>Microphone</span>
                    <strong>{recorderReady ? "Ready" : "Allow on first press"}</strong>
                  </div>
                  <div className="quickstart-row">
                    <span>Lookup privacy</span>
                    <strong>{lookupPrivacyMode === "balanced" ? "Balanced" : "Strict"}</strong>
                  </div>
                </div>
                <small className="card-note">
                  Local app: frontend `5173`, backend `8787`
                  {appStatus.checkedAt ? ` • checked ${formatStatusTime(appStatus.checkedAt)}` : ""}
                </small>
              </div>
              <div className="transcript-card">
                <label>You said</label>
                <p>{voiceState.transcriptText || "Click once to talk. Click again to send."}</p>
              </div>
              <div className="assistant-card">
                <div className="card-header">
                  <div>
                    <label>Assistant</label>
                  </div>
                  <span className={`status-pill ${lookupStatusPillClass(voiceState.provider?.lookup?.status)}`}>
                    {describeAssistantAnswerMode(voiceState)}
                  </span>
                </div>
                <p>{voiceState.assistantText || "The reply will stream here in real time."}</p>
                {renderLookupSources(voiceState.provider?.lookup?.citations, "Current sources")}
              </div>
              <div className="status-detail-card">
                <label>Playback</label>
                <p>{voiceState.playback.message || "No active playback."}</p>
              </div>
              <div className="status-detail-card">
                <label>External lookup mode</label>
                <div className="privacy-mode-control">
                  <button
                    className={`secondary ${lookupPrivacyMode === "strict" ? "active-choice" : ""}`}
                    onClick={() => setLookupPrivacyMode("strict")}
                    type="button"
                  >
                    Strict
                  </button>
                  <button
                    className={`secondary ${lookupPrivacyMode === "balanced" ? "active-choice" : ""}`}
                    onClick={() => setLookupPrivacyMode("balanced")}
                    type="button"
                  >
                    Balanced
                  </button>
                </div>
                <small className="card-note">
                  {lookupPrivacyMode === "balanced"
                    ? "Balanced mode may send minimal approved facts or one recent turn when the question depends on local context."
                    : "Strict mode sends only the privacy-safe question to lookup providers."}
                </small>
              </div>
              {voiceState.failure ? (
                <div className="error-card">
                  <strong>{voiceState.failure.category}</strong>
                  <p>{voiceState.failure.message}</p>
                </div>
              ) : null}
            </div>

            <div className="controls">
              <button
                className={`push-talk ${isRecording ? "recording" : ""}`}
                onClick={handleTalkToggle}
                disabled={isBusy && !isRecording}
              >
                {isRecording
                  ? "Click to send"
                  : voiceState.phase === "cancelling"
                    ? "Cancelling..."
                    : voiceState.phase === "transcribing"
                      ? "Transcribing..."
                      : voiceState.phase === "researching"
                        ? "Checking sources..."
                      : voiceState.phase === "thinking"
                        ? "Thinking..."
                        : "Click to talk"}
              </button>
              <button className="secondary" onClick={() => interruptTurn("manual_interrupt")}>
                Interrupt
              </button>
              <button className="secondary" onClick={stopPlayback} disabled={!isPlayingAudio}>
                Stop audio
              </button>
              <button className="secondary" onClick={replayAudio} disabled={!canPlayAudio}>
                Play audio
              </button>
              <button className="secondary" onClick={handleRetryLastTurn} disabled={!canRetry}>
                Retry last turn
              </button>
            </div>
            {selectedExplainTurn ? (
              <p className="card-note">
                Explain target: turn {formatTurnSource(selectedExplainTurn.id)} from{" "}
                {new Date(selectedExplainTurn.created_at).toLocaleString()}.
              </p>
            ) : null}
          </section>
        ) : mode === "memories" ? (
          <section className="memories-panel">
            <div className="debug-header">
              <div>
                <p className="eyebrow">Memories</p>
                <h2>Review what should stay with Mira</h2>
              </div>
              <div className="debug-metrics">
                <div className="metric-card">
                  <span>Pending facts</span>
                  <strong>{pendingFacts.length}</strong>
                  <small>Need review</small>
                </div>
                <div className="metric-card">
                  <span>Approved facts</span>
                  <strong>{approvedFacts.length}</strong>
                  <small>In live context</small>
                </div>
                <div className="metric-card">
                  <span>Summary</span>
                  <strong>{rollingSummary.summary_text ? "Ready" : "Empty"}</strong>
                  <small>
                    {rollingSummary.updated_at
                      ? `Updated ${new Date(rollingSummary.updated_at).toLocaleDateString()}`
                      : "No rolling summary yet"}
                  </small>
                </div>
                <div className="metric-card">
                  <span>Review mode</span>
                  <strong>Intentional</strong>
                  <small>Approve only what should last</small>
                </div>
              </div>
            </div>

            <div className="debug-section">
              <div className="section-heading">
                <h3>Pending review</h3>
                <p>Keep durable identity, preferences, and routines. Skip temporary plans and weak summaries.</p>
              </div>
              <div className="memory-guidance-grid">
                <div className="debug-card memory-guidance-card">
                  <label>Good approvals</label>
                  <p>Names, steady preferences, long-running routines, and relationship context that should help later.</p>
                </div>
                <div className="debug-card memory-guidance-card">
                  <label>Usually skip</label>
                  <p>One-day plans, generic assistant claims, repeated paraphrases, and anything you would not want reused.</p>
                </div>
              </div>
              <div className="debug-card">
                {pendingFacts.length ? (
                  <div className="memory-review-groups">
                    {pendingFactGroups.map((group) => (
                      <section className="memory-review-group" key={group.key}>
                        <div className="memory-review-group-header">
                          <div>
                            <h4>{group.title}</h4>
                            <p>{group.description}</p>
                          </div>
                          <span className={`status-pill memory-recommendation-pill recommendation-${group.key}`}>
                            {group.facts.length} {group.facts.length === 1 ? "memory" : "memories"}
                          </span>
                        </div>
                        <div className="memory-list">
                          {group.facts.map((fact) => (
                            <div className="memory-item" key={fact.id}>
                              <div className="memory-copy">
                              <div className="memory-meta">
                                  {fact.category ? (
                                    <span className="status-pill memory-category-pill">
                                      {formatCategoryLabel(fact.category)}
                                    </span>
                                  ) : null}
                                  <span className={`status-pill memory-recommendation-pill recommendation-${fact.recommendation || "review"}`}>
                                    {formatRecommendationLabel(fact.recommendation)}
                                  </span>
                                  {fact.recommendation_reason ? (
                                    <span className="memory-reason">{fact.recommendation_reason}</span>
                                  ) : null}
                                </div>
                                <p>{fact.fact_text}</p>
                                <small>
                                  Captured {formatShortDate(fact.created_at)}
                                  {fact.source_turn_id ? ` from turn ${formatTurnSource(fact.source_turn_id)}` : ""}
                                </small>
                              </div>
                              <div className="memory-actions">
                                <button
                                  className="secondary"
                                  onClick={async () => {
                                    try {
                                      await resolveCandidateFact(fact.id, "approved_by_user");
                                    } catch (error) {
                                      dispatch({
                                        type: "TURN_ERROR",
                                        turnId: currentTurnIdRef.current,
                                        failure: normalizeFailure({
                                          stage: "memory",
                                          message: error.message,
                                        }),
                                      });
                                    }
                                  }}
                                >
                                  Approve
                                </button>
                                <button
                                  className="secondary"
                                  onClick={async () => {
                                    try {
                                      await resolveCandidateFact(fact.id, "rejected_by_user");
                                    } catch (error) {
                                      dispatch({
                                        type: "TURN_ERROR",
                                        turnId: currentTurnIdRef.current,
                                        failure: normalizeFailure({
                                          stage: "memory",
                                          message: error.message,
                                        }),
                                      });
                                    }
                                  }}
                                >
                                  Reject
                                </button>
                                <button
                                  className="secondary"
                                  onClick={async () => {
                                    try {
                                      await resolveCandidateFact(fact.id, "dismissed_by_user");
                                    } catch (error) {
                                      dispatch({
                                        type: "TURN_ERROR",
                                        turnId: currentTurnIdRef.current,
                                        failure: normalizeFailure({
                                          stage: "memory",
                                          message: error.message,
                                        }),
                                      });
                                    }
                                  }}
                                >
                                  Dismiss
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                ) : (
                  <p>No candidate facts waiting for review.</p>
                )}
              </div>
            </div>

            <div className="debug-section">
              <div className="section-heading">
                <h3>Approved memory</h3>
                <p>These facts are eligible for future prompt context when they are relevant.</p>
              </div>
              <div className="debug-grid two-column">
                <div className="debug-card">
                  <label>Approved facts</label>
                  {approvedFacts.length ? (
                    <div className="memory-list">
                      {approvedFacts.map((fact) => (
                        <div className="memory-item" key={fact.id}>
                          <div className="memory-copy">
                            <div className="memory-meta">
                              {fact.category ? (
                                <span className="status-pill memory-category-pill">
                                  {formatCategoryLabel(fact.category)}
                                </span>
                              ) : null}
                              <span className="memory-reason">Saved {formatShortDate(fact.created_at)}</span>
                            </div>
                            <p>{fact.fact_text}</p>
                            <small>
                              Included in future context
                              {fact.source_turn_id ? ` from turn ${formatTurnSource(fact.source_turn_id)}` : ""}
                            </small>
                          </div>
                          <button
                            className="secondary"
                            onClick={async () => {
                              try {
                                await removeApprovedFact(fact.id);
                              } catch (error) {
                                dispatch({
                                  type: "TURN_ERROR",
                                  turnId: currentTurnIdRef.current,
                                  failure: normalizeFailure({
                                    stage: "memory",
                                    message: error.message,
                                  }),
                                });
                              }
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p>No approved facts saved yet.</p>
                  )}
                </div>
                <div className="debug-card">
                  <label>Rolling summary</label>
                  <p>{rollingSummary.summary_text || "No summary yet."}</p>
                  <small className="card-note">
                    {rollingSummary.updated_at
                      ? `Updated ${new Date(rollingSummary.updated_at).toLocaleString()}`
                      : "Summary has not been generated yet."}
                  </small>
                </div>
              </div>
            </div>
          </section>
        ) : mode === "settings" ? (
          <section className="settings-panel">
            <div className="debug-header">
              <div>
                <p className="eyebrow">Settings</p>
                <h2>Provider and model routing</h2>
                <p className="lede">Choose which configured provider and model handles each part of the assistant loop.</p>
              </div>
              <div className="debug-metrics">
                <div className="metric-card">
                  <span>Backend</span>
                  <strong>{appStatus.backendReachable ? "Connected" : "Offline"}</strong>
                  <small>Local settings API</small>
                </div>
                <div className="metric-card">
                  <span>Providers</span>
                  <strong>{getConfiguredProviderSummary(providerCatalog)}</strong>
                  <small>Keys stay in backend/.env</small>
                </div>
              </div>
            </div>

            {providerCatalog ? (
              <>
                <div className="debug-card settings-note-card">
                  <label>How this works</label>
                  <p>These choices are saved locally and applied to the next operation. API keys are never exposed to the browser.</p>
                </div>
                <div className="settings-route-grid">
                  {Object.entries(providerCatalog.routes || {}).map(([route, routeSetting]) => {
                    const current = providerSettingsDraft[route] || routeSetting || {};
                    const providers = (providerCatalog.providers || []).filter((item) =>
                      item.capabilities?.includes(routeSetting?.capability)
                    );
                    const selectedProvider = providers.find((item) => item.id === current.provider);
                    const catalogProvider = (modelCatalog?.providers || []).find((item) => item.id === current.provider);
                    const availableModels = (catalogProvider?.models || []).filter((model) =>
                      model.capabilities?.includes(routeSetting?.capability)
                    );
                    const availableVoices = getProviderVoices(selectedProvider, current.model);
                    const selectedVoice = availableVoices.includes(current.voice)
                      ? current.voice
                      : availableVoices[0] || "";
                    const selectedModel = availableModels.find((model) => model.id === current.model);
                    return (
                      <div className="debug-card settings-route-card" key={route}>
                        <div className="settings-route-header">
                          <div>
                            <label>{formatProviderRouteLabel(route)}</label>
                            <p className="card-subtitle">{formatProviderCapabilityLabel(routeSetting?.capability)}</p>
                          </div>
                          <span className={`status-pill ${selectedProvider?.configured ? "lookup-used" : "lookup-fallback"}`}>
                            {selectedProvider?.configured ? "Configured" : "Needs key"}
                          </span>
                        </div>
                        <label htmlFor={`provider-${route}`}>Provider</label>
                        <select
                          id={`provider-${route}`}
                          value={current.provider || ""}
                          onChange={(event) => updateProviderSetting(route, "provider", event.target.value)}
                        >
                          {providers.length ? (
                            providers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)
                          ) : (
                            <option value="">No compatible provider</option>
                          )}
                        </select>
                        <label htmlFor={`model-${route}`}>Model</label>
                        {availableModels.length ? (
                          <select
                            id={`model-${route}`}
                            value={current.model || ""}
                            onChange={(event) => updateProviderSetting(route, "model", event.target.value)}
                          >
                            {availableModels.map((model) => (
                              <option key={model.id} value={model.id}>
                                {model.displayName || model.id}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            id={`model-${route}`}
                            value={current.model || ""}
                            onChange={(event) => updateProviderSetting(route, "model", event.target.value)}
                            placeholder="Model identifier"
                          />
                        )}
                        {route === "voice.tts" ? (
                          <>
                            <label htmlFor={`voice-${route}`}>Voice</label>
                            {availableVoices.length ? (
                              <select
                                id={`voice-${route}`}
                                value={selectedVoice}
                                onChange={(event) => updateProviderSetting(route, "voice", event.target.value)}
                              >
                                {availableVoices.map((voice) => (
                                  <option key={voice} value={voice}>{voice}</option>
                                ))}
                              </select>
                            ) : (
                              <input
                                id={`voice-${route}`}
                                value={current.voice || ""}
                                onChange={(event) => updateProviderSetting(route, "voice", event.target.value)}
                                placeholder="Provider default voice"
                              />
                            )}
                          </>
                        ) : null}
                        <small className="card-note">
                          {selectedModel?.pricing?.status === "known"
                            ? `${formatPricing(selectedModel.pricing)} · ${selectedModel.pricing.sourceUrl}`
                            : selectedProvider?.configured
                              ? `Pricing is maintained on the provider page: ${catalogProvider?.pricingSourceUrl || "not available"}`
                            : "Configure this provider key in backend/.env before using it."}
                        </small>
                      </div>
                    );
                  })}
                </div>
                <div className="debug-section settings-inventory-section">
                  <div className="section-heading">
                    <h3>Available model inventory</h3>
                    <p>Models are discovered from configured provider APIs. Pricing is an estimate or reference link, not a billing statement.</p>
                  </div>
                  <div className="model-inventory-grid">
                    {(modelCatalog?.providers || []).map((catalogProvider) => (
                      <div className="debug-card model-inventory-card" key={catalogProvider.id}>
                        <div className="settings-route-header">
                          <div>
                            <label>{catalogProvider.label}</label>
                            <p className="card-subtitle">
                              {catalogProvider.configured ? "API configured" : "API key not configured"}
                            </p>
                          </div>
                          <span className="status-pill">{catalogProvider.models?.length || 0} models</span>
                        </div>
                        {catalogProvider.models?.length ? (
                          <div className="model-inventory-list">
                            {catalogProvider.models.slice(0, 12).map((model) => (
                              <div className="model-inventory-row" key={model.id}>
                                <div>
                                  <strong>{model.displayName || model.id}</strong>
                                  <small>{model.id} · {(model.capabilities || []).join(", ") || "capability metadata unavailable"}</small>
                                </div>
                                <span>{model.pricing?.status === "known" ? formatPricing(model.pricing) : "See pricing"}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="card-note">Add the provider key to discover available models.</p>
                        )}
                        <a className="pricing-source-link" href={catalogProvider.pricingSourceUrl} target="_blank" rel="noreferrer">
                          Official pricing source
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="settings-actions">
                  <button className="push-talk" onClick={saveProviderSettings} disabled={!hasProviderSettingsChanges || providerSettingsState.saving}>
                    {providerSettingsState.saving ? "Saving..." : "Save routing settings"}
                  </button>
                  {providerSettingsState.saved ? <span className="status-pill lookup-used">Saved</span> : null}
                  {providerSettingsState.error ? <span className="status-pill lookup-fallback">{providerSettingsState.error}</span> : null}
                </div>
              </>
            ) : (
              <div className="error-card"><p>Provider settings are unavailable until the backend is connected.</p></div>
            )}
          </section>
        ) : (
          <section className="debug-panel">
            <div className="debug-header">
              <div>
                <p className="eyebrow">Debug Workspace</p>
                <h2>History, memory, and live turn state</h2>
              </div>
              <div className="debug-metrics">
                <div className="metric-card">
                  <span>Turns</span>
                  <strong>{history.length}</strong>
                  <small>Stored locally</small>
                </div>
                <div className="metric-card">
                  <span>Pending facts</span>
                  <strong>{pendingFacts.length}</strong>
                  <small>Need review</small>
                </div>
                <div className="metric-card">
                  <span>Approved facts</span>
                  <strong>{approvedFacts.length}</strong>
                  <small>In live context</small>
                </div>
                <div className="metric-card">
                  <span>Current phase</span>
                  <strong>{voiceState.phase}</strong>
                  <small>{capitalizePlaybackStatus(voiceState.playback.status)} playback</small>
                </div>
              </div>
            </div>

            <div className="debug-section">
              <div className="debug-toolbar">
                <div className="debug-toolbar-copy">
                  <h3>Debug workspace</h3>
                  <p>Refresh local state, inspect memory decisions, and keep the active turn readable.</p>
                </div>
                <button className="secondary" onClick={loadDebugState}>
                  Refresh
                </button>
              </div>
            </div>

            <div className="debug-section">
              <div className="section-heading">
                <h3>Self-knowledge</h3>
                <p>Keep the new explainability source visible without digging through raw turn JSON.</p>
              </div>
              <div className="debug-grid two-column">
                <div className="debug-card">
                  <label>How Mira can explain itself</label>
                  <p>{selfKnowledgeState.overview?.architectureSummary || "No self-knowledge overview yet."}</p>
                  <p>{selfKnowledgeState.overview?.providerSummary || "The backend overview will appear here."}</p>
                  {selfKnowledgeState.overview?.sampleQuestions?.length ? (
                    <div className="memory-list">
                      {selfKnowledgeState.overview.sampleQuestions.map((question) => (
                        <div className="memory-item" key={question}>
                          <div>
                            <p>{question}</p>
                            <small>Supported in this first Phase 10 pass</small>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="debug-card">
                  <label>Latest reply explanation</label>
                  {selfKnowledgeState.latestTurnExplanation ? (
                    <>
                      <p>{selfKnowledgeState.latestTurnExplanation.summary}</p>
                      <small className="card-note">
                        Latest stored turn {formatTurnSource(selfKnowledgeState.latestTurnExplanation.latestTurnId)}
                        {selfKnowledgeState.latestTurnExplanation.answerMode
                          ? ` â€¢ ${formatCategoryLabel(selfKnowledgeState.latestTurnExplanation.answerMode)}`
                          : ""}
                      </small>
                      <small className="card-note">
                        This stays on the latest stored turn. Use "Use as explain target" below to aim the next live self-knowledge question at a different turn.
                      </small>
                      {renderExplainabilitySections(selfKnowledgeState.latestTurnExplanation)}
                    </>
                  ) : (
                    <p>No completed turn is available for explainability yet.</p>
                  )}
                </div>
              </div>
              <div className="debug-grid two-column">
                <div className="debug-card">
                  <label>Latest failure guidance</label>
                  {selfKnowledgeState.latestFailureExplanation ? (
                    <>
                      <p>{selfKnowledgeState.latestFailureExplanation.summary}</p>
                      <small className="card-note">
                        Latest failed or degraded turn {formatTurnSource(selfKnowledgeState.latestFailureExplanation.latestTurnId)}
                        {selfKnowledgeState.latestFailureExplanation.failureCategory
                          ? ` â€¢ ${formatCategoryLabel(selfKnowledgeState.latestFailureExplanation.failureCategory)}`
                          : ""}
                      </small>
                      <small className="card-note">
                        This stays global. A selected explain target only changes the next self-knowledge question you ask live.
                      </small>
                      {renderExplainabilitySections(selfKnowledgeState.latestFailureExplanation)}
                    </>
                  ) : (
                    <p>No recent failed or degraded turn is available for debug guidance yet.</p>
                  )}
                </div>
                <div className="debug-card">
                  <label>Lookup and runtime facts</label>
                  {selfKnowledgeState.overview?.lookupFacts?.length ? (
                    <div className="memory-list">
                      {selfKnowledgeState.overview.lookupFacts.map((fact) => (
                        <div className="memory-item" key={fact}>
                          <div>
                            <p>{fact}</p>
                            <small>Grounded in current backend behavior</small>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p>No lookup facts available yet.</p>
                  )}
                  {selfKnowledgeState.overview?.runtimeFacts?.length ? (
                    <div className="memory-list">
                      {selfKnowledgeState.overview.runtimeFacts.map((fact) => (
                        <div className="memory-item" key={fact}>
                          <div>
                            <p>{fact}</p>
                            <small>Current configured runtime defaults</small>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="debug-section">
              <div className="section-heading">
                <h3>Memory</h3>
                <p>Review durable context before it reaches live prompts.</p>
              </div>
              <div className="debug-grid two-column">
                <div className="debug-card">
                  <label>Rolling summary</label>
                  <p>{rollingSummary.summary_text || "No summary yet."}</p>
                  <small className="card-note">
                    {rollingSummary.updated_at
                      ? `Updated ${new Date(rollingSummary.updated_at).toLocaleString()}`
                      : "Summary has not been generated yet."}
                  </small>
                </div>
                <div className="debug-card">
                  <label>Approved facts</label>
                  {approvedFacts.length ? (
                    <div className="memory-list">
                      {approvedFacts.map((fact) => (
                        <div className="memory-item" key={fact.id}>
                          <div>
                            <p>{fact.fact_text}</p>
                            <small>Included in future context</small>
                          </div>
                          <button
                            className="secondary"
                            onClick={async () => {
                              try {
                                await removeApprovedFact(fact.id);
                              } catch (error) {
                                dispatch({
                                  type: "TURN_ERROR",
                                  turnId: currentTurnIdRef.current,
                                  failure: normalizeFailure({
                                    stage: "memory",
                                    message: error.message,
                                  }),
                                });
                              }
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p>No approved facts saved yet.</p>
                  )}
                </div>
              </div>

              <div className="debug-card">
                <div className="card-header">
                  <div>
                    <label>Memory review</label>
                    <p className="card-subtitle">Pending review stays actionable, with resolved items kept as audit trail.</p>
                  </div>
                </div>
                {candidateFacts.length ? (
                  <div className="debug-grid two-column">
                    <div className="debug-card nested-debug-card">
                      <label>Pending review</label>
                      {pendingFacts.length ? (
                        <div className="memory-list">
                          {pendingFacts.map((fact) => (
                            <div className="memory-item" key={fact.id}>
                              <div className="memory-copy">
                                <div className="memory-meta">
                                  {fact.category ? (
                                    <span className="status-pill memory-category-pill">
                                      {formatCategoryLabel(fact.category)}
                                    </span>
                                  ) : null}
                                  <span className={`status-pill memory-recommendation-pill recommendation-${fact.recommendation || "review"}`}>
                                    {formatRecommendationLabel(fact.recommendation)}
                                  </span>
                                </div>
                                <p>{fact.fact_text}</p>
                                <small>
                                  {fact.recommendation_reason || "Pending review"}
                                  {fact.source_turn_id ? ` • turn ${formatTurnSource(fact.source_turn_id)}` : ""}
                                </small>
                              </div>
                              <div className="memory-actions">
                                <button
                                  className="secondary"
                                  onClick={async () => {
                                    try {
                                      await resolveCandidateFact(fact.id, "approved_by_user");
                                    } catch (error) {
                                      dispatch({
                                        type: "TURN_ERROR",
                                        turnId: currentTurnIdRef.current,
                                        failure: normalizeFailure({
                                          stage: "memory",
                                          message: error.message,
                                        }),
                                      });
                                    }
                                  }}
                                >
                                  Approve
                                </button>
                                <button
                                  className="secondary"
                                  onClick={async () => {
                                    try {
                                      await resolveCandidateFact(fact.id, "rejected_by_user");
                                    } catch (error) {
                                      dispatch({
                                        type: "TURN_ERROR",
                                        turnId: currentTurnIdRef.current,
                                        failure: normalizeFailure({
                                          stage: "memory",
                                          message: error.message,
                                        }),
                                      });
                                    }
                                  }}
                                >
                                  Reject
                                </button>
                                <button
                                  className="secondary"
                                  onClick={async () => {
                                    try {
                                      await resolveCandidateFact(fact.id, "dismissed_by_user");
                                    } catch (error) {
                                      dispatch({
                                        type: "TURN_ERROR",
                                        turnId: currentTurnIdRef.current,
                                        failure: normalizeFailure({
                                          stage: "memory",
                                          message: error.message,
                                        }),
                                      });
                                    }
                                  }}
                                >
                                  Dismiss
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p>No candidate facts waiting for review.</p>
                      )}
                    </div>
                    <div className="debug-card nested-debug-card">
                      <label>Resolved recently</label>
                      {resolvedFacts.length ? (
                        <div className="memory-list">
                          {resolvedFacts.slice(0, 12).map((fact) => (
                            <div className="memory-item" key={fact.id}>
                              <div className="memory-copy">
                                <div className="memory-meta">
                                  {fact.category ? (
                                    <span className="status-pill memory-category-pill">
                                      {formatCategoryLabel(fact.category)}
                                    </span>
                                  ) : null}
                                  <span className={`status-pill status-${fact.status}`}>
                                    {fact.status}
                                  </span>
                                </div>
                                <p>{fact.fact_text}</p>
                                <small>
                                  {formatResolutionNote(fact.resolution_note)}
                                  {fact.resolved_at ? ` • ${formatShortDate(fact.resolved_at)}` : ""}
                                </small>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p>No resolved memory decisions yet.</p>
                      )}
                    </div>
                  </div>
                ) : (
                  <p>No candidate facts waiting for review.</p>
                )}
              </div>
            </div>

            <div className="debug-section">
              <div className="section-heading">
                <h3>Live turn</h3>
                <p>Keep the active voice lifecycle readable without scanning raw JSON first.</p>
              </div>
              <div className="debug-grid two-column">
                <div className="debug-card">
                  <label>Lifecycle summary</label>
                  <div className="lifecycle-list">
                    <div className="lifecycle-row">
                      <span>Phase</span>
                      <strong>{voiceState.phase}</strong>
                    </div>
                    <div className="lifecycle-row">
                      <span>Source</span>
                      <strong>{activeTurnSourceRef.current || "none"}</strong>
                    </div>
                    <div className="lifecycle-row">
                      <span>Playback</span>
                      <strong>{voiceState.playback.message || "No active playback."}</strong>
                    </div>
                    <div className="lifecycle-row">
                      <span>Lookup</span>
                      <strong>{describeLiveLookup(voiceState)}</strong>
                    </div>
                    <div className="lifecycle-row">
                      <span>Explain target</span>
                      <strong>{describeExplainTarget(selectedExplainTurn)}</strong>
                    </div>
                    <div className="lifecycle-row">
                      <span>Cancellation</span>
                      <strong>{voiceState.cancellationReason || "None"}</strong>
                    </div>
                  </div>
                </div>
                <div className="debug-card">
                  <label>Timing markers</label>
                  <div className="timeline-list">
                    {Object.entries(voiceState.clientTimeline || {}).length ? (
                      Object.entries(voiceState.clientTimeline).map(([key, value]) => (
                        <div className="timeline-row" key={key}>
                          <span>{formatDebugKey(key)}</span>
                          <strong>{value}</strong>
                        </div>
                      ))
                    ) : (
                      <p>No client timing markers yet.</p>
                    )}
                    {voiceState.timings
                      ? Object.entries(voiceState.timings)
                          .filter(([, value]) => Boolean(value))
                          .map(([key, value]) => (
                            <div className="timeline-row" key={key}>
                              <span>{formatDebugKey(key)}</span>
                              <strong>{value}</strong>
                            </div>
                          ))
                      : null}
                  </div>
                </div>
              </div>

              <div className="debug-grid two-column">
                <div className="debug-card live-context">
                  <div className="card-header">
                    <div>
                      <label>Current context preview</label>
                      <p className="card-subtitle">What the backend is packaging for the active turn.</p>
                    </div>
                  </div>
                  <pre>{formatDebugJson(buildContextPreviewForDisplay(voiceState.contextPreview, selectedExplainTurn), "No live turn yet.")}</pre>
                </div>
                <div className="debug-card live-context">
                  <div className="card-header">
                    <div>
                      <label>Raw lifecycle payload</label>
                      <p className="card-subtitle">Keep this available, but secondary to the summary above.</p>
                    </div>
                  </div>
                  <pre>{formatDebugJson({
                    phase: voiceState.phase,
                    source: activeTurnSourceRef.current,
                    explainTarget: buildExplainTargetDebugPayload(selectedExplainTurn),
                    provider: voiceState.provider,
                    cancellationReason: voiceState.cancellationReason,
                    playback: voiceState.playback,
                    clientTimeline: voiceState.clientTimeline,
                    backendTimings: voiceState.timings,
                  })}</pre>
                </div>
              </div>
            </div>

            <div className="debug-section">
              <div className="section-heading">
                <h3>Recent history</h3>
                <p>Stored turns are summarized first, with raw payloads tucked behind details.</p>
              </div>
              <div className="history-list">
              {history.map((turn) => (
                <article className="history-card" key={turn.id}>
                  <header>
                    <div>
                      <strong>{new Date(turn.created_at).toLocaleString()}</strong>
                      <p className="history-subtitle">{summarizeTurn(turn)}</p>
                    </div>
                    <div>
                      <span className={`status-pill status-${turn.turn_status}`}>{turn.turn_status}</span>
                      {selectedExplainTurnId === turn.id ? (
                        <span className="status-pill memory-category-pill">Explain target</span>
                      ) : null}
                    </div>
                  </header>
                  <div className="history-copy">
                    <p><strong>User:</strong> {turn.transcript_text || "(empty)"}</p>
                    <p><strong>Assistant:</strong> {turn.assistant_text || "(none)"}</p>
                    <p><strong>Lookup:</strong> {describeStoredTurnLookup(turn)}</p>
                    {describeStoredTurnSelfKnowledge(turn) ? (
                      <p><strong>Self-knowledge:</strong> {describeStoredTurnSelfKnowledge(turn)}</p>
                    ) : null}
                    {renderLookupSources(parseStoredJson(turn.provider_json)?.lookup?.citations, "Sources")}
                    <p>
                      <button
                        className="secondary"
                        onClick={() =>
                          setSelectedExplainTurnId((current) => (current === turn.id ? "" : turn.id))
                        }
                      >
                        {selectedExplainTurnId === turn.id ? "Clear explain target" : "Use as explain target"}
                      </button>
                    </p>
                    {selectedExplainTurnId === turn.id ? (
                      <div className="controls">
                        <button
                          className="secondary"
                          onClick={() => handleTextPromptTurn("Why did you answer that way?", "selected_turn_reply_explain")}
                        >
                          Explain reply
                        </button>
                        <button
                          className="secondary"
                          onClick={() => handleTextPromptTurn("What data did you use for that turn?", "selected_turn_data_usage")}
                        >
                          Data used
                        </button>
                        <button
                          className="secondary"
                          onClick={() => handleTextPromptTurn("What was stored from that turn?", "selected_turn_storage")}
                        >
                          What was stored
                        </button>
                        <button
                          className="secondary"
                          onClick={() => handleTextPromptTurn("Was that model-only or lookup-backed?", "selected_turn_routing")}
                        >
                          Routing
                        </button>
                        <button
                          className="secondary"
                          onClick={() => handleTextPromptTurn("Why didn't audio play?", "selected_turn_debug_help")}
                          disabled={!canAskFailureQuestion(turn)}
                        >
                          Why audio failed
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <details>
                    <summary>Technical details</summary>
                    <pre>{formatDebugJson({
                      timings: parseStoredJson(turn.latency_json),
                      tokens: parseStoredJson(turn.token_json),
                      provider: parseStoredJson(turn.provider_json),
                      failure: parseStoredJson(turn.failure_json),
                    })}</pre>
                  </details>
                  <details>
                    <summary>Context package</summary>
                    <pre>{formatDebugJson(parseStoredJson(turn.context_json))}</pre>
                  </details>
                  <details
                    onToggle={(event) => {
                      if (!event.currentTarget.open || turnExplainabilityById[turn.id] !== undefined) {
                        return;
                      }

                      loadTurnExplainability(turn.id).catch((error) => {
                        dispatch({
                          type: "TURN_ERROR",
                          turnId: currentTurnIdRef.current,
                          failure: normalizeFailure({
                            stage: "debug",
                            message: error.message,
                          }),
                        });
                      });
                    }}
                  >
                    <summary>Explain this turn</summary>
                    {turnExplainabilityById[turn.id] ? (
                      <div className="debug-grid two-column">
                        <div className="debug-card nested-debug-card">
                          <label>Reply explanation</label>
                          <p>{turnExplainabilityById[turn.id].summary}</p>
                          <small className="card-note">
                            {turnExplainabilityById[turn.id].answerMode
                              ? formatCategoryLabel(turnExplainabilityById[turn.id].answerMode)
                              : "Unknown answer mode"}
                          </small>
                          {renderExplainabilitySections(turnExplainabilityById[turn.id])}
                        </div>
                        <div className="debug-card nested-debug-card">
                          <label>Data used</label>
                          <p>{turnExplainabilityById[turn.id].dataUsage?.summary || "No data-usage summary recorded."}</p>
                          <small className="card-note">
                            {turnExplainabilityById[turn.id].routing?.approvedFactsImpact || "No approved-facts note recorded."}
                          </small>
                          {turnExplainabilityById[turn.id].dataUsage ? (
                            <pre>{formatDebugJson(turnExplainabilityById[turn.id].dataUsage)}</pre>
                          ) : null}
                        </div>
                      </div>
                    ) : turnExplainabilityById[turn.id] === null ? (
                      <p>No explainability details are available for this turn.</p>
                    ) : (
                      <p>Open this panel to load explainability for the selected turn.</p>
                    )}
                  </details>
                  <details>
                    <summary>Turn storage and routing</summary>
                    {turnExplainabilityById[turn.id] ? (
                      <div className="debug-grid two-column">
                        <div className="debug-card nested-debug-card">
                          <label>Stored locally</label>
                          <p>{turnExplainabilityById[turn.id].storedArtifacts?.summary || "No storage summary recorded."}</p>
                          {turnExplainabilityById[turn.id].storedArtifacts ? (
                            <pre>{formatDebugJson(turnExplainabilityById[turn.id].storedArtifacts)}</pre>
                          ) : null}
                        </div>
                        <div className="debug-card nested-debug-card">
                          <label>Routing summary</label>
                          <p>{turnExplainabilityById[turn.id].routing?.summary || "No routing summary recorded."}</p>
                          {turnExplainabilityById[turn.id].routing ? (
                            <pre>{formatDebugJson(turnExplainabilityById[turn.id].routing)}</pre>
                          ) : null}
                        </div>
                      </div>
                    ) : (
                      <p>Load explainability first to inspect storage and routing details.</p>
                    )}
                  </details>
                  <details>
                    <summary>Failure guidance</summary>
                    {turnExplainabilityById[turn.id] ? (
                      <div className="debug-grid two-column">
                        <div className="debug-card nested-debug-card">
                          <label>Failure guidance</label>
                          {turnExplainabilityById[turn.id].failure ? (
                            <>
                              <p>{turnExplainabilityById[turn.id].failure.summary}</p>
                              <small className="card-note">
                                {turnExplainabilityById[turn.id].failure.failureCategory
                                  ? formatCategoryLabel(turnExplainabilityById[turn.id].failure.failureCategory)
                                  : "Failure recorded"}
                              </small>
                              {renderExplainabilitySections(turnExplainabilityById[turn.id].failure)}
                            </>
                          ) : (
                            <p>No failure-specific guidance was recorded for this turn.</p>
                          )}
                        </div>
                      </div>
                    ) : (
                      <p>Load explainability first to inspect failure guidance.</p>
                    )}
                  </details>
                </article>
              ))}
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function matchesTurn(state, turnId, allowMissing = false) {
  if (allowMissing && !turnId) {
    return true;
  }

  return Boolean(turnId) && state.activeTurnId === turnId;
}

function mapBackendPhase(phase) {
  if (["transcribing", "researching", "thinking", "speaking"].includes(phase)) {
    return phase;
  }

  return "idle";
}

function isExpectedAbort(error) {
  return error?.name === "AbortError" || error?.message === "BodyStreamBuffer was aborted";
}

function normalizeFailure(input) {
  const source = input?.stage ? input : { stage: "network", message: input?.message || String(input || "") };
  const category = mapFailureCategory(source.stage, source.message);
  return {
    category,
    message: mapFailureMessage(category, source.message),
    raw: source.message || "",
  };
}

function mapFailureCategory(stage, message = "") {
  if (stage === "cancelled") {
    return "cancelled";
  }
  if (stage === "mic") {
    return "mic";
  }
  if (stage === "stt") {
    return "stt";
  }
  if (stage === "tts") {
    return "tts";
  }
  if (stage === "playback") {
    return "playback";
  }
  if (stage === "memory" || stage === "debug") {
    return "network";
  }
  if (stage === "server" || message.includes("Failed to fetch")) {
    return "network";
  }
  if (message.toLowerCase().includes("microphone") || message.toLowerCase().includes("permission")) {
    return "mic";
  }

  return "chat";
}

function mapFailureMessage(category, rawMessage) {
  switch (category) {
    case "mic":
      return "Microphone access failed. Check browser permissions and try again.";
    case "network":
      return "The local assistant connection failed. Make sure the backend is running, then retry.";
    case "stt":
      return "Transcription failed or came back empty. Try speaking again.";
    case "tts":
      return "The spoken reply failed, but the text response is still available.";
    case "playback":
      return rawMessage || "The reply audio could not play in the browser.";
    case "cancelled":
      return "Turn cancelled.";
    default:
      return rawMessage || "The assistant reply failed.";
  }
}

function capitalizePlaybackStatus(status) {
  return status ? `${status.charAt(0).toUpperCase()}${status.slice(1)}` : "Idle";
}

function formatDebugKey(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function parseStoredJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function formatDebugJson(value, emptyFallback = "No data yet.") {
  if (!value || (typeof value === "object" && Object.keys(value).length === 0)) {
    return emptyFallback;
  }

  return JSON.stringify(value, null, 2);
}

function summarizeTurn(turn) {
  const tokenInfo = parseStoredJson(turn.token_json);
  const tokenCount = tokenInfo?.provider?.total_tokens;
  const failure = parseStoredJson(turn.failure_json);
  const selfKnowledge = parseStoredJson(turn.provider_json)?.selfKnowledge;

  if (selfKnowledge?.status === "used") {
    return `Answered from local self-knowledge about ${formatCategoryLabel(selfKnowledge.topic || "self_knowledge").toLowerCase()}${describeSelfKnowledgeTurnReference(selfKnowledge)}`;
  }

  if (failure?.stage) {
    return `Ended with ${failure.stage} issue${tokenCount ? ` • ${tokenCount} tokens` : ""}`;
  }

  return tokenCount ? `${tokenCount} total tokens used` : "Stored completed turn";
}

function getRecoverableTranscript(voiceState, history) {
  if (voiceState.lastRecoverableTranscript?.trim()) {
    return voiceState.lastRecoverableTranscript.trim();
  }

  const latestHistoryTranscript = history.find((turn) => turn.transcript_text?.trim());
  return latestHistoryTranscript?.transcript_text?.trim() || "";
}

function formatRecommendationLabel(value) {
  if (!value) {
    return "Review";
  }

  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function formatCategoryLabel(value) {
  return String(value || "")
    .split("_")
    .filter(Boolean)
    .map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
    .join(" ") || "Uncategorized";
}

function formatTurnSource(value) {
  return String(value || "").slice(0, 8);
}

function formatShortDate(value) {
  if (!value) {
    return "recently";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "recently";
  }

  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatStatusTime(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "recently";
  }

  return parsed.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatResolutionNote(value) {
  if (!value) {
    return "Resolved";
  }

  return String(value)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function renderExplainabilitySections(explanation) {
  if (!explanation) {
    return <p>No explainability details yet.</p>;
  }

  return (
    <div className="memory-list">
      <div className="memory-item">
        <div>
          <p><strong>Confirmed evidence</strong></p>
          <small>{joinExplainabilityItems(explanation.evidence)}</small>
        </div>
      </div>
      <div className="memory-item">
        <div>
          <p><strong>Inference</strong></p>
          <small>{joinExplainabilityItems(explanation.inference)}</small>
        </div>
      </div>
      <div className="memory-item">
        <div>
          <p><strong>Unknown</strong></p>
          <small>{joinExplainabilityItems(explanation.unknowns)}</small>
        </div>
      </div>
      {Array.isArray(explanation.nextChecks) && explanation.nextChecks.length ? (
        <div className="memory-item">
          <div>
            <p><strong>Useful next checks</strong></p>
            <small>{joinExplainabilityItems(explanation.nextChecks)}</small>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function joinExplainabilityItems(items) {
  if (!Array.isArray(items) || !items.length) {
    return "None recorded.";
  }

  return items.join(" ");
}

function buildSetupMessage(appStatus, recorderReady) {
  if (!appStatus.backendReachable) {
    return "Start the local backend and frontend, then refresh this page.";
  }

  if (!appStatus.providerConfigured) {
    return "The app is running locally, but at least one provider key is needed in backend/.env for live replies.";
  }

  if (!recorderReady) {
    return "Everything is connected. Press Click to talk once to allow the microphone.";
  }

  return "Everything needed for a normal voice session is ready.";
}

function getConfiguredProviderSummary(providerCatalog) {
  const providers = providerCatalog?.providers || [];
  const configuredCount = providers.filter((item) => item.configured).length;
  return providers.length ? `${configuredCount} of ${providers.length} configured` : "Unavailable";
}

function getProviderVoices(providerDescriptor, model) {
  const catalog = providerDescriptor?.voices?.speech_synthesis || [];
  if (Array.isArray(catalog)) return catalog;
  return catalog[model] || catalog["*"] || [];
}

function formatProviderRouteLabel(route) {
  return String(route || "")
    .replace("voice.", "Voice ")
    .replace("lookup.", "Lookup ")
    .replace(/[._]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatProviderCapabilityLabel(capability) {
  return String(capability || "").replace(/_/g, " ") || "Provider capability";
}

function formatPricing(pricing) {
  if (pricing.inputPerMillionUsd != null || pricing.outputPerMillionUsd != null) {
    const input = pricing.inputPerMillionUsd != null ? `$${pricing.inputPerMillionUsd}/M in` : "";
    const output = pricing.outputPerMillionUsd != null ? `$${pricing.outputPerMillionUsd}/M out` : "";
    return [input, output].filter(Boolean).join(" · ");
  }

  if (pricing.audioPerHourUsd != null) {
    return `$${pricing.audioPerHourUsd}/audio hour`;
  }

  if (pricing.outputPerMillionCharactersUsd != null) {
    return `$${pricing.outputPerMillionCharactersUsd}/M characters`;
  }

  return "Pricing reference only";
}

const MEMORY_REVIEW_GROUPS = [
  {
    key: "approve",
    title: "Recommended to keep",
    description: "Durable details that are likely worth carrying into future conversations.",
  },
  {
    key: "review",
    title: "Review carefully",
    description: "Potentially useful, but worth a quick judgment before saving long term.",
  },
  {
    key: "dismiss",
    title: "Recommended to skip",
    description: "Low-value, temporary, or weakly phrased memories that likely should not stick.",
  },
  {
    key: "reject",
    title: "Recommended to reject",
    description: "Memories that look wrong, misleading, or explicitly not something Mira should retain.",
  },
];

const AVATAR_STATES = {
  idle: {
    label: "Resting",
    mood: "calm",
    mouth: "soft",
    copy: "Mira is ready whenever you want to talk.",
  },
  listening: {
    label: "Listening",
    mood: "curious",
    mouth: "small",
    copy: "Mira is focused on your words and waiting for you to finish.",
  },
  transcribing: {
    label: "Transcribing",
    mood: "focused",
    mouth: "flat",
    copy: "Mira is turning your voice into text.",
  },
  researching: {
    label: "Checking sources",
    mood: "focused",
    mouth: "flat",
    copy: "Mira is checking current sources before replying.",
  },
  thinking: {
    label: "Thinking",
    mood: "focused",
    mouth: "soft",
    copy: "Mira is shaping the reply before speaking.",
  },
  speaking: {
    label: "Speaking",
    mood: "warm",
    mouth: "open",
    copy: "Mira is speaking back in real time.",
  },
  cancelling: {
    label: "Stopping",
    mood: "calm",
    mouth: "flat",
    copy: "Mira is winding the turn down cleanly.",
  },
  error: {
    label: "Needs retry",
    mood: "concerned",
    mouth: "flat",
    copy: "Something interrupted the turn, but Mira is still here.",
  },
};

function describeLiveLookup(voiceState) {
  const lookupStatus = voiceState.provider?.lookup?.status;
  const cacheStatus = voiceState.provider?.lookup?.cache?.status;
  if (voiceState.provider?.selfKnowledge?.status === "used") {
    return `Local self-knowledge (${formatCategoryLabel(voiceState.provider.selfKnowledge.topic || "self_knowledge").toLowerCase()}${describeSelfKnowledgeTurnReference(voiceState.provider.selfKnowledge)})`;
  }
  if (lookupStatus === "used") {
    const citationCount = voiceState.provider?.lookup?.citations?.length || 0;
    const sourceLabel = citationCount ? `Current sources used (${citationCount})` : "Current sources used";
    if (cacheStatus === "hit") {
      return `${sourceLabel}, cached retrieval`;
    }
    return sourceLabel;
  }

  if (lookupStatus === "failed_then_fell_back") {
    return "Lookup failed, replied model-only";
  }

  const preview = voiceState.contextPreview?.externalLookup;
  if (preview?.lookupNeeded) {
    return `Planned ${preview.privacyMode} lookup`;
  }

  return "Model-only";
}

function describeStoredTurnLookup(turn) {
  const providerInfo = parseStoredJson(turn.provider_json);
  const lookup = providerInfo?.lookup;

  if (!lookup) {
    return "Model-only";
  }

  if (lookup.status === "used") {
    const citationCount = lookup.citations?.length || 0;
    const sourceLabel = citationCount ? `Current sources used (${citationCount})` : "Current sources used";
    if (lookup.cache?.status === "hit") {
      return `${sourceLabel}, shaped from cached retrieval`;
    }
    if (lookup.cache?.status === "stored" || lookup.cache?.status === "miss_then_stored") {
      return `${sourceLabel}, fresh retrieval cached`;
    }
    return sourceLabel;
  }

  if (lookup.status === "failed_then_fell_back") {
    return "Lookup failed, then the app answered model-only";
  }

  if (lookup.status === "not_needed") {
    return "Model-only, no external lookup needed";
  }

  if (lookup.status === "provider_unavailable") {
    return "Lookup skipped because the provider was unavailable";
  }

  if (lookup.status === "disabled") {
    return "Lookup is disabled";
  }

  if (lookup.status === "not_applicable") {
    return "Lookup not applicable for this local self-knowledge answer";
  }

  return "Model-only";
}

function describeStoredTurnSelfKnowledge(turn) {
  const providerInfo = parseStoredJson(turn.provider_json);
  const selfKnowledge = providerInfo?.selfKnowledge;

  if (!selfKnowledge || selfKnowledge.status !== "used") {
    return "";
  }

  const topic = formatCategoryLabel(selfKnowledge.topic || "self_knowledge").toLowerCase();
  const answerMode = selfKnowledge.answerMode
    ? ` using ${formatCategoryLabel(selfKnowledge.answerMode).toLowerCase()}`
    : "";
  return `Answered from local ${topic} evidence${answerMode}${describeSelfKnowledgeTurnReference(selfKnowledge, { sentence: true })}.`;
}

function describeAssistantAnswerMode(voiceState) {
  if (voiceState.provider?.selfKnowledge?.status === "used") {
    return `Local self-knowledge answer${describeSelfKnowledgeTurnReference(voiceState.provider.selfKnowledge)}`;
  }

  const lookupStatus = voiceState.provider?.lookup?.status;

  if (lookupStatus === "used") {
    return "Current-source answer";
  }

  if (lookupStatus === "failed_then_fell_back") {
    return "Model-only fallback";
  }

  if (voiceState.contextPreview?.externalLookup?.lookupNeeded) {
    return "Checking if lookup helps";
  }

  return "Model-only answer";
}

function describeExplainTarget(turn) {
  if (!turn) {
    return "Latest-turn fallback";
  }

  return `Selected turn ${formatTurnSource(turn.id)}`;
}

function describeSelfKnowledgeTurnReference(selfKnowledge, options = {}) {
  const requestedTurnId = selfKnowledge?.requestedTurnId;
  const latestTurnId = selfKnowledge?.latestTurnId;
  const sentence = options.sentence === true;

  if (requestedTurnId) {
    return sentence
      ? ` with selected turn ${formatTurnSource(requestedTurnId)}`
      : `, selected turn ${formatTurnSource(requestedTurnId)}`;
  }

  if (latestTurnId) {
    return sentence
      ? ` with latest turn ${formatTurnSource(latestTurnId)}`
      : `, latest turn ${formatTurnSource(latestTurnId)}`;
  }

  return "";
}

function buildExplainTargetDebugPayload(turn) {
  if (!turn) {
    return {
      mode: "latest_turn_fallback",
      turnId: null,
    };
  }

  return {
    mode: "selected_turn",
    turnId: turn.id,
    createdAt: turn.created_at,
    turnStatus: turn.turn_status,
    transcriptText: turn.transcript_text || "",
  };
}

function buildContextPreviewForDisplay(contextPreview, selectedTurn) {
  if (!contextPreview && !selectedTurn) {
    return null;
  }

  return {
    explainTarget: buildExplainTargetDebugPayload(selectedTurn),
    ...(contextPreview || {}),
  };
}

function canAskFailureQuestion(turn) {
  const failure = parseStoredJson(turn.failure_json);
  return Boolean(failure?.stage) || turn.turn_status !== "completed";
}

function lookupStatusPillClass(status) {
  if (status === "used") {
    return "lookup-used";
  }

  if (status === "failed_then_fell_back") {
    return "lookup-fallback";
  }

  return "lookup-model-only";
}

function renderLookupSources(citations, label) {
  if (!Array.isArray(citations) || !citations.length) {
    return null;
  }

  return (
    <div className="lookup-sources">
      <small>{label}</small>
      <div className="lookup-source-list">
        {citations.slice(0, 4).map((citation) => (
          <a
            key={`${citation.url}-${citation.title}`}
            className="lookup-source-item"
            href={citation.url}
            target="_blank"
            rel="noreferrer"
          >
            <strong>{citation.title || formatSourceDomain(citation.url)}</strong>
            <span>{formatSourceDomain(citation.url)}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

function formatSourceDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url || "source";
  }
}
