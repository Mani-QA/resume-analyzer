# SPEC.md — Resume Analyzer

> **Specification-Driven Development.** This file is the single source of truth for humans and AI coding agents.
>
> **Agent rule:** Before writing or changing code, read this entire SPEC, produce a short task plan that maps to the requirements below, and wait for human approval of that plan when the change is non-trivial. Do not invent features that contradict **Out of Scope**.

**Version:** 1.0.0  
**Last updated:** 2026-07-09  
**Production URL:** `https://resume-analyzer.www5.workers.dev`

---

## 1. Objective and Vision

### Project Goal

Resume Analyzer is a Cloudflare Worker web application that lets hiring users upload PDF/DOC/DOCX resumes, extract structured candidate data with AI, store originals in object storage, and review profiles in a master-detail UI. Admins can view all candidates and bulk-process unparsed files already in storage.

### Target Audience

| Role | Who | Primary need |
|------|-----|--------------|
| Guest | Prospective users | Understand the product and sign up |
| User | Recruiters / hiring managers | Upload and review **their own** resumes |
| Admin | Operators (`users.is_admin = 1`) | See all candidates, who uploaded them, and scan R2 for unprocessed files |

### Success Criteria

1. Guests see a marketing landing page (not a bare login form) with clear CTAs to sign up / log in.
2. Users can sign up with username + email + password **or** Google OAuth (unique username required after Google).
3. Authenticated users can upload `.pdf` / `.doc` / `.docx` (max 10 MB), get a parsed candidate profile, and download the original file.
4. Users only see candidates where `uploaded_by = their user id`.
5. Admins see all candidates, including **Uploaded by**, and can use `/admin/scan`.
6. Bulk scan enqueues work on Cloudflare Queues; processing updates `status` (`pending` → `processing` → `completed` | `failed`).
7. All UI is served as HTML from the Worker (Hono). No separate Cloudflare Pages project.
8. Code is edge-compatible (no Node.js built-in modules in runtime paths).

---

## 2. Functional Requirements

### Core Features

1. **Marketing landing (`GET /` for guests)**  
   Center-aligned hero branded **Resume Analyzer**, value proposition in plain language (avoid jargon like “Workers AI” in user-facing copy), large **Get started free** CTA, smaller **Already have an account? Log in** link, features and how-it-works sections.

2. **Authenticated app shell (`GET /` when logged in, `GET /app`)**  
   Left sidebar: candidate list (filterable), Upload / Scan R2 (admin only), user menu + logout. Right pane: upload form or candidate detail.

3. **Email/password auth**  
   Signup (`username`, `email`, `password`), login, logout. Passwords hashed with PBKDF2 (Web Crypto). Sessions via HttpOnly cookie + `sessions` table (~30 days).

4. **Google OAuth**  
   Start OAuth → callback → if new user, collect unique username → create session. Link Google to existing email account when email already exists.

5. **Resume upload (`POST /upload`)**  
   Multipart field `resume`. Store file in R2 (key = UUID). Extract text (`unpdf` / `mammoth` / legacy `.doc` salvage). Parse with Workers AI model. Insert D1 row with `uploaded_by`, `status = completed`. Redirect to `/candidate/:id`.

6. **Candidate detail (`GET /candidate/:id`)**  
   Structured display: contact fields; timeline for work/education; bullets for responsibilities/achievements; chips for skills/certifications. Admins see **Uploaded by**. Download button.

7. **Download (`GET /download/:id`)**  
   Stream original from R2 with correct `Content-Type` / `Content-Disposition`. Same access rules as detail view.

8. **Admin R2 scan (`GET/POST /admin/scan`)**  
   List R2 keys that look like resumes and are not in D1. POST creates `pending` rows (`uploaded_by` = admin), enqueues `{ candidateId, r2Key }`. Queue consumer extracts + AI-parses + updates row.

9. **Role model**  
   `is_admin` integer flag on `users`. No auto-admin. Promote via SQL:  
   `UPDATE users SET is_admin = 1 WHERE email = '...';`

### User Flows

#### Guest → Sign up → Upload

1. Open `/` → landing page.  
2. Click **Get started free** → `/signup`.  
3. Submit username, email, password → session cookie → redirect `/` (app shell + upload).  
4. Choose file → **Upload & Analyze** → redirect `/candidate/:id`.  
5. Sidebar lists the new candidate; download original if needed.

#### Guest → Google sign up

1. `/signup` or `/login` → **Continue with Google**.  
2. Google consent → `/auth/google/callback`.  
3. If new: `/auth/google/username` → unique username → session → `/`.  
4. If existing Google or email match: session → `/`.

#### Admin → Bulk scan

1. Log in as admin.  
2. Sidebar **Scan R2** → see unprocessed count.  
3. **Process N unprocessed resume(s)** → queued flash.  
4. Refresh sidebar; statuses move pending → completed/failed.

### Out of Scope

Do **not** build unless a future SPEC revision explicitly adds them:

- Separate Cloudflare Pages frontend or SPA framework (React/Vue/etc.)
- Multi-tenant organizations / teams beyond single-user ownership
- Email verification, password reset, MFA
- Payment / billing
- Real-time WebSocket UI for queue progress
- Native mobile apps
- Editing/re-parsing candidate fields via UI forms
- Deleting candidates or R2 objects via UI
- Public candidate sharing links
- Node.js-only libraries (`fs`, `path`, `pdf-parse` with canvas, etc.)

---

## 3. Technical Constraints

### Tech Stack

| Layer | Choice |
|-------|--------|
| Runtime | Cloudflare Workers |
| Framework | Hono (HTML returned directly) |
| Language | TypeScript |
| Styling | Tailwind CSS via CDN |
| Storage | Cloudflare R2 (`RESUME_BUCKET`) |
| Database | Cloudflare D1 (`DB`) |
| AI | Workers AI binding `AI`, model `@cf/meta/llama-3.1-8b-instruct-fast` |
| Background jobs | Cloudflare Queues (`RESUME_QUEUE` / `resume-analyzer-queue`) |
| PDF text | `unpdf` |
| DOCX text | `mammoth` |
| Auth crypto | Web Crypto PBKDF2 + HMAC for OAuth state/pending cookies |
| CLI | Wrangler 4.x |

### Directory Structure

```
ResumeAnalyzer/
├── SPEC.md                 # This specification
├── README.md               # Human setup / ops docs
├── package.json
├── tsconfig.json
├── wrangler.toml
├── schema.sql              # Full schema (local bootstrap)
├── migrations/
│   ├── 0001_init.sql
│   ├── 0002_status.sql
│   └── 0003_auth.sql
└── src/
    ├── index.ts            # Hono routes, UI HTML, queue consumer
    └── auth.ts             # Password, sessions, Google OAuth helpers
```

### Dependencies (allowed)

**Runtime:** `hono`, `unpdf`, `mammoth`  
**Dev:** `wrangler`, `typescript`, `@cloudflare/workers-types`

Do not add heavy Node-only PDF stacks. Prefer edge-compatible packages.

### System Architecture

```text
Browser
  │  HTML forms / redirects / cookies
  ▼
Hono Worker (src/index.ts)
  ├─ Auth (src/auth.ts) ──► D1 users + sessions
  ├─ Upload / Download ───► R2 RESUME_BUCKET
  ├─ Parse ───────────────► Workers AI (AI.run)
  ├─ Candidates ──────────► D1 candidates
  └─ Admin scan ──────────► Queue RESUME_QUEUE
                              └─ queue() consumer ──► R2 + AI + D1
```

### Bindings & Secrets

**Bindings (wrangler.toml):** `DB`, `RESUME_BUCKET`, `AI`, `RESUME_QUEUE`  
**Secrets:** `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`  
**Flags:** `nodejs_compat`, `compatibility_date` recent

Google redirect URI: `{origin}/auth/google/callback`  
(e.g. `https://resume-analyzer.www5.workers.dev/auth/google/callback`, `http://localhost:8787/auth/google/callback`)

---

## 4. Data Model

### `users`

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| username | TEXT UNIQUE NOT NULL | `^[a-zA-Z0-9_]{3,32}$` |
| email | TEXT UNIQUE NOT NULL | Stored lowercase |
| password_hash | TEXT NULL | `pbkdf2:100000:salt:hash`; null for Google-only |
| google_sub | TEXT UNIQUE NULL | Google subject |
| is_admin | INTEGER NOT NULL DEFAULT 0 | `1` = admin |
| created_at | TEXT | `datetime('now')` |

### `sessions`

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | Opaque token (cookie `session`) |
| user_id | TEXT NOT NULL | FK → users |
| expires_at | TEXT NOT NULL | ~30 days |
| created_at | TEXT | |

### `candidates`

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| name, date_of_birth, email, phone, address | TEXT | Scalars from AI |
| education, work_experience, responsibilities, achievements, skills, certifications | TEXT | JSON **arrays of strings** |
| r2_object_key | TEXT NOT NULL UNIQUE | R2 object key |
| status | TEXT NOT NULL | `pending` \| `processing` \| `completed` \| `failed` |
| error_message | TEXT | Failure detail |
| uploaded_by | TEXT NULL | FK → users; null = legacy / admin-only visibility |
| created_at | TEXT | |

### Access rules

- **User:** `SELECT` / view / download only where `uploaded_by = current_user.id`.  
- **Admin:** all rows; join uploader username/email for display.  
- Legacy rows with `uploaded_by IS NULL`: visible to **admins only**.

### AI JSON shape (example)

```json
{
  "name": "Jane Doe",
  "date_of_birth": "",
  "email": "jane@example.com",
  "phone": "555-0100",
  "address": "City, Country",
  "education": ["B.S. Computer Science — MIT (2015–2019)"],
  "work_experience": ["Engineer at Acme (2020–2024) — Built APIs"],
  "responsibilities": ["Owned resume parsing pipeline"],
  "achievements": ["Reduced screening time by 40%"],
  "skills": ["TypeScript", "Cloudflare Workers"],
  "certifications": ["AWS SAA — Amazon (2023)"]
}
```

### Queue message

```json
{ "candidateId": "uuid", "r2Key": "uuid-or-filename" }
```

### Application state

No client SPA store. Server-rendered HTML + session cookie. Sidebar data loaded per request from D1.

---

## 5. API Contracts

All routes return HTML unless noted. Auth cookie: `session` (HttpOnly, Secure on HTTPS, SameSite=Lax).

| Method | Path | Auth | Behavior |
|--------|------|------|----------|
| GET | `/` | Optional | Guest → landing HTML; user → app shell + upload |
| GET | `/app` | Required | App shell + upload (redirect `/login` if anonymous) |
| GET/POST | `/signup` | Guest | Create password user + session |
| GET/POST | `/login` | Guest | Email/password session |
| POST | `/logout` | Session | Destroy session, clear cookie |
| GET | `/auth/google` | Guest | Redirect to Google authorize |
| GET | `/auth/google/callback` | Guest | OAuth code exchange |
| GET/POST | `/auth/google/username` | Pending Google cookie | Finish Google signup |
| POST | `/upload` | Required | Multipart `resume` → R2 + AI + D1 → 303 `/candidate/:id` |
| GET | `/candidate/:id` | Required + ownership/admin | Detail HTML |
| GET | `/download/:id` | Required + ownership/admin | File bytes |
| GET/POST | `/admin/scan` | Admin | List / enqueue unprocessed R2 keys |

### External APIs

| Service | Purpose |
|---------|---------|
| Google OAuth 2.0 | `accounts.google.com` authorize; `oauth2.googleapis.com/token`; OpenID userinfo |
| Workers AI | `env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", { messages, ... })` |

### Upload form (example)

```html
<form action="/upload" method="post" enctype="multipart/form-data">
  <input type="file" name="resume" accept=".pdf,.doc,.docx" required />
  <button type="submit">Upload &amp; Analyze</button>
</form>
```

### Signup validation errors

Redirect to `/signup?error=<urlencoded message>` for invalid username/email, short password, duplicate username/email.

---

## 6. Edge Cases

### Error Handling

| Situation | Expected behavior |
|-----------|-------------------|
| Anonymous hits protected route | 302 → `/login` |
| Non-admin hits `/admin/scan` | 403 HTML error in app shell |
| User opens another user’s candidate | 404 (do not leak existence) |
| Empty / oversized file (>10 MB) | Error page, no D1 insert |
| Unsupported extension | Error page |
| Unreadable document text | Error page (upload) or `failed` status (queue) |
| AI returns non-JSON / empty | Heuristic fallback parse on upload path; queue path marks `failed` after retries |
| Deprecated / unavailable AI model | Prefer updating model ID in code; keep fallback |
| R2 object missing on download/process | 404 / failed status |
| Google secrets missing | Redirect login with “Google sign-in is not configured” |
| Invalid OAuth state | Reject callback |
| Queue message fails | Update `failed` + `error_message`; retry up to consumer `max_retries` |

### Validation Rules

- Username: 3–32 chars, `[A-Za-z0-9_]` only, unique (case-insensitive check).  
- Email: basic format, max 254, unique (stored lowercase).  
- Password: min 8 characters on signup.  
- Escape all user/AI strings in HTML (`escapeHtml`).  
- Sanitize download filename (strip `"`).  
- R2 keys treated as resumes if extension is `.pdf`/`.doc`/`.docx` **or** key has no extension (UUID uploads).

---

## 7. Testing Requirements

### Automated (expected when adding tests)

- Auth: signup → session cookie; login failure; logout clears session.  
- Authorization: user A cannot `GET /candidate/:id` of user B; admin can.  
- Upload: reject empty/wrong type; happy path inserts `uploaded_by`.  
- Admin scan: non-admin 403; admin enqueue creates `pending` rows.  
- Prefer Playwright E2E with `data-testid` selectors (already present on key UI).  
- Test cases must start with: **Login with [Role]** (User / Admin).

### Manual Verification Checklist

1. Guest `/` shows centered landing, large Get started free, smaller login link; no “Workers AI” jargon in hero.  
2. Sign up → upload PDF → candidate page with structured sections.  
3. Second account cannot see first account’s candidates.  
4. Promote admin via D1 SQL → see all candidates + Uploaded by + Scan R2.  
5. Scan R2 queues unprocessed keys; statuses update after consumer runs.  
6. Download returns original file.  
7. Google OAuth (with secrets configured): new user must pick unique username.

### Agent planning gate

For any non-trivial change:

1. Read `SPEC.md`.  
2. Output a numbered implementation plan referencing SPEC sections.  
3. List files to touch and Out-of-Scope items that remain untouched.  
4. Proceed to code only after the plan is approved (or the user explicitly says to implement).

---

## Appendix A — Ops Commands

```bash
npm install
npx wrangler d1 execute resume-analyzer-db --remote --file=./migrations/0003_auth.sql
npx wrangler secret put SESSION_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler d1 execute resume-analyzer-db --remote --command="UPDATE users SET is_admin = 1 WHERE email = 'you@example.com';"
npm run deploy
```

## Appendix B — UI `data-testid` (automation)

`landing-hero`, `landing-cta-signup`, `landing-cta-login`, `signup-form`, `login-form`, `upload-form`, `resume-input`, `upload-button`, `candidates-sidebar`, `candidate-page`, `candidate-name`, `candidate-uploader`, `download-button`, `scan-panel`, `scan-process-button`, `logout-button`
