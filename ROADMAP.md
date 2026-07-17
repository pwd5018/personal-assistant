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

- Done
- Validated through live-turn stabilization across strict vs balanced privacy modes, source-aware answer shaping, remembered-place resolution, preview/debug reliability, memory-candidate suppression, and backend regression coverage for lookup routing and metadata behavior

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

- Done
- Validated through cache-key normalization, typed retrieval-artifact reuse, TTL policy by lookup type, cache-aware debug metadata, live backend API turns, and regression coverage for freshness-sensitive lookup behavior

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

- Done
- Validated through local self-knowledge answers, evidence-vs-inference boundaries, selected-turn explainability, failure-debug guidance, live `/api/voice/retry` anchoring, browser history actions, 43 backend tests, and a production frontend build

## Milestone 11: Configurable AI Providers and Model Routing

Goal:

- Make model-provider selection a first-class product setting so chat and voice can be routed independently from the browser UI

Deliver:

- A browser-visible settings surface for configuring AI provider and model choices without editing env files for normal experimentation
- Separate routing controls for the main chat/reply path and the voice path so combinations like OpenAI for chat plus Gemini for voice are supported
- Configurable model selection for the lighter-weight summary path as a secondary setting, even if provider-splitting there is lower priority than chat and voice
- A backend provider abstraction that can cleanly support multiple AI vendors for chat, speech-to-text, text-to-speech, lookup decisioning, and related model calls
- Initial additional provider support for Gemini and Groq alongside the existing OpenAI path
- Provider/model-specific voice catalogs with documented source metadata and safe fallback behavior when providers do not expose voice discovery APIs
- Clear validation and fallback behavior when a selected provider does not support a required capability for that path
- Debug visibility showing which provider and model handled each part of a turn
- Safe persistence for provider/model preferences so the current selection survives reloads
- Guardrails in the UI so unsupported or incomplete provider/model combinations are understandable instead of silently failing

Exit criteria:

- The user can choose provider and model configuration from the browser UI
- Chat and voice can be split across different providers without breaking the existing turn flow
- The summary model can also be adjusted from the UI without code or env edits
- OpenAI, Gemini, and Groq are all usable through the shared provider-routing architecture for the capabilities they support
- Unsupported combinations fail clearly and recoverably
- Stored turn/debug metadata makes the chosen provider/model path obvious

Status:

- Done

Validated through browser-configurable provider/model/voice routing, persisted selections, independent chat and voice providers, dynamic model inventory discovery, provider/model-specific voice catalogs, invalid-combination validation, stored routing snapshots, full backend regression coverage, and production frontend/backend builds

## Milestone 12: Low-Latency Voice Delivery and Voice Direction

Goal:

- Reduce the delay between a completed text reply and the beginning of spoken playback, while making supported voice-style controls configurable from the UI

Deliver:

- Model-specific voice-direction capability metadata exposed through the provider catalog
- A browser Settings control for saved voice hint/direction text when the selected TTS model supports it
- Provider-specific hint adaptation for OpenAI instructions, Gemini natural-language TTS direction, and Groq Orpheus vocal directions
- Clear disabled/unsupported behavior for models that do not accept voice hints
- A backend audio-stream event protocol with start, chunk, end, error, and cancellation handling
- An ordered frontend audio queue that can begin playback before the complete spoken response is available
- Native streaming support for Gemini 3.1 TTS where the provider supports audio chunks
- Buffered fallback behavior for Gemini 2.5, unsupported OpenAI models, and other non-streaming routes
- Timing telemetry for time-to-first-audio, first playback, chunk count, total synthesis time, and fallback reason
- Regression and live local validation across hint persistence, provider/model switching, streaming, cancellation, browser playback, and fallback paths

Exit criteria:

- The user can configure a voice hint from the browser without editing env files
- The saved hint is validated against the selected provider/model and is the hint actually used for synthesis
- Supported providers apply hints without speaking the hint text aloud
- Supported streaming models begin playback before the full TTS response completes
- Non-streaming models continue to work through the existing complete-audio path
- Interrupting a turn stops both provider synthesis and queued browser audio
- Debug/history data makes the selected voice, hint capability, streaming mode, and timing path obvious

Status:

- Active

Implementation plan:

1. Establish the voice-direction contract
   - Add model-specific TTS metadata for hint support, direction syntax, and streaming support.
   - Add persisted voice-hint settings without mixing the hint into the selected voice/model identity.
   - Expose the capability and effective saved value through the provider catalog and settings API.
   - Add backend/frontend tests for persistence, model switching, unsupported models, and reset behavior.

2. Ship hint-aware buffered synthesis first
   - Pass the saved hint through the existing voice turn path as structured synthesis options.
   - Adapt the hint per provider: OpenAI instructions, Gemini natural-language direction, and Groq Orpheus vocal directions.
   - Keep the hint out of spoken input so it cannot be read aloud.
   - Record the selected provider/model/voice, hint capability, whether a hint was applied, and the fallback reason in turn telemetry.
   - Validate with mocked provider calls and one live local turn per configured provider/model family.

3. Define and implement the backend audio event protocol
   - Add explicit `audio-start`, `audio-chunk`, `audio-end`, `audio-error`, and `audio-cancelled` events with turn IDs, sequence numbers, MIME/codec metadata, and timing fields.
   - Keep `turn-complete` as the durable text/history boundary; do not make history persistence depend on browser playback success.
   - Ensure cancellation aborts provider synthesis and closes the event stream without converting cancellation into a successful fallback.
   - Preserve the existing complete-audio event as the buffered compatibility path during rollout.

4. Add the streaming provider seam
   - Implement Gemini 3.1 TTS chunk handling against the provider's actual response format, with abort propagation and ordered chunk delivery.
   - Explicitly mark Gemini 2.5, unsupported OpenAI routes, Groq routes, and any provider response that cannot safely stream as buffered.
   - Keep provider-specific wire handling inside provider modules; the server should consume a shared async audio-stream interface.
   - Add deterministic tests for chunk ordering, empty/error chunks, provider aborts, and buffered fallback.

5. Add ordered browser playback and telemetry
   - Replace the single-payload assumption with a per-turn ordered audio consumer that starts playback at the first safe playable boundary.
   - Use a playback mechanism appropriate to the returned codec (MediaSource/Web Audio as required); do not assume arbitrary network chunks are independently playable files.
   - Stop queued and currently playing audio on interrupt, ignore stale events from prior turns, and retain replay only for buffered completed audio.
   - Surface time-to-first-audio, first playback, chunk count, synthesis duration, queue/underrun state, streaming mode, and fallback reason in Debug/History.

6. Closeout and revalidate the parked reliability baseline
   - Run backend regression tests, production builds, API checks, provider/model switching, hint persistence/reset, streaming, cancellation, browser playback, and buffered fallback checks.
   - Re-run Phase 13 readiness/catalog/settings failure checks after the new audio protocol lands.
   - Update README and roadmap validation notes only when live behavior matches the exit criteria.

Execution order:

- First implementation slice: steps 1 and 2 together, ending with a working buffered voice-direction path.
- Second slice: step 3 with compatibility events and cancellation tests.
- Third slice: step 4 for Gemini 3.1 only, then step 5 browser playback.
- Final slice: step 6 and Phase 12 closeout.

Progress:

- Steps 1 and 2 implemented: persisted voice hints, model-specific capability metadata, provider-specific buffered adaptation, unsupported-model validation, Settings controls, and buffered hint telemetry.
- Step 3 implemented: v1 audio-start/chunk/end/error/cancelled events now accompany the buffered path while the legacy complete-audio event remains available to the current browser.
- Step 4 implemented: Gemini 3.1 TTS now consumes Interactions API SSE audio deltas, emits ordered PCM chunks, and finalizes a WAV compatibility payload; Gemini 2.5 and unsupported routes remain buffered.
- Step 5 implemented: the browser now decodes Gemini PCM chunks with Web Audio, schedules them in order, stops queued sources on interruption, and keeps buffered replay compatibility.
- Verified with 64 backend tests and production builds for both workspaces.

Remaining validation:

- A real Gemini 3.1 browser turn is still required to measure time-to-first-audio, confirm browser autoplay behavior, and validate live interruption across provider synthesis and queued playback.

Phase 12 corrective follow-up plan:

1. Repair explicit memory corrections first
   - Detect direct corrections and negative preferences such as "I do not follow X" or "that was only a test question" before normal summary/fact extraction.
   - Mark contradicted summary topics as invalidated for future context and prevent the stale rolling summary from reasserting them.
   - Decide whether a durable negative preference should be saved as an explicit reviewed memory or remain a conversation-local correction; do not silently promote it.
   - Add regression cases for correcting a prior test question, correcting an approved fact, and correcting only one item in a mixed statement.

2. Bound memory-based answers to traceable evidence
   - Make "What do you remember?" enumerate approved facts and clearly labeled confirmed recent context only.
   - Do not present rolling-summary claims as durable facts when they are absent from approved memory or contradicted by the current turn.
   - Prevent unsupported extrapolations such as adding stock interest, travel habits, or other interests not present in the evidence.
   - Add backend tests comparing approved facts, rolling summary, current correction text, and the final answer.

3. Make first-audio latency measurable
   - Record server `audioFirstChunkAt`, streamed chunk count, synthesis completion, and stream fallback details.
   - Record browser `playbackStartedAt`, `playbackEndedAt`, queue delay, and interruption state for streamed turns.
   - Persist or attach the client timing bundle to the corresponding stored turn so Debug/History can compare server and browser timings.
   - Use time-to-first-audio as the primary Phase 12 latency measure; do not treat `ttsComplete` as playback start.

4. Run live acceptance QA
   - Test Gemini 3.1 streaming with a short and long reply, Gemini 2.5 buffered fallback, OpenAI/Groq buffered routes, voice-direction hints, autoplay handling, and mid-stream interruption.
   - Confirm that streamed playback starts before the final compatibility payload arrives and that queued audio stops on cancellation.
   - Re-run the corrected-memory conversation sequence and verify the next turn no longer repeats weather/Yankees claims.
   - Close Phase 12 only after the live results and stored telemetry support the exit criteria; otherwise record the remaining defect explicitly.

Sequencing:

- First fix: explicit correction handling and stale-summary suppression.
- Second fix: evidence-bounded memory answers.
- Third fix: persisted client/server first-audio telemetry.
- Final gate: live provider/browser acceptance QA.

Known risks:

- Browser playback cannot safely consume arbitrary encoded chunks as separate `Audio` files; codec/container framing must be settled before frontend implementation.
- Gemini streaming response details and model availability must be verified against the live provider API before treating streaming as complete.
- Cancellation has two independent surfaces—provider generation and browser queue/playback—and both must be covered by the same turn-ID lifecycle tests.

## Milestone 13: Runtime Reliability and Operational Trust

Goal:

- Make provider routing, model discovery, and settings dependable during normal use and temporary provider outages

Deliver:

- Route-level readiness based on the selected provider and capability, rather than a single provider-wide flag
- Timeout-bounded and cached model inventory discovery with explicit live, cached, fallback, and unavailable states
- Settings refresh, per-route reset, and reset-all controls
- Frontend failure isolation so optional model inventory failures do not hide history, memory, or self-knowledge state
- Clear provider availability and route-readiness indicators in the Settings surface
- Route-specific fallback policy for lookup, STT, chat, TTS, and cancellation paths
- Persisted strict/balanced lookup privacy settings with browser controls
- Route-level telemetry for provider/model, status, duration, usage, cache, and failure details
- Regression and live local API validation for readiness, settings persistence, catalog loading, provider failures, and cancellation

Exit criteria:

- The app remains usable when a provider catalog endpoint is slow or unavailable
- Health reports which selected routes are ready
- Model inventory can be refreshed without restarting the backend
- Saved provider settings can be reset per route or globally
- Settings and supporting docs accurately describe provider configuration and failure states

Status:

- Parked until Milestone 12 is complete
- The previously completed runtime-reliability work remains the baseline for this milestone; any remaining reliability work will be revalidated after the new audio path lands

## Working Assumptions

- Milestones stay sequential rather than parallel
- A milestone is only "done" after live use validation, not just code changes
- The product continues to avoid speculative expansion like multi-user, heavy retrieval systems, Docker-era infra, or broad settings surfaces
