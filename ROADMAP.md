# Personal Assistant Roadmap

This project is being developed in short, sequential milestones so we can ship, test, and stabilize each layer before moving on.

Guiding rule:

- No new capability phase starts until the previous one is working in real use.

## Milestone 1: Core Voice Loop

Goal:

- A usable local voice assistant skeleton

Deliver:

- Local frontend, backend, and SQLite
- Mic capture, STT, chat, TTS, and playback
- Bounded context package
- Local raw turn history and debug surface

Exit criteria:

- User can speak, get a text reply, and hear audio
- Turns persist locally
- Debug shows timings, token counts, and context preview

Status:

- Done

## Milestone 2: Transport and Runtime Stability

Goal:

- Make the core loop reliable across real browser and backend behavior

Deliver:

- Fix streaming, CORS, and fetch lifecycle issues
- Make cancel and interrupt paths safe
- Ensure successful turns do not surface false errors

Exit criteria:

- Repeated turns work without fetch failures
- Interrupt does not wedge the UI
- Successful replies stay in success state

Status:

- Mostly done

## Milestone 3: Intentional Memory v1

Goal:

- Make durable memory explicit and reviewable

Deliver:

- Candidate facts and approved facts storage
- Out-of-band fact extraction
- Debug/history memory review actions
- Approved facts only in prompt context

Exit criteria:

- Candidate facts appear after suitable turns
- Approve/reject/remove flows work
- Only approved facts are injected later

Status:

- Done

## Milestone 4: Voice UX Hardening

Goal:

- Make the assistant feel dependable in daily use

Deliver:

- Reducer/state-machine turn lifecycle
- Safer playback and stale-event handling
- Retry last turn
- Clearer failure categories and messages
- Stop-audio control and lifecycle debug panel

Exit criteria:

- Retry, interrupt, and playback controls work consistently
- Playback failures are distinguished from reply failures
- Rapid user actions do not corrupt state

Status:

- Done

## Milestone 5: Live QA and Edge-Case Stabilization

Goal:

- Close the gap between "implemented" and "trustworthy"

Deliver:

- Manual QA pass across all turn phases
- Fix edge cases in autoplay, retry, cancel, and TTS fallback
- Tighten debug traces where diagnosis is still weak

Exit criteria:

- Normal use no longer reveals obvious state bugs
- Failures are actionable and understandable
- Debug output is enough to diagnose most issues quickly

Status:

- Done
- Validated in live use against [MILESTONE_5_QA_CHECKLIST.md](/C:/Users/wolf-ai/Workspace/personal-assistant/MILESTONE_5_QA_CHECKLIST.md)

## Milestone 6: Conversation Quality Tuning

Goal:

- Improve how the assistant sounds without adding heavy architecture

Deliver:

- Tune prompt behavior
- Improve summary refresh quality
- Reduce bad candidate-fact extraction and awkward reply patterns

Exit criteria:

- Replies feel more natural and less brittle
- Memory suggestions are conservative and useful
- Latency remains acceptable

Status:

- Done
- Validated in live use through prompt, summary, and memory-behavior tuning passes

## Milestone 7: Product Polish and Companion Presence

Goal:

- Make v1 feel intentionally designed and more like a real companion product

Deliver:

- Lightweight on-screen avatar in the main voice experience
- Dedicated `Memories` tab in the main navigation
- Approved facts and candidate facts visible from a normal UI surface, not only debug/history
- Cleaner voice-screen copy and empty states
- Better memory browsing and review usability
- Setup/run convenience improvements
- Small operational polish in debug/history
- Keep the avatar intentionally lightweight and 2D-first, avoiding any heavy 3D model work

Exit criteria:

- Main screen has a clear visual companion presence without hurting performance
- Users can view memory from a normal UI tab instead of only inside debug
- First-run experience is clear
- Daily-use controls feel obvious
- Debug tools remain available without cluttering the main experience

Status:

- Done
- Validated through local build plus focused UX passes across voice, memories, debug/history, and setup/run flow

## Milestone 8: External Knowledge Access

Goal:

- Let the assistant fetch current information from outside the model's built-in knowledge when needed

Deliver:

- Backend-mediated web lookup flow for current facts and lightweight research
- Clear distinction between model-only answers and externally retrieved answers
- Safe local orchestration so the frontend still talks only to the local backend
- Debug visibility into when external lookup was used and what source material informed the reply
- Privacy-by-default query building that sends the minimum external query needed
- Source-grounded response mode so externally informed answers stay attributable and less hallucinatory
- Explicit handling rules for when personal memory or recent conversation context may be included in an external lookup
- A strict mode that can forbid sending approved facts, summaries, or recent conversation content to lookup providers

Exit criteria:

- The assistant can answer current-information questions using live external data
- Responses make it clear when outside information was used
- Failures to fetch external information are understandable and non-destructive
- The existing local-first architecture remains intact
- External lookup can run in a privacy-preserving mode without materially degrading answer usefulness for common current-information questions

Status:

- In progress
- First live slice uses backend-mediated OpenAI web search with strict privacy-first query construction, source capture, and model-only fallback when lookup fails

## Milestone 9: External Lookup Freshness and Caching

Goal:

- Make current-information lookup faster and cheaper without weakening correctness, freshness, or answer-shaping quality

Deliver:

- A cache design that stores retrieval artifacts or typed structured lookup results instead of blindly reusing fully composed assistant answers
- Cache keys based on normalized lookup intent, privacy mode, and resolution state rather than raw query text alone
- Separate handling for strong answers versus fallback outcomes like `uncertain` or `needs_clarification`
- TTL policy by lookup type with explicit freshness expectations for weather, market data, sports, news, and general current facts
- Debug visibility into cache hit/miss behavior, cache age, and whether a reply was shaped from cached retrieval data or a fresh lookup
- Safe invalidation and expiry behavior that cannot silently pin obviously stale current-information results
- Live QA coverage for freshness-sensitive queries so cache behavior is validated against real turns, not only code review

Exit criteria:

- Repeated current-information questions are measurably faster or cheaper when appropriate
- Cached lookup behavior does not replay the wrong answer for materially different user questions
- Stale or weak retrieval results are not reused in ways that make the assistant less trustworthy
- Debug/history surfaces make it clear when cached retrieval data influenced a reply
- The assistant still composes display and spoken answers appropriately for the exact user question

Status:

- Not started
- Intentionally split out from Milestone 8 so live external lookup quality can be stabilized before cache policy is trusted

## Milestone 10: Self-Knowledge and Explainability

Goal:

- Let the assistant understand its own architecture, limits, recent behavior, and reasoning inputs well enough to answer questions about how it works and help debug itself

Deliver:

- A local self-knowledge context source built from curated project docs, runtime rules, and selected backend/frontend architecture summaries
- Clear answers for questions like how the assistant works, what data it uses, what it stores locally, and what model/provider path handled a turn
- Explainability responses that can summarize why a reply was produced using available context, recent turn data, and debug traces without pretending to know hidden model internals
- A safe debugging-help mode where the assistant can guide investigation of failures using local logs, timings, and stored turn metadata
- Explicit boundaries between true traceable evidence, inferred explanations, and unknown internals

Exit criteria:

- The assistant can accurately answer common self-questions about architecture, memory, storage, provider flow, and current capabilities
- The assistant can explain a recent reply using real local evidence when available
- The assistant can help debug common failures without inventing nonexistent telemetry
- Responses clearly distinguish confirmed evidence from inference

Status:

- Not started

## Working Assumptions

- Milestones stay sequential rather than parallel
- A milestone is only "done" after live use validation, not just code changes
- The product continues to avoid speculative expansion like multi-user, heavy retrieval systems, Docker-era infra, or broad settings surfaces
