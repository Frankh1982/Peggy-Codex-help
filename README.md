# Peggy Codex Helper

Peggy Codex Helper is a small Node.js + TypeScript stack that delivers a local ChatGPT-like interface backed by OpenAI's Responses API, WebSocket streaming, and deterministic state management through a C3-lite DSL. It is opinionated toward critical, concise collaboration with logged guardrails.

## Prerequisites

- Node.js 18 or newer
- npm

## Setup

1. Copy the sample environment file and fill in the keys:
   ```powershell
   Copy-Item .env.example .env
   # or: cp .env.example .env
   ```
2. Edit `.env` with valid keys for OpenAI and Brave Search.
3. Install dependencies and build the initial capsule:
   ```powershell
   npm install
   npm run capsule
   ```

## Running the server

Launch the development server (Express + WebSocket) with streaming replies:
```powershell
npm run dev
```
The server listens on the port configured in `.env` (defaults to 5173) and serves the chat UI from `public/`.

## Scripts

- `npm run dev` – start the development server via `tsx`.
- `npm run capsule` – regenerate `_system/capsule.md` from the capsule inputs.
- `npm run smoke` – run a light WebSocket flow test.
- `npm run clean` – remove the compiled `dist/` output folder.

## Environment variables

| Name            | Description                                |
|-----------------|--------------------------------------------|
| `OPENAI_API_KEY`| API key for OpenAI Responses API.          |
| `BRAVE_API_KEY` | Brave Search API token.                    |
| `MODEL`         | OpenAI model name, defaults to `gpt-4o-mini`. |
| `PORT`          | HTTP port for the Express server (5173).   |

## C3-lite DSL quick reference

All mutations and lookups must be expressed in deterministic C3-lite forms inside code fences:

```
```c3
(GOAL.SET "one-sentence goal")
(PLAN.ADD 1 "detail")
(FILE.WRITE "memory/agent/state.json" overwrite "{\"rev\":2}")
(WEB.SEARCH "query" :count 3)
```
```

The executor validates every action with the schema in `src/dsl/schema.ts`. Invalid or out-of-scope operations are rejected.

## Capsule & Ledger overview

- `_system/make_capsule.ts` gathers the latest goal, plan, facts, ledger entries, and file hashes to build `_system/capsule.md`.
- Logs live in `logs/run-YYYYMMDD.ndjson` and capture tool executions and chat events.
- Chat transcripts are stored in `memory/chat/chat-YYYYMMDD.ndjson`.
- Capsule entries stay within guardrail limits (facts ≤ 10, plan ≤ 7 items, workset ≤ 8 files, etc.).

## Guarantees

- Guardrails enforce deterministic updates via the DSL.
- Tool usage is logged and replayable through the ledger.
- Responses stream to the browser with optional source lists when Brave Search is used.

## Non-guarantees

- The project does not ship a production-ready authentication system.
- There is no persistence beyond the file system layout described here.
- The assistant only knows what is in the capsule, memory files, or returned by tools at runtime.

## Smoke test

Execute a minimal integration test:
```powershell
npm run smoke
```
The script opens a WebSocket session, sends two sample prompts, waits for a streamed response, and verifies `_system/capsule.md` was produced. Successful runs print `SMOKE OK`.

