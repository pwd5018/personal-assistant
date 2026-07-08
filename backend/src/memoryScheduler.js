import { randomUUID } from "node:crypto";
import { provider } from "./provider/index.js";
import { store } from "./store.js";

class MemoryScheduler {
  constructor() {
    this.pendingTurnIds = new Set();
  }

  queueFactExtraction(turn) {
    if (!provider.isConfigured() || !turn?.id || this.pendingTurnIds.has(turn.id)) {
      return;
    }

    this.pendingTurnIds.add(turn.id);
    setTimeout(() => {
      this.extractForTurn(turn).catch((error) => {
        console.error("Candidate fact extraction failed:", error);
      });
    }, 0);
  }

  async extractForTurn(turn) {
    try {
      const existingApprovedFacts = store.getApprovedFacts();
      const candidateFacts = await provider.extractCandidateFacts({
        transcriptText: turn.transcriptText,
        assistantText: turn.assistantText,
        existingApprovedFacts,
      });

      if (!candidateFacts.length) {
        return;
      }

      const now = new Date().toISOString();
      store.insertCandidateFacts(
        candidateFacts.map((candidateFact) => ({
          id: randomUUID(),
          fact_text: candidateFact.fact,
          source_turn_id: turn.id,
          status: "pending",
          created_at: now,
          resolved_at: null,
          resolution_note: null,
          category: candidateFact.category,
          recommendation: candidateFact.recommendation,
          recommendation_reason: candidateFact.recommendationReason,
        }))
      );
    } finally {
      this.pendingTurnIds.delete(turn.id);
    }
  }
}

export const memoryScheduler = new MemoryScheduler();
