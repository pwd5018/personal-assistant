# Milestone 5 QA Checklist

This checklist is the active stabilization pass for the current app state.

## Voice Turn Basics

- [x] Start a new voice turn from idle
- [x] Stop recording and receive a streamed text reply
- [x] Hear spoken playback after a successful reply
- [x] Confirm the completed turn appears in Debug / History

## Interrupt and Cancellation

- [x] Interrupt while listening
- [x] Interrupt while transcribing
- [x] Interrupt while thinking
- [x] Interrupt while speaking
- [x] Confirm interrupt returns the UI to a clean idle state
- [x] Confirm old turn events do not update a newer active turn

## Playback and Autoplay

- [x] Successful text reply is not treated as a failed turn if autoplay is blocked
- [x] `Stop audio` stops active playback cleanly
- [x] `Play audio` can replay a successful reply when audio is available
- [x] Playback failure messaging is non-fatal when assistant text succeeded
- [x] Playback state returns to idle after audio ends

## Retry Flow

- [x] Retry the last recoverable turn after a completed response
- [x] Retry after a playback failure or autoplay block
- [x] Retry does not reuse stale UI state from the prior turn

## Memory and Debug Surfaces

- [x] Candidate facts still appear after suitable turns
- [x] Approve / Reject / Dismiss still work after voice UX changes
- [x] Approved facts remain visible and removable
- [x] Debug lifecycle panel shows useful client and backend timing markers

## Failure Cases

- [x] Microphone permission denial shows a mic-specific error
- [x] Empty or failed transcription shows an STT-specific error
- [x] TTS failure preserves assistant text and does not corrupt turn state
- [x] Network/backend disconnect shows a connection-specific error
