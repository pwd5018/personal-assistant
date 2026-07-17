import { config } from "../config.js";

export class GeminiProvider {
  id = "gemini";
  label = "Google Gemini";

  isConfigured() {
    return Boolean(config.geminiApiKey);
  }

  getDescriptor() {
    return {
      id: this.id,
      label: this.label,
      configured: this.isConfigured(),
      capabilities: ["chat", "summary", "speech_synthesis"],
      models: {
        chat: config.geminiChatModel,
        summary: config.geminiSummaryModel,
        speech_synthesis: config.geminiTtsModel,
      },
      voices: {
        speech_synthesis: {
          [config.geminiTtsModel]: ["Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat"],
          "gemini-2.5-flash-preview-tts": ["Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat"],
          "gemini-3.1-flash-tts-preview": ["Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat"],
        },
      },
      voiceMetadata: {
        speech_synthesis: {
          [config.geminiTtsModel]: {
            sourceUrl: "https://ai.google.dev/gemini-api/docs/speech-generation",
            catalogType: "documented",
            dynamic: false,
            supportsHint: true,
            hintStyle: "natural_language_direction",
            streaming: config.geminiTtsModel === "gemini-3.1-flash-tts-preview",
          },
          "gemini-2.5-flash-preview-tts": {
            sourceUrl: "https://ai.google.dev/gemini-api/docs/speech-generation",
            catalogType: "documented",
            dynamic: false,
            supportsHint: true,
            hintStyle: "natural_language_direction",
            streaming: false,
          },
        },
      },
    };
  }

  async streamChat({ contextPackage, onDelta, signal, model }) {
    const response = await this.generateContent({
      model: model || config.geminiChatModel,
      prompt: buildContextPrompt(contextPackage),
      signal,
    });
    onDelta(response.text);
    return { text: response.text, usage: response.usage };
  }

  async summarizeConversation({ transcriptWindow, existingSummary, approvedFacts = [], model }) {
    const response = await this.generateContent({
      model: model || config.geminiSummaryModel,
      prompt: [
        "Update a compact rolling conversation summary for future turns.",
        "Use only the existing summary and recent turns below. Return exactly three lines: Confirmed context, Active threads, Open loops.",
        existingSummary ? `Existing summary:\n${existingSummary}` : "",
        approvedFacts.length ? `Approved facts:\n${approvedFacts.map((fact) => fact.fact_text).join("\n")}` : "",
        `Recent turns:\n${transcriptWindow.map((turn) => `User: ${turn.transcript_text || ""}\nAssistant: ${turn.assistant_text || ""}`).join("\n\n")}`,
      ].filter(Boolean).join("\n\n"),
    });
    return response.text;
  }

  async synthesizeSpeech({ text, signal, model, voice, voiceHint }) {
    if (!this.isConfigured()) throw new Error("GEMINI_API_KEY is not configured.");
    const speechInput = voiceHint?.trim()
      ? `Read the following text with this voice direction: ${voiceHint.trim()}\n\n${text}`
      : text;
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": config.geminiApiKey,
        },
        body: JSON.stringify({
          model: model || config.geminiTtsModel,
          input: speechInput,
          response_format: { type: "audio" },
          generation_config: {
            speech_config: [{ voice: voice || config.geminiTtsVoice }],
          },
        }),
        signal,
      }
    );
    if (!response.ok) throw new Error(`Gemini speech synthesis failed with ${response.status}.`);
    const body = await response.json();
    const audioPart =
      body.output_audio ||
      body.outputAudio ||
      body.steps?.flatMap((step) => step.content || []).find((content) =>
        String(content.mime_type || content.mimeType || "").startsWith("audio/")
      );
    const encodedAudio = audioPart?.data;
    if (!encodedAudio) throw new Error("Gemini speech synthesis returned no audio.");
    const pcmBuffer = Buffer.from(encodedAudio, "base64");
    return {
      audioBuffer: wrapPcmAsWav(pcmBuffer),
      mimeType: "audio/wav",
      speechInput: text,
    };
  }

  async generateContent({ model, prompt, signal }) {
    if (!this.isConfigured()) throw new Error("GEMINI_API_KEY is not configured.");
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
        signal,
      }
    );
    if (!response.ok) throw new Error(`Gemini request failed with ${response.status}.`);
    const body = await response.json();
    return {
      text: body.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim() || "",
      usage: body.usageMetadata || null,
    };
  }
}

function wrapPcmAsWav(pcmBuffer, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}

function buildContextPrompt(contextPackage) {
  return [
    "You are a private desktop voice companion. Be warm, concise, natural, and voice-friendly.",
    `User: ${contextPackage?.currentUserText || ""}`,
    contextPackage?.rollingSummary ? `Background summary:\n${contextPackage.rollingSummary}` : "",
    contextPackage?.approvedFacts?.length ? `Approved facts:\n${contextPackage.approvedFacts.map((fact) => fact.fact_text).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}
