# TypeScript Refactor Feature Inventory

This document captures the existing Flask-based behavior that the TypeScript refactor must preserve.

## Framework Decision

Chosen framework: SvelteKit with TypeScript.

Reasons:

- The current app is a stateful web UI plus many JSON/file endpoints, not a React-heavy component app yet.
- SvelteKit provides a small full-stack surface for static page serving, server routes, cookies/sessions, and filesystem-backed state.
- The existing `frontend/index.html` can be preserved initially and migrated incrementally, while the Python backend is replaced first.
- Vite/SvelteKit gives TypeScript, test tooling, and future component migration without forcing a full UI rewrite in the first pass.

Runtime packaging: Docker.

- The UI server builds to a Node runtime image.
- JSON runtime state is stored under `STAR_OFFICE_DATA_DIR` (`/data` in the container).
- `docker-compose.yml` bind-mounts `frontend/` and `assets/` so asset-drawer edits persist outside the container.

## Primary User Scenarios

1. Open the office dashboard.
   - `GET /` returns the main pixel office UI.
   - Static assets under `/static/...` load with cache-friendly headers.
   - The UI polls `/status`, `/agents`, and `/yesterday-memo`.

2. Open Electron/desktop shell page.
   - `GET /electron-standalone` returns `frontend/electron-standalone.html`.

3. Invite or join another agent.
   - `GET /join` returns `frontend/join.html`.
   - `GET /invite` returns `frontend/invite.html`.
   - `POST /join-agent` accepts `{ name, joinKey, state?, detail? }`.
   - Valid join keys auto-approve agents and return `{ ok, agentId, authStatus }`.
   - Re-joining by the same name updates the existing non-main agent.
   - Per-key active concurrency is enforced via `maxConcurrent`.

4. Push remote agent state.
   - `POST /agent-push` accepts `{ agentId, joinKey, state, detail?, name? }`.
   - State aliases are normalized.
   - Approved or offline agents can push.
   - Pushing updates `state`, `detail`, `area`, `updated_at`, and `lastPushAt`.

5. Remove or moderate agents.
   - `POST /leave-agent` removes by `agentId` or fallback `name`.
   - `POST /agent-approve` sets `authStatus=approved`.
   - `POST /agent-reject` rejects and removes the non-main agent.

6. Read and update main agent state.
   - `GET /status` returns `state.json`, with optional `officeName` from OpenClaw `IDENTITY.md`.
   - `POST /set_state` accepts `{ state?, detail? }` and writes `state.json`.
   - Working states auto-return to `idle` after stale TTL.

7. Read yesterday memo.
   - `GET /yesterday-memo` finds yesterday's `memory/YYYY-MM-DD.md`, otherwise the most recent non-today memo.
   - Output is sanitized and returned as `{ success, date?, memo?, msg? }`.

8. Asset drawer authentication.
   - `POST /assets/auth` validates `ASSET_DRAWER_PASS` and sets a session cookie.
   - `GET /assets/auth/status` returns `{ ok, authed, drawer_default_pass }`.
   - Auth-protected asset endpoints return `401` when unauthenticated.

9. List and manage assets.
   - `GET /assets/list` recursively lists image assets under `frontend/`, excluding fonts.
   - `GET /assets/template.zip` downloads `assets-replace-template.zip`.
   - `POST /assets/upload` replaces existing frontend image assets, optionally backing up and optionally converting animated uploads to spritesheets.
   - `POST /assets/restore-default` restores from `.default`.
   - `POST /assets/restore-prev` restores from `.bak`.

10. Persist asset positions/defaults.
    - `GET/POST /assets/positions`
    - `GET/POST /assets/defaults`
    - Values are stored in JSON files keyed by asset id/path.

11. Gemini/runtime config.
    - `GET /config/gemini` returns masked key status and normalized model.
    - `POST /config/gemini` writes `runtime-config.json`.

12. AI background generation.
    - `POST /assets/generate-rpg-background` starts async generation and returns `task_id`.
    - `GET /assets/generate-rpg-background/poll?task_id=...` returns pending/done/error.
    - Missing API key and unavailable model produce stable error codes.

13. Background restore and home favorites.
    - `POST /assets/restore-reference-background`
    - `POST /assets/restore-last-generated-background`
    - `GET /assets/home-favorites/list`
    - `GET /assets/home-favorites/file/:filename`
    - `POST /assets/home-favorites/save-current`
    - `POST /assets/home-favorites/apply`
    - `POST /assets/home-favorites/delete`

14. Operational checks.
    - `GET /health` returns `{ status: "ok", service: "star-office-ui", timestamp }`.
    - `scripts/smoke_test.py` must still pass against the TypeScript server.

## State Files To Preserve

- `state.json`
- `agents-state.json`
- `join-keys.json`
- `asset-positions.json`
- `asset-defaults.json`
- `runtime-config.json`
- `assets/home-favorites/index.json`

## State Mapping

Valid states:

- `idle`
- `writing`
- `researching`
- `executing`
- `syncing`
- `error`

Aliases:

- `working`, `busy`, `write` -> `writing`
- `run`, `running`, `execute`, `exec` -> `executing`
- `sync` -> `syncing`
- `research`, `search` -> `researching`

Area mapping:

- `idle` -> `breakroom`
- `writing`, `researching`, `executing`, `syncing` -> `writing`
- `error` -> `error`
