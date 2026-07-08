export function estimateTokens(value) {
  if (!value) {
    return 0;
  }

  return Math.ceil(String(value).length / 4);
}

export function clampByTokenBudget(items, budget, pickText) {
  const selected = [];
  let total = 0;

  for (const item of items) {
    const tokens = estimateTokens(pickText(item));
    if (selected.length > 0 && total + tokens > budget) {
      break;
    }

    selected.push(item);
    total += tokens;
  }

  return {
    items: selected,
    estimatedTokens: total,
  };
}
