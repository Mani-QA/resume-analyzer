# Resume Analyzer

Cloudflare Worker (Hono) that uploads resumes to R2, extracts text, parses fields with Workers AI (`@cf/meta/llama-3.1-8b-instruct-fast`), stores results in D1, and serves a Tailwind CDN UI from the Worker itself.

## Stack

- **Hono** — routing + HTML responses
- **Cloudflare R2** — original file storage
- **Cloudflare D1** — users, sessions, candidate records
- **Cloudflare Queues** — background bulk processing
- **Workers AI** — structured JSON extraction
- **unpdf** / **mammoth** — edge-compatible PDF / DOCX text extraction
- **Auth** — email/password (PBKDF2) + Google OAuth, session cookies

## Setup

```bash
npm install

# Create resources (once)
npx wrangler d1 create resume-analyzer-db
npx wrangler r2 bucket create resume-analyzer-files
npx wrangler queues create resume-analyzer-queue
```

Copy the D1 `database_id` into `wrangler.toml`, then apply the schema:

```bash
npm run db:migrate:local
npm run db:migrate:remote
# or incremental:
npx wrangler d1 execute resume-analyzer-db --remote --file=./migrations/0003_auth.sql
```

### Secrets

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

For local dev, put the same values in `.dev.vars`:

```
SESSION_SECRET=a-long-random-string
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

### Google OAuth client

1. Open [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → **Credentials**.
2. Configure the OAuth consent screen if prompted.
3. **Create credentials** → **OAuth client ID** → Application type **Web application**.
4. Add **Authorized redirect URIs**:
   - Production: `https://resume-analyzer.www5.workers.dev/auth/google/callback`
   - Local: `http://localhost:8787/auth/google/callback`
5. Copy the **Client ID** and **Client Secret**, then set them with `wrangler secret put` (and `.dev.vars` for local).
6. Redeploy: `npm run deploy`.

### Promote an admin

Admins are not auto-created. After signup, set the flag in D1:

```bash
npx wrangler d1 execute resume-analyzer-db --remote --command="UPDATE users SET is_admin = 1 WHERE email = 'you@example.com';"
```

## Develop & deploy

```bash
npm run dev
npm run deploy
```

Workers AI is configured with `remote = true` so local `wrangler dev` uses the real model.

## Access control

- Guests: `/login`, `/signup`, Google OAuth only.
- Users: upload and view/download **only their** candidates.
- Admins (`is_admin = 1`): all candidates (with **Uploaded by**), Scan R2.

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET/POST` | `/signup` | Username / email / password signup |
| `GET/POST` | `/login` | Email / password login |
| `POST` | `/logout` | End session |
| `GET` | `/auth/google` | Start Google OAuth |
| `GET` | `/auth/google/callback` | OAuth callback |
| `GET/POST` | `/auth/google/username` | Unique username after Google signup |
| `GET` | `/` | Marketing landing (guests) or upload app (signed in) |
| `GET` | `/app` | Upload form + candidates sidebar (requires login) |
| `POST` | `/upload` | Store file, parse with AI, insert D1 |
| `GET` | `/candidate/:id` | Candidate detail |
| `GET` | `/download/:id` | Download original file from R2 |
| `GET/POST` | `/admin/scan` | Admin: queue unprocessed R2 resumes |

Queue consumer processes `{ candidateId, r2Key }` messages: extract → AI → update D1 status.
