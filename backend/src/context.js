import { config } from "./config.js";
import { clampByTokenBudget, estimateTokens } from "./tokenBudget.js";
import { store } from "./store.js";

export function buildContextPackage(currentUserText, options = {}) {
  const recentTurns = store.getRecentCompletedTurns(4);
  const recentTurnPreview = recentTurns.map((turn) => ({
    user: turn.transcript_text || "",
    assistant: turn.assistant_text || "",
    createdAt: turn.created_at,
  }));

  const recentBudget = clampByTokenBudget(
    [...recentTurnPreview].reverse(),
    1200,
    (turn) => `${turn.user}\n${turn.assistant}`
  );

  const summaryRow = store.getRollingSummary();
  const approvedFacts = store.getApprovedFacts();
  const factsBudget = clampByTokenBudget(
    approvedFacts,
    200,
    (fact) => fact.fact_text
  );

  const summaryText = trimToTokenEstimate(summaryRow.summary_text, 300);
  const summaryTokens = estimateTokens(summaryText);
  const selfKnowledge = options.selfKnowledge || null;
  const recentExplainability = options.recentExplainability || null;
  const selfKnowledgeTokens = estimateTokens(
    selfKnowledge ? JSON.stringify(selfKnowledge) : ""
  );
  const recentExplainabilityTokens = estimateTokens(
    recentExplainability ? JSON.stringify(recentExplainability) : ""
  );

  const packagePreview = {
    systemPrompt: config.systemPrompt,
    rollingSummary: summaryText,
    approvedFacts: factsBudget.items.map((fact) => fact.fact_text),
    approvedFactRecords: factsBudget.items.map((fact) => ({
      fact_text: fact.fact_text,
      category: fact.category || null,
    })),
    recentTurns: recentBudget.items.reverse(),
    currentUserText,
    selfKnowledge,
    recentExplainability,
    tokenBudget: {
      recentTurns: recentBudget.estimatedTokens,
      rollingSummary: summaryTokens,
      approvedFacts: factsBudget.estimatedTokens,
      selfKnowledge: selfKnowledgeTokens,
      recentExplainability: recentExplainabilityTokens,
      currentUserText: estimateTokens(currentUserText),
      totalEstimated:
        recentBudget.estimatedTokens +
        summaryTokens +
        factsBudget.estimatedTokens +
        selfKnowledgeTokens +
        recentExplainabilityTokens +
        estimateTokens(currentUserText),
    },
  };

  return packagePreview;
}

function trimToTokenEstimate(value, maxTokens) {
  if (!value) {
    return "";
  }

  const maxChars = maxTokens * 4;
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
}
