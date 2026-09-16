# TravelBook — frontend

Private-alpha React 19 SPA (Vite + TypeScript) for Kiran's travel-discovery app.
Served from private S3 via CloudFront; the API is same-origin at `/api/v1/...`
(CloudFront proxies `/api/*` to the HTTP API, so the client uses **relative
URLs only** — no CORS config needed).

**Astryx is in use — no fallback was needed.** Verified 2026-09-16:
`@astryxdesign/core@0.6.2` (MIT, maintained by the Meta Astryx team, published
via GitHub Actions the day before the scaffold) + `@astryxdesign/theme-neutral`.
The unrelated `astryx` npm package (v0.0.0 squat) was not used. A Node SSR smoke
test rendered Button/Card/Badge/TextInput/Banner/ProgressBar/SegmentedControl/
Switch/EmptyState/Skeleton/Spinner/TopNav/AppShell/SideNav with the TravelBook
theme (`data-astryx-theme="travelbook"`) and dark mode (`data-theme="dark"`) —
all green. Note: the themes package is `@astryxdesign/theme-neutral`, not
`@astryxdesign/themes` (that name doesn't exist on npm).

## Run

```bash
npm ci
npm run build   # → dist/
npm run dev     # local dev server
```

`npm run build` runs `tsc -b && vite build` (strict TS: `noUnusedLocals`,
`verbatimModuleSyntax` — use `import type` for types, `erasableSyntaxOnly` —
no enums/parameter properties). Bundle is ~768 KB min / ~230 KB gzip, mostly
Astryx + amazon-cognito-identity-js; acceptable for the alpha.

## /config.json contract

`src/config.ts` fetches **`/config.json`** (same-origin) at boot:

```json
{ "region": "us-west-2", "userPoolId": "us-west-2_xxxx", "userPoolClientId": "abc123" }
```

- The **deploy workflow** writes the real file; `public/config.json` is a
  placeholder with blank fields and is never valid for auth.
- If the file is missing or fields are blank, auth screens show a
  "not configured" notice instead of crashing.
- No secrets ever live here — these are public client identifiers.

## Auth (`src/auth/`)

`amazon-cognito-identity-js` (no Amplify): `signUp` (email), `confirmSignUp`
(code), `signIn`, `signOut`, `getCurrentSession` → ID token. `AuthContext`
exposes them plus `config`/`configured`; `<RequireAuth>` guards routes
(unauthenticated → `/login`). The Cognito pool is constructed lazily from
`/config.json` so an unconfigured deploy never throws at import time.

The token is attached as `Authorization: Bearer <idToken>` on every API call
(see `ApiClient`). The API derives identity from the JWT subject — the client
never sends owner IDs.

## API client (`src/api.ts`)

Typed client, all relative (`/api/v1/...`):

| Method | Endpoint |
|---|---|
| PUT | `/v1/preferences` |
| POST | `/v1/feed-jobs` (sends `Idempotency-Key: crypto.randomUUID()`) |
| GET | `/v1/feed-jobs/{id}` |
| GET | `/v1/feed` (`?snapshotId=` optional) |
| GET | `/v1/destinations/{id}` |
| POST | `/v1/reactions` |
| POST | `/v1/trips` |
| PUT | `/v1/trips/{id}/votes/me` |
| POST | `/v1/friends/requests` (`{ email }` preferred, `{ userId }` fallback) |
| POST | `/v1/friends/accept` (`{ requestId }`) |
| GET | `/v1/trips/{id}/recommendations` |

**Integration assumptions (marked `[assumed]` in code)** — not named in the
backend contract; reconcile with the backend engineer:
`GET /v1/trips`, `GET /v1/trips/{id}`, `POST /v1/trips/{id}/members`,
`GET /v1/friends`, `GET /v1/friends/requests/incoming`,
`GET /v1/friends/{sub}/feed`. The client sends `{ ranking: string[] }` on the
vote endpoint and `{ email?, userId? }` on the friend-request endpoint.

Errors surface as `ApiRequestError` with `status` + backend `errorClass`
(`INVALID_PREFERENCES`, `PROVIDER_UNAVAILABLE`, `INSUFFICIENT_EVIDENCE`,
`BUDGET_EXHAUSTED`, `POLICY_BLOCKED`); 401s prompt re-sign-in.

## Screens (`src/screens/`)

- **Preferences** (`Preferences.tsx`) — origin, fixed dates (`DateRangeInput`)
  or flexible month, temp band (default 70/90°F), airfare ceiling (default
  $1000/person), party size, interest chips (incl. **luxury-car events**).
  Submit → `PUT /v1/preferences`; shows the normalized echo (airports,
  bundle hash, version) + backend warnings.
- **Feed** (`Feed.tsx` + `FeedCard.tsx`) — "Generate ideas" → `POST`
  feed-job → polls `GET /v1/feed-jobs/{id}` every 3 s with a determinate
  progress bar → on READY/PARTIAL renders `GET /v1/feed`. Loads the latest
  snapshot on mount. PARTIAL → banner naming failed providers. FAILED →
  error class + retry button.
- **Feed card** — the explainability rule, enforced in UI:
  - Score total + **deterministic breakdown bars** (Airfare 30 %, Weather 25 %,
    Interest 20 %, Travel time 10 %, Freshness 10 %, Novelty 5 %) and any risk
    penalty — always rendered.
  - "Why it matches" (reasons); model narration labeled *"Agent's take"* —
    additive, never the only explanation.
  - "What we found": fare with **Live price** vs **Illustrative** badge (mock
    fares are never shown as live), weather window, matching events.
  - "What could change": expiry/uncertainties + risk blocks with
    severity → UI mapping (Low = note, Moderate = caution, High = expanded
    warning, Critical = do-not-recommend banner, Unknown = "Verify before
    booking").
  - **Every fact gets a source chip** (provider + checked time); stale
    evidence gets a dashed **Stale** chip.
  - Reactions: Like / Save / Hide (optimistic, sticky; Hide removes the card
    locally).
- **Trips** (`Trips.tsx`) — create trip (name + optional dates), member list
  (invite by pasting a member's Cognito user sub — the UI notes this
  limitation), ranked voting with up/down ordering, group-fit recommendations
  (best overall / best budget / best weather / best shared interest + a
  per-member "who benefits, who compromises" view).
- **Friends** (`Friends.tsx`) — send request by email (preferred; user-ID
  paste as fallback, noted in UI), accept incoming (mutual acceptance),
  friends list, read-only view of a friend's **shared** feed. Privacy copy
  throughout: feeds private until shared.

## Theming (`src/theme.ts`, `src/index.css`)

`travelBookTheme = defineTheme({ name: 'travelbook', extends: neutralTheme,
color: { accent: ['#0B7A64', '#3FD6A4'] } })` — Neutral base + deep-sea teal
brand accent, regenerated per light/dark scheme. `<Theme>` `mode` prop drives
light/dark/system, toggled in the TopNav (persisted to localStorage). CSS
import order in `index.css` (layer cascade): `reset.css` →
`astryx.css` → `theme-neutral/theme.css`, then TravelBook custom styles
(`tb-*` classes) built on Astryx token vars (`--color-text-primary`,
`--color-background-card`, `--color-border`, …) so dark mode re-themes them
automatically. No StyleX build plugin needed — the prebuilt dist + theme.css
path is used.

## Component map

| File | What |
|---|---|
| `src/main.tsx`, `src/App.tsx` | Entry; router (`/login`, `/feed`, `/preferences`, `/trips`, `/trips/:id`, `/friends`); Theme + Auth providers |
| `src/components/chrome.tsx` | `AppShell` + `TopNav`: brand, route tabs, theme-mode toggle, sign-out |
| `src/components/bits.tsx` | `SourceChip`, `ScoreBars`, `RiskBlock`, `FareBlock`, `CardSection`, `timeAgo`, `formatMoney` |
| `src/useApi.ts` | Memoized `ApiClient` with a live token provider |

## Astryx usage notes

- Import components from `@astryxdesign/core` (root) or per-component
  subpaths (e.g. `@astryxdesign/core/DateRangeInput` for the `DateRange` type).
- Notable prop shapes: `Button({ label, variant, clickAction })`,
  `Badge({ label, variant })`, `TextInput({ label, value, onChange })`,
  `Banner({ status: 'info'|'warning'|'error'|'success', title, description })`,
  `ProgressBar({ label, value, max })`, `NumberInput({ label, value, onChange })`,
  `SegmentedControl` + `SegmentedControlItem({ value, label })`,
  `Switch({ label, value, onChange })`, `Theme({ theme, mode })`.
- `npx @astryxdesign/cli component <Name>` prints full docs for any component.
- Custom brand CSS should use Astryx token variables, never hardcoded colors.
