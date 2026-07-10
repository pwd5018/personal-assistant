import { getDatabase } from "./db.js";

const db = getDatabase();

const insertTurnStatement = db.prepare(`
  INSERT INTO raw_turns (
    id,
    session_id,
    created_at,
    transcript_text,
    assistant_text,
    turn_status,
    context_json,
    latency_json,
    token_json,
    provider_json,
    failure_json,
    transcript_mime_type,
    audio_bytes
  ) VALUES (
    @id,
    @session_id,
    @created_at,
    @transcript_text,
    @assistant_text,
    @turn_status,
    @context_json,
    @latency_json,
    @token_json,
    @provider_json,
    @failure_json,
    @transcript_mime_type,
    @audio_bytes
  )
`);

const recentTurnsStatement = db.prepare(`
  SELECT *
  FROM raw_turns
  WHERE turn_status = 'completed'
  ORDER BY datetime(created_at) DESC
  LIMIT ?
`);

const debugTurnsStatement = db.prepare(`
  SELECT id, session_id, created_at, transcript_text, assistant_text, turn_status, context_json, latency_json, token_json, provider_json, failure_json
  FROM raw_turns
  ORDER BY datetime(created_at) DESC
  LIMIT ?
`);

const turnByIdStatement = db.prepare(`
  SELECT *
  FROM raw_turns
  WHERE id = ?
`);

const summaryStatement = db.prepare(`
  SELECT summary_text, updated_at
  FROM rolling_summary
  WHERE id = 1
`);

const updateSummaryStatement = db.prepare(`
  UPDATE rolling_summary
  SET summary_text = ?, updated_at = ?
  WHERE id = 1
`);

const approvedFactsStatement = db.prepare(`
  SELECT id, fact_text, source_turn_id, category, created_at
  FROM approved_facts
  ORDER BY datetime(created_at) ASC
`);

const candidateFactsStatement = db.prepare(`
  SELECT id, fact_text, source_turn_id, status, created_at, resolved_at, resolution_note, category, recommendation, recommendation_reason
  FROM candidate_facts
  ORDER BY
    CASE status WHEN 'pending' THEN 0 ELSE 1 END,
    datetime(created_at) DESC
`);

const insertCandidateFactStatement = db.prepare(`
  INSERT INTO candidate_facts (
    id,
    fact_text,
    source_turn_id,
    status,
    created_at,
    resolved_at,
    resolution_note,
    category,
    recommendation,
    recommendation_reason
  ) VALUES (
    @id,
    @fact_text,
    @source_turn_id,
    @status,
    @created_at,
    @resolved_at,
    @resolution_note,
    @category,
    @recommendation,
    @recommendation_reason
  )
`);

const findMatchingPendingCandidateStatement = db.prepare(`
  SELECT id
  FROM candidate_facts
  WHERE fact_text = ?
    AND status = 'pending'
  LIMIT 1
`);

const findMatchingApprovedFactStatement = db.prepare(`
  SELECT id
  FROM approved_facts
  WHERE fact_text = ?
  LIMIT 1
`);

const candidateFactByIdStatement = db.prepare(`
  SELECT id, fact_text, source_turn_id, status, created_at, resolved_at, resolution_note, category, recommendation, recommendation_reason
  FROM candidate_facts
  WHERE id = ?
`);

const resolveCandidateFactStatement = db.prepare(`
  UPDATE candidate_facts
  SET status = ?, resolved_at = ?, resolution_note = ?
  WHERE id = ?
`);

const insertApprovedFactStatement = db.prepare(`
  INSERT INTO approved_facts (id, fact_text, source_turn_id, category, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

const deleteApprovedFactStatement = db.prepare(`
  DELETE FROM approved_facts
  WHERE id = ?
`);

const completedTurnCountStatement = db.prepare(`
  SELECT COUNT(*) AS count
  FROM raw_turns
  WHERE turn_status = 'completed'
`);

const recentTranscriptWindowStatement = db.prepare(`
  SELECT transcript_text, assistant_text, created_at
  FROM raw_turns
  WHERE turn_status = 'completed'
  ORDER BY datetime(created_at) DESC
  LIMIT ?
`);

const lookupCacheByKeyStatement = db.prepare(`
  SELECT *
  FROM lookup_cache
  WHERE cache_key = ?
`);

const upsertLookupCacheStatement = db.prepare(`
  INSERT INTO lookup_cache (
    cache_key,
    question_kind,
    privacy_mode,
    answer_mode,
    resolution_status,
    retrieval_json,
    evidence_json,
    extraction_json,
    citations_json,
    web_searches_json,
    usage_json,
    created_at,
    expires_at,
    last_used_at,
    hit_count
  ) VALUES (
    @cache_key,
    @question_kind,
    @privacy_mode,
    @answer_mode,
    @resolution_status,
    @retrieval_json,
    @evidence_json,
    @extraction_json,
    @citations_json,
    @web_searches_json,
    @usage_json,
    @created_at,
    @expires_at,
    @last_used_at,
    @hit_count
  )
  ON CONFLICT(cache_key) DO UPDATE SET
    question_kind = excluded.question_kind,
    privacy_mode = excluded.privacy_mode,
    answer_mode = excluded.answer_mode,
    resolution_status = excluded.resolution_status,
    retrieval_json = excluded.retrieval_json,
    evidence_json = excluded.evidence_json,
    extraction_json = excluded.extraction_json,
    citations_json = excluded.citations_json,
    web_searches_json = excluded.web_searches_json,
    usage_json = excluded.usage_json,
    created_at = excluded.created_at,
    expires_at = excluded.expires_at,
    last_used_at = excluded.last_used_at,
    hit_count = excluded.hit_count
`);

const touchLookupCacheStatement = db.prepare(`
  UPDATE lookup_cache
  SET last_used_at = ?, hit_count = hit_count + 1
  WHERE cache_key = ?
`);

const purgeExpiredLookupCacheStatement = db.prepare(`
  DELETE FROM lookup_cache
  WHERE expires_at != ''
    AND datetime(expires_at) <= datetime(?)
`);

const clearLookupCacheStatement = db.prepare(`
  DELETE FROM lookup_cache
`);

export const store = {
  insertTurn(turn) {
    insertTurnStatement.run(turn);
  },

  getRecentCompletedTurns(limit) {
    return recentTurnsStatement.all(limit).map(parseTurnRow).reverse();
  },

  getDebugTurns(limit = 30) {
    return debugTurnsStatement.all(limit).map(parseTurnRow);
  },

  getTurnById(id) {
    const row = turnByIdStatement.get(id);
    return row ? parseTurnRow(row) : null;
  },

  getRollingSummary() {
    return summaryStatement.get();
  },

  updateRollingSummary(summaryText, updatedAt) {
    updateSummaryStatement.run(summaryText, updatedAt);
  },

  getApprovedFacts() {
    return approvedFactsStatement.all();
  },

  getCandidateFacts() {
    return candidateFactsStatement.all();
  },

  insertCandidateFacts(candidateFacts) {
    runInTransaction((facts) => {
      const normalizedPendingFacts = new Set(
        candidateFactsStatement
          .all()
          .filter((fact) => fact.status === "pending")
          .map((fact) => buildFactFingerprint(fact.fact_text))
      );
      const normalizedApprovedFacts = new Set(
        approvedFactsStatement.all().map((fact) => buildFactFingerprint(fact.fact_text))
      );

      for (const fact of facts) {
        const normalizedFactText = buildFactFingerprint(fact.fact_text);
        if (!normalizedFactText) {
          continue;
        }

        if (
          normalizedPendingFacts.has(normalizedFactText) ||
          normalizedApprovedFacts.has(normalizedFactText)
        ) {
          continue;
        }

        insertCandidateFactStatement.run(fact);
        normalizedPendingFacts.add(normalizedFactText);
      }
    }, candidateFacts);
  },

  getCandidateFactById(id) {
    return candidateFactByIdStatement.get(id) || null;
  },

  approveCandidateFact(id) {
    const candidate = candidateFactByIdStatement.get(id);
    if (!candidate || candidate.status !== "pending") {
      return null;
    }

    const approvedId = candidate.id;
    const now = new Date().toISOString();
    runInTransaction(() => {
      const normalizedCandidateFact = buildFactFingerprint(candidate.fact_text);
      const hasApprovedDuplicate = approvedFactsStatement
        .all()
        .some((fact) => buildFactFingerprint(fact.fact_text) === normalizedCandidateFact);

      if (!hasApprovedDuplicate) {
        insertApprovedFactStatement.run(
          approvedId,
          candidate.fact_text,
          candidate.source_turn_id,
          candidate.category || null,
          now
        );
        resolveCandidateFactStatement.run("approved", now, "approved_by_user", id);
        return;
      }

      resolveCandidateFactStatement.run("rejected", now, "duplicate_of_approved_fact", id);
    });

    const stillApproved = approvedFactsStatement
      .all()
      .find((fact) => buildFactFingerprint(fact.fact_text) === buildFactFingerprint(candidate.fact_text));

    if (!stillApproved) {
      return null;
    }

    return {
      id: stillApproved.id,
      fact_text: stillApproved.fact_text,
      source_turn_id: stillApproved.source_turn_id,
      category: stillApproved.category,
      created_at: stillApproved.created_at,
    };
  },

  rejectCandidateFact(id, resolutionNote = "rejected_by_user") {
    const candidate = candidateFactByIdStatement.get(id);
    if (!candidate || candidate.status !== "pending") {
      return null;
    }

    const now = new Date().toISOString();
    resolveCandidateFactStatement.run("rejected", now, resolutionNote, id);
    return {
      ...candidate,
      status: "rejected",
      resolved_at: now,
      resolution_note: resolutionNote,
    };
  },

  deleteApprovedFact(id) {
    const result = deleteApprovedFactStatement.run(id);
    return result.changes > 0;
  },

  getCompletedTurnCount() {
    return completedTurnCountStatement.get().count;
  },

  getRecentTranscriptWindow(limit) {
    return recentTranscriptWindowStatement.all(limit).reverse();
  },

  getLookupCacheEntry(cacheKey) {
    const row = lookupCacheByKeyStatement.get(cacheKey);
    return row ? parseLookupCacheRow(row) : null;
  },

  upsertLookupCacheEntry(entry) {
    upsertLookupCacheStatement.run({
      cache_key: entry.cache_key,
      question_kind: entry.question_kind,
      privacy_mode: entry.privacy_mode,
      answer_mode: entry.answer_mode,
      resolution_status: entry.resolution_status,
      retrieval_json: entry.retrieval_json,
      evidence_json: entry.evidence_json,
      extraction_json: entry.extraction_json,
      citations_json: entry.citations_json,
      web_searches_json: entry.web_searches_json,
      usage_json: entry.usage_json,
      created_at: entry.created_at,
      expires_at: entry.expires_at,
      last_used_at: entry.last_used_at,
      hit_count: entry.hit_count,
    });
  },

  touchLookupCacheEntry(cacheKey, usedAt = new Date().toISOString()) {
    touchLookupCacheStatement.run(usedAt, cacheKey);
  },

  purgeExpiredLookupCacheEntries(nowIso = new Date().toISOString()) {
    return purgeExpiredLookupCacheStatement.run(nowIso).changes;
  },

  clearLookupCache() {
    clearLookupCacheStatement.run();
  },
};

function parseTurnRow(row) {
  return {
    ...row,
    context_json: safeParseJson(row.context_json, null),
    latency_json: safeParseJson(row.latency_json, null),
    token_json: safeParseJson(row.token_json, null),
    provider_json: safeParseJson(row.provider_json, null),
    failure_json: safeParseJson(row.failure_json, null),
  };
}

function safeParseJson(value, fallback) {
  if (typeof value !== "string" || value.trim() === "") {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseLookupCacheRow(row) {
  return {
    ...row,
    retrieval_json: safeParseJson(row.retrieval_json, {}),
    evidence_json: safeParseJson(row.evidence_json, {}),
    extraction_json: safeParseJson(row.extraction_json, {}),
    citations_json: safeParseJson(row.citations_json, []),
    web_searches_json: safeParseJson(row.web_searches_json, []),
    usage_json: safeParseJson(row.usage_json, null),
  };
}

function runInTransaction(work, ...args) {
  db.exec("BEGIN");
  try {
    const result = work(...args);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function normalizeStoredFactText(value) {
  return String(value || "")
    .trim()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function buildFactFingerprint(value) {
  const normalized = normalizeStoredFactText(value)
    .replace(/^the\s+/, "")
    .replace(/\buser's\b/g, "user")
    .replace(/\bassistant's\b/g, "assistant")
    .replace(/\bhas a routine of\b/g, "follows a routine")
    .replace(/\bworkout routine\b/g, "routine")
    .replace(/\blifting weights\b/g, "lift weights")
    .replace(/\blikes to lift weights\b/g, "lift weights")
    .replace(/\btypically\b/g, "")
    .replace(/\bfour days a week\b/g, "4 days a week")
    .replace(/[.?!]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "";
  }

  if (/\bassistant name is mira\b/.test(normalized) || /\bname is mira\b/.test(normalized) && /\bassistant\b/.test(normalized)) {
    return "assistant:name:mira";
  }

  const userNameMatch = normalized.match(/\buser\b.*\bname is ([a-z][a-z0-9' -]{0,39})$/);
  if (userNameMatch) {
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
