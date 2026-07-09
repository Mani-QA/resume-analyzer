# Resume Analyzer

Cloudflare Worker (Hono) that uploads resumes to R2, extracts text, parses fields with Workers AI (`@cf/meta/llama-3.1-8b-instruct-fast`), stores results in D1, and serves a Tailwind CDN UI from the Worker itself.

## Stack

- **Hono** — routing + HTML responses
- **Cloudflare R2** — original file storage
- **Cloudflare D1** — candidate records
- **Cloudflare Queues** — background bulk processing
- **Workers AI** — structured JSON extraction
- **unpdf** / **mammoth** — edge-compatible PDF / DOCX text extraction

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
# or apply incremental migrations:
npx wrangler d1 execute resume-analyzer-db --remote --file=./migrations/0002_status.sql
```

## Develop & deploy

```bash
npm run dev
npm run deploy
```

Workers AI is configured with `remote = true` so local `wrangler dev` uses the real model.

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Upload form + candidates sidebar |
| `POST` | `/upload` | Store file, parse with AI, insert D1, redirect |
| `GET` | `/candidate/:id` | Candidate detail in main pane |
| `GET` | `/download/:id` | Download original file from R2 |
| `GET` | `/admin/scan` | List unprocessed R2 resumes |
| `POST` | `/admin/scan` | Queue unprocessed resumes for background AI |

Queue consumer processes `{ candidateId, r2Key }` messages: extract → AI → update D1 status.
