# TypeScript Refactor Test Plan

The refactor is only complete when these tests pass against the new TypeScript/SvelteKit server.

## Baseline Compatibility

The existing smoke test must pass:

```bash
python3 scripts/smoke_test.py --base-url http://127.0.0.1:19000
```

Required endpoints:

- `GET /`
- `GET /health`
- `GET /status`
- `GET /agents`
- `GET /yesterday-memo`
- `POST /set_state`

## Automated Contract Tests

Create a TypeScript test suite that starts the server with an isolated temporary data directory and verifies the API contract.

## Unit Tests

Pure server helpers must be covered without starting the HTTP server:

```bash
npm run test:unit
```

Required groups:

1. Agent state normalization
   - Legacy aliases such as `working`, `busy`, `run`, `sync`, and `research` normalize to the canonical states used by the UI.
   - Missing or unknown states normalize to `idle`.

2. Office area mapping
   - `idle` maps to `breakroom`.
   - `error` maps to `error`.
   - Active states map to `writing`.

3. Gemini model normalization
   - `nanobanana-2` and the legacy `gemini-2.5-flash-image` value normalize to the stored `nanobanana-2` alias.
   - Unknown values fall back to the default `nanobanana-pro` alias used by the UI.

Required groups:

1. Page/static responses
   - `GET /` returns HTML.
   - `GET /electron-standalone` returns HTML.
   - `GET /join` returns HTML.
   - `GET /invite` returns HTML.
   - Static frontend assets are reachable under `/static/...`.

2. Health/status
   - `GET /health` returns service `star-office-ui` and status `ok`.
   - `GET /status` creates default `state.json` if missing.
   - `POST /set_state` writes valid state/detail.
   - Invalid state does not replace the existing state.

3. Agent lifecycle
   - `GET /agents` creates default main `Star` agent if missing.
   - `POST /join-agent` rejects missing name.
   - `POST /join-agent` rejects missing/invalid key.
   - Valid join creates an approved remote agent.
   - Re-joining the same name updates the existing agent, not a duplicate.
   - `POST /agent-push` rejects missing fields.
   - Valid push updates state/detail/name/area/lastPushAt.
   - `POST /leave-agent` removes by agentId.
   - `POST /agent-reject` removes and frees key metadata.

4. Asset auth and protected endpoints
   - Unauthenticated protected asset endpoints return `401`.
   - Correct password authenticates and sets cookie.
   - Auth status returns `authed=true` after login.
   - Positions/defaults GET/POST persist JSON data.

5. Asset listing and restore
   - `GET /assets/list` returns image assets and excludes fonts.
   - Upload rejects path traversal.
   - Upload rejects unsupported extensions.
   - Restore endpoints return stable 404/400 errors when backup/default assets are missing.

6. Gemini config and generation preflight
   - Unauthenticated config endpoints return `401`.
   - Authenticated `GET /config/gemini` masks API key.
   - `POST /config/gemini` persists normalized model.
   - Background generation without API key returns code `MISSING_API_KEY`.
   - Polling a missing task returns 404.

7. Home favorites
   - List creates empty index when missing.
   - Save current background creates item.
   - Apply copies selected favorite to current background.
   - Delete removes index entry and file.

## Manual Browser Verification

After automated tests pass:

1. Start the TypeScript server on port `19000`.
2. Open `http://127.0.0.1:19000`.
3. Confirm the pixel office renders, including background, main Star sprite, and guest list.
4. Switch state from the UI and confirm `/status` updates.
5. Join a guest through `/join` with a valid join key.
6. Confirm guest agent appears and moves area based on pushed state.
7. Open the asset drawer, authenticate, list assets, and confirm protected endpoints are inaccessible after a fresh session.

## Docker Verification

The TypeScript UI server must also run as a Docker container.

Required checks:

```bash
docker build -t star-office-ui:typescript .
docker run --rm -p 19000:19000 \
  -e HOST=0.0.0.0 \
  -e PORT=19000 \
  -e ORIGIN=http://127.0.0.1:19000 \
  -e STAR_OFFICE_DATA_DIR=/data \
  star-office-ui:typescript
```

Then run:

```bash
python3 scripts/smoke_test.py --base-url http://127.0.0.1:19000
```

For day-to-day operation, prefer:

```bash
docker compose up -d --build
```

## Regression Criteria

The refactor fails if:

- Existing frontend fetch paths need to change.
- Existing `office-agent-push.py` can no longer join/push.
- Existing `scripts/smoke_test.py` fails.
- Runtime JSON file formats become incompatible.
- Asset paths can escape the project root.
- Protected asset endpoints work without authentication.
