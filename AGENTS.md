# Repository Guidelines

## Project Structure & Module Organization
`server/src` contains the Node/TypeScript backend. Keep HTTP handlers in `routes/`, domain logic in `services/`, and shared runtime modules such as `config.ts`, `db.ts`, `auth.ts`, and `terminal.ts` at the top level. `ui/src` is the Vite/React dashboard; route-level screens live in `pages/`, with shared client wiring in `api.ts`, `router.ts`, and `styles.css`. `scripts/` holds VPS lifecycle utilities such as `vps-bootstrap.sh`, `deploy-app.sh`, and `backup-restore.sh`. Root docs (`README.md`, `DEPLOY.md`, `AIOS-PRD.md`, onboarding guides) define product and deployment behavior and should stay aligned with code changes.

## Build, Test, and Development Commands
- `cd server && npm install && npm run dev` starts the backend on `http://localhost:3100`.
- `cd ui && npm install && npm run dev` starts the dashboard on `http://localhost:5173` and proxies `/api` and `/webhooks` to the backend.
- `cd server && npm run build` compiles the backend to `server/dist`.
- `cd ui && npm run build` creates the production dashboard bundle in `ui/dist`.
- `cd server && npm test` runs Node's built-in test runner against `dist/**/*.test.js`; build first.
- `bash scripts/deploy-app.sh` rebuilds and installs both apps into `/opt/aios`; use this only on the target VPS with root access.

## Coding Style & Naming Conventions
Use strict TypeScript and match the existing style: 2-space indentation, semicolons, and double-quoted imports/strings. React page components use PascalCase filenames such as `DepartmentDetail.tsx`; backend modules use lower-case, descriptive filenames such as `services/sync.ts` and `routes/github.ts`. Prefer small, single-purpose modules and camelCase for exported functions.

## Testing Guidelines
Backend tests are committed as `*.test.ts` under `server/src/routes` and `server/src/services`. Add coverage near the feature being exercised, then run `cd server && npm run build && npm test` because the test runner targets compiled files in `server/dist`. For UI changes, manually verify the affected flow with both local servers running, especially setup, auth, routing, storage, and terminal-related behavior.

## Commit & Pull Request Guidelines
Recent commits use short, imperative subjects. Follow that pattern, keep the summary specific, and separate unrelated changes. Pull requests should include scope, risk, verification commands, linked issues when relevant, and screenshots for dashboard-facing changes.

## Security & Configuration Notes
Do not commit `.env`, `data/`, `logs/`, build artifacts, or provider credentials. When changing onboarding, auth, or deployment behavior, update the matching docs in the same change so operators do not end up with stale runbooks.
