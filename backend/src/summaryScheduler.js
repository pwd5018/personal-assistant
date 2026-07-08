import { config } from "./config.js";
import { provider } from "./provider/index.js";
import { store } from "./store.js";

class SummaryScheduler {
  constructor() {
    this.idleTimer = null;
    this.running = false;
  }

  markTurnCompleted() {
    const completedCount = store.getCompletedTurnCount();

    if (completedCount > 0 && completedCount % 6 === 0) {
      this.queueRun(0);
      return;
    }

    this.queueRun(config.summaryIdleMs);
  }

  queueRun(delayMs) {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.run().catch((error) => {
        console.error("Summary refresh failed:", error);
      });
    }, delayMs);
  }

  async run() {
    if (this.running || !provider.isConfigured()) {
      return;
    }

    this.running = true;

    try {
      const existingSummary = store.getRollingSummary().summary_text;
      const transcriptWindow = store.getRecentTranscriptWindow(12);
      const approvedFacts = store.getApprovedFacts();
      if (!transcriptWindow.length) {
        return;
      }

      const nextSummary = await provider.summarizeConversation({
        transcriptWindow,
        existingSummary,
        approvedFacts,
      });

      if (nextSummary) {
        store.updateRollingSummary(nextSummary, new Date().toISOString());
      }
    } finally {
      this.running = false;
    }
  }
}

export const summaryScheduler = new SummaryScheduler();
