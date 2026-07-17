import { config } from "../config.js";

export class GroqProvider {
  id = "groq";
  label = "Groq";

  isConfigured() {
    return Boolean(config.groqApiKey);
  }

  getDescriptor() {
    return {
      id: this.id,
      label: this.label,
      configured: this.isConfigured(),
      capabilities: ["chat", "transcription", "speech_synthesis"],
      models: {
        chat: config.groqChatModel,
        transcription: config.groqSttModel,
        speech_synthesis: config.groqTtsModel,
      },
      voices: {
        speech_synthesis: {
          "canopylabs/orpheus-v1-english": ["autumn", "diana", "hannah", "austin", "daniel", "troy"],
          "canopylabs/orpheus-arabic-saudi": ["abdullah", "fahad", "sultan", "lulwa", "noura", "aisha"],
        },
      },
      voiceMetadata: {
        speech_synthesis: {
          "canopylabs/orpheus-v1-english": {
            sourceUrl: "https://console.groq.com/docs/text-to-speech/orpheus",
            catalogType: "documented",
            dynamic: false,
            supportsHint: true,
            hintStyle: "orpheus_vocal_direction",
            streaming: false,
          },
          "canopylabs/orpheus-arabic-saudi": {
            sourceUrl: "https://console.groq.com/docs/text-to-speech/orpheus",
            catalogType: "documented",
            dynamic: false,
            supportsHint: true,
            hintStyle: "orpheus_vocal_direction",
            streaming: false,
          },
        },
      },
    };
  }

  async streamChat({ contextPackage, onDelta, signal, model }) {
    const body = await this.chatCompletion({
      model: model || config.groqChatModel,
      messages: [{ role: "user", content: buildContextPrompt(contextPackage) }],
      stream: false,
      signal,
    });
    const text = body.choices?.[0]?.message?.content?.trim() || "";
    onDelta(text);
    return { text, usage: body.usage || null };
  }

  async transcribe({ audioBuffer, mimeType, signal, model }) {
    if (!this.isConfigured()) throw new Error("GROQ_API_KEY is not configured.");
    const form = new FormData();
    form.append("file", new Blob([audioBuffer], { type: mimeType || "audio/webm" }), "voice-input.webm");
    form.append("model", model || config.groqSttModel);
    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.groqApiKey}` },
      body: form,
      signal,
    });
    if (!response.ok) throw new Error(`Groq transcription failed with ${response.status}.`);
    const body = await response.json();
    return { text: body.text?.trim() || "", raw: body };
  }

  async synthesizeSpeech({ text, signal, model, voice, voiceHint }) {
    if (!this.isConfigured()) throw new Error("GROQ_API_KEY is not configured.");
    const direction = voiceHint?.trim().replace(/[\[\]]/g, "");
    const response = await fetch("https://api.groq.com/openai/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.groqApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: model || config.groqTtsModel, input: direction ? `[${direction}] ${text}` : text, voice: voice || "autumn", response_format: "wav" }),
      signal,
    });
    if (!response.ok) throw new Error(`Groq speech synthesis failed with ${response.status}.`);
    return { audioBuffer: Buffer.from(await response.arrayBuffer()), mimeType: "audio/wav", speechInput: text };
  }

  async chatCompletion({ model, messages, stream, signal }) {
    if (!this.isConfigured()) throw new Error("GROQ_API_KEY is not configured.");
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.groqApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream }),
      signal,
    });
    if (!response.ok) throw new Error(`Groq chat request failed with ${response.status}.`);
    return response.json();
  }
}

function buildContextPrompt(contextPackage) {
  return [
    "You are a private desktop voice companion. Be warm, concise, natural, and voice-friendly.",
    `User: ${contextPackage?.currentUserText || ""}`,
    contextPackage?.rollingSummary ? `Background summary:\n${contextPackage.rollingSummary}` : "",
  ].filter(Boolean).join("\n\n");
}
