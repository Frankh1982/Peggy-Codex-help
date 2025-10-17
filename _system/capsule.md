# Capsule
Project ID: peggy-codex-helper
Repo URL: local
Version: 2024-01-01T00:00:00.000Z

## Goal
Maintain a crisp, capsule-driven situational picture for the operator.

## Plan
- (P1) Review capsule deltas before each response.
- (P2) Capture ledger-worthy events deterministically.
- (P3) Verify sources before surfacing external claims.

## Facts
- Peggy runs locally with file-backed memory and ledger.
- Brave Search powers external lookups when requested.
- Capsule must stay under 2KB and records ≤10 facts.

## Open Decisions
- Pending decisions will be tracked here.

## Last 5 Events
(none)

## Active Workset
- src/server.ts (72b44cd6) capsule-tracking
- src/dsl/executor.ts (cddc5f8b) capsule-tracking
- src/dsl/schema.ts (94d569fe) capsule-tracking
- src/lib/openai.ts (dd031f05) capsule-tracking
- src/agent/context.ts (8d60f285) capsule-tracking
- public/client.js (060fe6cb) capsule-tracking
- public/index.html (0a8f653a) capsule-tracking
- scripts/smoke.ts (b98182d2) capsule-tracking

Capsule Hash: 574010935e76425d69e89039b6f4643cce04dde49d07a3c4cc585e0671268c8e
