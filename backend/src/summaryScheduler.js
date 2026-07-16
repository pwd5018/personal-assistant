import { config } from "./config.js";
import { getRoutingSelections, resolveProviderRoute, provider } from "./provider/index.js";
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
    this.idleTimer?.unref?.();
  }

  async run() {
    const summaryRoute = resolveProviderRoute("summary");
    if (this.running || !summaryRoute.provider.isConfigured()) {
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

      const nextSummary = await summaryRoute.provider.summarizeConversation({
        transcriptWindow,
        existingSummary,
        approvedFacts,
        model: getRoutingSelections().summary?.model,
      });

      if (nextSummary) {
        store.updateRollingSummary(nextSummary, new Date().toISOString());
      }
    } finally {
      this.running = false;
    }
  }

  stop() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

export const summaryScheduler = new SummaryScheduler();
