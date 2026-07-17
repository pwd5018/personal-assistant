# Personal Assistant v1

Small voice-first local desktop web app with:

- `frontend/`: React + Vite voice UI, settings, memories, and debug/history surfaces
- `backend/`: Fastify orchestration server, local SQLite persistence, and shared OpenAI/Gemini/Groq provider routing

Project roadmap:

- [ROADMAP.md](/C:/Users/wolf-ai/Workspace/personal-assistant/ROADMAP.md)

## Setup

1. Copy [backend/.env.example](/C:/Users/wolf-ai/Workspace/personal-assistant/backend/.env.example) to `backend/.env`
2. Set `OPENAI_API_KEY`
3. Install dependencies:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' install
```

4. Start both processes:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run dev
```

5. Open the frontend:

```text
http://127.0.0.1:5173
```

6. First run:

- Press `Click to talk` once and allow microphone permission
- If the UI loads but replies fail, check that `backend/.env` has `OPENAI_API_KEY`
- If memory or debug panels look stale after backend changes, restart `npm run dev`

## Helpful Commands

Run both frontend and backend:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run dev
```

Run only the backend:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run dev:backend
```

Run only the frontend:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run dev:frontend
```

Build both workspaces:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run build
```

Quick health check:

```text
http://127.0.0.1:8787/api/health
```

## Main Endpoints

- `POST /api/voice/turn`: multipart voice turn upload, streamed NDJSON response
- `POST /api/voice/cancel`: cancel active stream/playback for the session
- `GET /api/debug/turns`: recent turn history, rolling summary, approved facts
- `GET /api/debug/turns/:id`: full detail for a single stored turn
- `GET/PATCH /api/settings/privacy`: persisted strict/balanced external lookup privacy mode

## Notes

- The frontend only talks to the local backend.
- Raw transcript history stays local in `backend/data/assistant.sqlite`.
- Provider API keys stay in `backend/.env`; provider/model routing is configured from the browser Settings surface.
- Model inventory discovery is cached and timeout-bounded. A provider inventory outage does not prevent the rest of the app from loading.
- Route failures are recorded with their provider stage: lookup can fall back to chat, TTS preserves a successful text reply, and STT/chat failures remain visible in local history. Cancellation is kept separate from normal fallback.
- Stored turn telemetry includes per-route provider/model, status, duration, usage, cache, and failure metadata when available.
- Current-information lookup is now routed through the local backend when the question looks time-sensitive; the backend uses privacy-first query construction and can fall back to model-only replies if lookup fails.
- If `OPENAI_API_KEY` is missing, `/api/health` still works but live voice turns will fail with an operational error.
- `node:sqlite` is used to avoid native build tooling on this machine; Node currently prints an experimental warning for it at startup.
