# API reference (admin features)

All routes are JSON, under `/api`. Every protected request needs the session cookie plus the header `X-Tab-Id` (the browser app sends it);
state-changing requests also need `X-CSRF-Token` (returned by login / `GET /api/auth/me`). Errors look like
`{ "error": "...", "code": "MACHINE_CODE", ... }`. Roles: `VIEWER < MANAGER < ADMIN < SUPER_ADMIN`. Denied attempts are written to the audit log.

## Campaigns
| Method & path | Min role | Notes |
|---|---|---|
| `GET /campaigns?archived=exclude\|include\|only` | VIEWER (`include`/`only`: MANAGER) | Archived hidden by default. Users limited to assigned campaigns only see those. |
| `POST /campaigns` | MANAGER | Body: `name, description, campaign_type (feedback_survey\|follow_up_survey), language (te\|en\|hi), start_date, end_date, window_start, window_end, retries, concurrency, max_duration_s, recording (off\|on)`. Created as `draft`. 409 `DUPLICATE_NAME` for a clashing active name (case-insensitive). |
| `GET /campaigns/:id` | VIEWER | Includes `version`, `questions`, `status_display` (`archived` when archived), `consent_requirement`. |
| `PATCH /campaigns/:id` | MANAGER | Needs `version` (optimistic lock → 409 `CONFLICT`). 409 `PAUSE_REQUIRED` for schedule/language/window/retries/recording/type changes while active; 409 `CONFIRM_REQUIRED` (resend with `"confirm": true`) when calls already exist. Name/description are safe anytime. |
| `PUT /campaigns/:id/questions` | MANAGER | 6 strings per language. Same `PAUSE_REQUIRED` / `CONFIRM_REQUIRED` rules. |
| `POST /campaigns/:id/status` | MANAGER | `{status}`: draft→active\|closed, active→paused\|closed, paused→active\|closed. First activation needs ≥1 eligible contact (`NO_ELIGIBLE_CONTACTS`). |
| `POST /campaigns/:id/duplicate` | MANAGER | Creates a draft copy. |
| `POST /campaigns/:id/archive` | ADMIN, or MANAGER with `can_archive` | `{confirm_name}` must equal the campaign name (`CONFIRMATION_MISMATCH`). Active campaigns must be paused first. Sets `archived_at/by`; nothing is deleted. |
| `POST /campaigns/:id/restore` | same as archive | 409 `DUPLICATE_NAME` if the name is now taken. |
| `GET /campaigns/:id/changes` | MANAGER | Change history: who, when, action, fields (`from`/`to`). |
| `DELETE /campaigns/:id/contacts/:cid` | MANAGER | Only contacts never dialled; campaign must not be active. |
Archived campaigns are read-only (`409 ARCHIVED` on edit, status, import, run) but their calls, transcripts, feedback, analytics and export stay readable.
There is no hard delete; “delete” in the UI means archive.

## Users (ADMIN and above)
| Method & path | Notes |
|---|---|
| `GET /users[?status=]`, `GET /users/:id` | Never returns password hashes or tokens. |
| `POST /users` | `{name, email, phone?, role, campaign_scope?, campaign_ids?, can_archive?}` → creates an **invited** user and returns a one-time `invite_link` (48 h). Creating ADMIN/SUPER_ADMIN needs `reauth_password`. 409 `DUPLICATE_EMAIL`. |
| `PATCH /users/:id` | name, phone, role, scope, `campaign_ids`, `can_archive`. Role changes need `reauth_password`. Role/scope/archive-permission changes end the user's sessions. |
| `POST /users/:id/disable`, `/enable` | Need `reauth_password`. Disable ends all sessions and voids outstanding links. |
| `POST /users/:id/reset` | Need `reauth_password`. Returns a one-time `link` (reset 30 min / invite 48 h); older links stop working. |
Rules: ADMIN manages MANAGER/VIEWER only; SUPER_ADMIN manages everyone; nobody can change their own role, scope or status (`SELF_MODIFICATION`);
the last active SUPER_ADMIN cannot be disabled or demoted (`LAST_SUPER_ADMIN`).

## Public (rate-limited)
| Path | Notes |
|---|---|
| `POST /auth/complete` `{token, password}` | Accepts an invite or reset link once. Applies the password policy (10+ chars, letter + digit/symbol, not common, not the email name), ends all sessions. Generic `INVALID_TOKEN` for unknown/used/expired links. |
| `POST /auth/forgot` `{email}` | Always the same response. No mail server is configured, so it only records a request for administrators (audit action `password_reset_requested`). |
Existing: `POST /auth/login`, `GET /auth/me`, `POST /auth/ping`, `POST /auth/logout`, `GET /audit` (ADMIN).

## Audit actions
`campaign_create, campaign_update, campaign_activate, campaign_resume, campaign_pause, campaign_close, campaign_archive, campaign_restore, script_update, recording_policy_change,
user_create, user_update, user_role_change, user_disable, user_enable, password_reset_initiated, password_reset_requested, password_reset_completed, invite_accepted,
login, login_failed, logout, reauth_failed, access_denied, export, call_view, contacts_import`. Details never contain passwords, tokens or audio URLs.
