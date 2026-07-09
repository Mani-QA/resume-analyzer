import { Hono } from "hono";
import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

type QueueMessage = {
  candidateId: string;
  r2Key: string;
};

type Bindings = {
  DB: D1Database;
  RESUME_BUCKET: R2Bucket;
  AI: Ai;
  RESUME_QUEUE: Queue<QueueMessage>;
};

type CandidateRow = {
  id: string;
  name: string | null;
  date_of_birth: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  education: string | null;
  work_experience: string | null;
  responsibilities: string | null;
  achievements: string | null;
  skills: string | null;
  certifications: string | null;
  r2_object_key: string;
  status: string | null;
  error_message: string | null;
  created_at?: string | null;
};

type CandidateSummary = {
  id: string;
  name: string | null;
  email: string | null;
  status: string | null;
  created_at: string | null;
};

type ParsedResume = {
  name: string;
  date_of_birth: string;
  email: string;
  phone: string;
  address: string;
  education: string[];
  work_experience: string[];
  responsibilities: string[];
  achievements: string[];
  skills: string[];
  certifications: string[];
};

const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

const SYSTEM_PROMPT = `You are a resume parsing engine. Extract structured data from the resume text.
Return ONLY a single valid JSON object with exactly these keys:
{
  "name": string,
  "date_of_birth": string,
  "email": string,
  "phone": string,
  "address": string,
  "education": string[],
  "work_experience": string[],
  "responsibilities": string[],
  "achievements": string[],
  "skills": string[],
  "certifications": string[]
}
Formatting rules for array items:
- education: each item as "Degree — Institution (Years)" e.g. "B.S. Computer Science — MIT (2015–2019)"
- work_experience: each item as "Title at Company (Dates) — summary of role"
- responsibilities: concise bullet-style strings, one responsibility per item
- achievements: concise bullet-style strings with metrics when available
- skills: short skill names only (e.g. "TypeScript", "Cloudflare Workers")
- certifications: "Name — Issuer (Year)" when possible
General rules:
- Use empty string "" for missing scalar fields.
- Use empty array [] for missing list fields.
- Do not invent facts that are not in the resume.
- Do not wrap the JSON in markdown fences or add commentary.
- Output must be parseable by JSON.parse.`;

const ALLOWED_EXTENSIONS = new Set([".pdf", ".doc", ".docx"]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const app = new Hono<{ Bindings: Bindings }>();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(idx).toLowerCase() : "";
}

function contentTypeForExtension(ext: string): string {
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (ext === ".doc") return "application/msword";
  return "application/octet-stream";
}

function isResumeKey(key: string): boolean {
  return ALLOWED_EXTENSIONS.has(getExtension(key)) || !key.includes(".");
}

function statusBadge(status: string | null): string {
  const value = (status || "completed").toLowerCase();
  const styles: Record<string, string> = {
    completed: "bg-teal-100 text-teal-800",
    pending: "bg-amber-100 text-amber-800",
    processing: "bg-sky-100 text-sky-800",
    failed: "bg-red-100 text-red-800",
  };
  const cls = styles[value] || "bg-slate-100 text-slate-700";
  return `<span class="inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${cls}">${escapeHtml(value)}</span>`;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : String(item ?? "").trim()))
    .filter(Boolean);
}

function normalizeParsed(raw: Record<string, unknown>): ParsedResume {
  return {
    name: typeof raw.name === "string" ? raw.name.trim() : "",
    date_of_birth: typeof raw.date_of_birth === "string" ? raw.date_of_birth.trim() : "",
    email: typeof raw.email === "string" ? raw.email.trim() : "",
    phone: typeof raw.phone === "string" ? raw.phone.trim() : "",
    address: typeof raw.address === "string" ? raw.address.trim() : "",
    education: toStringArray(raw.education),
    work_experience: toStringArray(raw.work_experience),
    responsibilities: toStringArray(raw.responsibilities),
    achievements: toStringArray(raw.achievements),
    skills: toStringArray(raw.skills),
    certifications: toStringArray(raw.certifications),
  };
}

function getAiResponseText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return String(result ?? "");

  const record = result as Record<string, unknown>;

  if (typeof record.response === "string") return record.response;
  if (typeof record.text === "string") return record.text;
  if (typeof record.result === "string") return record.result;
  if (typeof record.output === "string") return record.output;

  if (Array.isArray(record.output_text)) {
    return record.output_text.map(String).join("\n");
  }

  const choices = record.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
    const message = (choices[0] as { message?: { content?: unknown }; text?: unknown }).message;
    if (message && typeof message.content === "string") return message.content;
    const text = (choices[0] as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }

  if ("name" in record || "email" in record || "skills" in record) {
    return JSON.stringify(record);
  }

  return JSON.stringify(result);
}

function extractJsonObject(text: string): ParsedResume {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("AI returned an empty response. The model may be unavailable.");
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      `AI response did not contain a JSON object. Preview: ${trimmed.slice(0, 200)}`
    );
  }
  const parsed = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  return normalizeParsed(parsed);
}

function heuristicParseResume(resumeText: string): ParsedResume {
  const emailMatch = resumeText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phoneMatch = resumeText.match(
    /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}/
  );
  const lines = resumeText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    name: lines[0]?.slice(0, 120) || "",
    date_of_birth: "",
    email: emailMatch?.[0] || "",
    phone: phoneMatch?.[0] || "",
    address: "",
    education: [],
    work_experience: [],
    responsibilities: [],
    achievements: [],
    skills: [],
    certifications: [],
  };
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

async function extractDocxText(arrayBuffer: ArrayBuffer): Promise<string> {
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value ?? "";
}

function extractLegacyDocText(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i++) {
    const code = bytes[i];
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)) {
      text += String.fromCharCode(code);
    } else if (text.endsWith(" ") === false) {
      text += " ";
    }
  }
  return text.replace(/\s{2,}/g, " ").trim();
}

async function extractResumeText(
  filename: string,
  arrayBuffer: ArrayBuffer
): Promise<string> {
  const ext = getExtension(filename);
  const bytes = new Uint8Array(arrayBuffer);

  if (ext === ".pdf" || (!ext && bytes[0] === 0x25 && bytes[1] === 0x50)) {
    return extractPdfText(bytes);
  }
  if (ext === ".docx") {
    return extractDocxText(arrayBuffer);
  }
  if (ext === ".doc") {
    const salvaged = extractLegacyDocText(bytes);
    if (salvaged.length < 40) {
      throw new Error(
        "Legacy .doc files have limited support. Please convert to .docx or .pdf and try again."
      );
    }
    return salvaged;
  }
  // UUID keys without extension: try PDF first, then DOCX
  try {
    return await extractPdfText(bytes);
  } catch {
    try {
      return await extractDocxText(arrayBuffer);
    } catch {
      const salvaged = extractLegacyDocText(bytes);
      if (salvaged.length >= 40) return salvaged;
      throw new Error("Unsupported file type. Upload a .pdf, .doc, or .docx file.");
    }
  }
}

async function parseResumeWithAi(ai: Ai, resumeText: string): Promise<ParsedResume> {
  const truncated = resumeText.slice(0, 12000);

  try {
    const result = await ai.run(AI_MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Parse this resume into the required JSON object:\n\n${truncated}`,
        },
      ],
      max_tokens: 2048,
      temperature: 0,
    });

    const responseText = getAiResponseText(result);
    return extractJsonObject(responseText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("AI parse failed, using heuristic fallback:", message);
    return heuristicParseResume(resumeText);
  }
}

function parseJsonArrayField(value: string | null): string[] {
  if (!value) return [];
  try {
    return toStringArray(JSON.parse(value));
  } catch {
    return value ? [value] : [];
  }
}

type TimelineParts = {
  title: string;
  meta: string;
  body: string;
};

function parseTimelineItem(item: string): TimelineParts {
  const emDash = item.split(/\s+[—–-]\s+/);
  if (emDash.length >= 2) {
    const head = emDash[0].trim();
    const body = emDash.slice(1).join(" — ").trim();
    const paren = head.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (paren) {
      return { title: paren[1].trim(), meta: paren[2].trim(), body };
    }
    return { title: head, meta: "", body };
  }

  const paren = item.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (paren) {
    return { title: paren[1].trim(), meta: paren[2].trim(), body: "" };
  }

  return { title: item, meta: "", body: "" };
}

function renderTimelineSection(title: string, items: string[], testId: string): string {
  if (!items.length) {
    return `<section class="mt-8" data-testid="${testId}">
      <h2 class="font-display text-xl font-semibold text-ink">${escapeHtml(title)}</h2>
      <p class="mt-2 text-sm text-slate-500">None listed</p>
    </section>`;
  }

  const blocks = items
    .map((item) => {
      const parts = parseTimelineItem(item);
      return `<li class="relative border-l-2 border-teal-200 pl-4">
        <span class="absolute -left-[5px] top-1.5 h-2 w-2 rounded-full bg-accent"></span>
        <p class="font-semibold text-ink">${escapeHtml(parts.title)}</p>
        ${parts.meta ? `<p class="mt-0.5 text-xs font-medium uppercase tracking-wide text-slate-500">${escapeHtml(parts.meta)}</p>` : ""}
        ${parts.body ? `<p class="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">${escapeHtml(parts.body)}</p>` : ""}
      </li>`;
    })
    .join("");

  return `<section class="mt-8" data-testid="${testId}">
    <h2 class="font-display text-xl font-semibold text-ink">${escapeHtml(title)}</h2>
    <ul class="mt-4 space-y-4">${blocks}</ul>
  </section>`;
}

function renderChipSection(title: string, items: string[], testId: string): string {
  if (!items.length) {
    return `<section class="mt-8" data-testid="${testId}">
      <h2 class="font-display text-xl font-semibold text-ink">${escapeHtml(title)}</h2>
      <p class="mt-2 text-sm text-slate-500">None listed</p>
    </section>`;
  }

  const chips = items
    .map(
      (item) =>
        `<li class="rounded-lg border border-teal-200/80 bg-teal-50 px-3 py-1.5 text-sm font-medium text-teal-900">${escapeHtml(item)}</li>`
    )
    .join("");

  return `<section class="mt-8" data-testid="${testId}">
    <h2 class="font-display text-xl font-semibold text-ink">${escapeHtml(title)}</h2>
    <ul class="mt-3 flex flex-wrap gap-2">${chips}</ul>
  </section>`;
}

function renderBulletSection(title: string, items: string[], testId: string): string {
  if (!items.length) {
    return `<section class="mt-8" data-testid="${testId}">
      <h2 class="font-display text-xl font-semibold text-ink">${escapeHtml(title)}</h2>
      <p class="mt-2 text-sm text-slate-500">None listed</p>
    </section>`;
  }

  const lis = items
    .map(
      (item) =>
        `<li class="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">${escapeHtml(item)}</li>`
    )
    .join("");

  return `<section class="mt-8" data-testid="${testId}">
    <h2 class="font-display text-xl font-semibold text-ink">${escapeHtml(title)}</h2>
    <ul class="mt-3 list-disc space-y-2 pl-5">${lis}</ul>
  </section>`;
}

async function listCandidates(db: D1Database): Promise<CandidateSummary[]> {
  const result = await db
    .prepare(
      `SELECT id, name, email, status, created_at
       FROM candidates
       ORDER BY datetime(created_at) DESC, rowid DESC`
    )
    .all<CandidateSummary>();
  return result.results ?? [];
}

function renderSidebar(
  candidates: CandidateSummary[],
  activeId: string | null,
  activeNav: "upload" | "scan" | "candidate"
): string {
  const listHtml = candidates.length
    ? candidates
        .map((c) => {
          const selected = c.id === activeId;
          const label = c.name?.trim() || "Unnamed candidate";
          const email = c.email?.trim() || "No email";
          const search = `${label} ${email}`.toLowerCase();
          return `<div data-candidate-item data-search="${escapeHtml(search)}">
            <a
              href="/candidate/${escapeHtml(c.id)}"
              class="block rounded-xl px-3 py-2.5 transition ${
                selected
                  ? "bg-accent text-white shadow-sm"
                  : "text-slate-700 hover:bg-white/80"
              }"
              data-testid="sidebar-candidate-${escapeHtml(c.id)}"
              aria-current="${selected ? "page" : "false"}"
            >
              <div class="flex items-start justify-between gap-2">
                <span class="truncate text-sm font-semibold">${escapeHtml(label)}</span>
                ${statusBadge(c.status)}
              </div>
              <span class="mt-0.5 block truncate text-xs ${selected ? "text-teal-50" : "text-slate-500"}">${escapeHtml(email)}</span>
            </a>
          </div>`;
        })
        .join("")
    : `<p class="px-3 py-4 text-sm text-slate-500">No candidates yet. Upload a resume to get started.</p>`;

  return `<aside class="flex w-full flex-col border-b border-slate-200/80 bg-white/70 backdrop-blur lg:w-72 lg:shrink-0 lg:border-b-0 lg:border-r" data-testid="candidates-sidebar">
    <div class="border-b border-slate-200/80 px-4 py-4">
      <a href="/" class="block" data-testid="brand-link">
        <p class="text-xs font-bold uppercase tracking-[0.2em] text-accent">Resume Analyzer</p>
        <p class="mt-1 font-display text-lg font-bold text-ink">Candidates</p>
      </a>
      <nav class="mt-4 flex gap-2" aria-label="Primary">
        <a href="/" class="flex-1 rounded-lg px-2 py-1.5 text-center text-xs font-bold ${
          activeNav === "upload" ? "bg-slate-900 text-white" : "bg-mist text-slate-700 hover:bg-slate-200"
        }" data-testid="nav-upload">Upload</a>
        <a href="/admin/scan" class="flex-1 rounded-lg px-2 py-1.5 text-center text-xs font-bold ${
          activeNav === "scan" ? "bg-slate-900 text-white" : "bg-mist text-slate-700 hover:bg-slate-200"
        }" data-testid="nav-scan">Scan R2</a>
      </nav>
      <label for="candidate-filter" class="sr-only">Filter candidates</label>
      <input
        id="candidate-filter"
        type="search"
        placeholder="Filter by name or email"
        class="mt-3 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
        data-testid="candidate-filter"
        aria-label="Filter candidates"
        oninput="
          const q = this.value.toLowerCase();
          document.querySelectorAll('[data-candidate-item]').forEach((el) => {
            el.classList.toggle('hidden', !el.dataset.search.includes(q));
          });
        "
      />
    </div>
    <div class="max-h-64 flex-1 overflow-y-auto p-2 lg:max-h-none" role="list" aria-label="Candidate list">
      ${listHtml}
    </div>
  </aside>`;
}

function appShell(
  title: string,
  candidates: CandidateSummary[],
  activeId: string | null,
  activeNav: "upload" | "scan" | "candidate",
  main: string
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            ink: "#0f172a",
            mist: "#f1f5f9",
            accent: "#0d9488",
            accentDark: "#0f766e"
          },
          fontFamily: {
            display: ["Fraunces", "Georgia", "serif"],
            sans: ["Source Sans 3", "Segoe UI", "sans-serif"]
          }
        }
      }
    };
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet" />
</head>
<body class="min-h-screen bg-gradient-to-br from-slate-100 via-teal-50 to-slate-200 text-ink font-sans antialiased">
  <div class="pointer-events-none fixed inset-0 -z-10 opacity-40" style="background-image:radial-gradient(circle at 20% 20%,rgba(13,148,136,.18),transparent 40%),radial-gradient(circle at 80% 0%,rgba(15,23,42,.08),transparent 35%);"></div>
  <div class="mx-auto flex min-h-screen max-w-7xl flex-col lg:flex-row lg:p-4 lg:gap-0">
    ${renderSidebar(candidates, activeId, activeNav)}
    <main class="min-w-0 flex-1 p-4 sm:p-6 lg:p-8" id="main-content">
      ${main}
    </main>
  </div>
</body>
</html>`;
}

function renderErrorPage(
  message: string,
  status = 400,
  candidates: CandidateSummary[] = []
): Response {
  const html = appShell(
    "Error · Resume Analyzer",
    candidates,
    null,
    "upload",
    `<section class="rounded-2xl border border-red-200 bg-white/90 p-8 shadow-sm backdrop-blur">
      <p class="text-sm font-semibold uppercase tracking-wide text-red-600">Something went wrong</p>
      <h1 class="mt-2 font-display text-3xl font-bold text-ink">Unable to continue</h1>
      <p class="mt-4 text-slate-600">${escapeHtml(message)}</p>
      <a href="/" class="mt-6 inline-flex rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accentDark" data-testid="back-home-link">Back to upload</a>
    </section>`
  );
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderUploadForm(): string {
  return `<section class="overflow-hidden rounded-3xl border border-white/60 bg-white/80 shadow-xl shadow-teal-900/5 backdrop-blur" data-testid="upload-panel">
    <div class="border-b border-slate-200/80 bg-gradient-to-r from-teal-700 to-slate-800 px-6 py-8 text-white sm:px-8">
      <p class="text-sm font-semibold uppercase tracking-[0.2em] text-teal-100">Upload</p>
      <h1 class="mt-3 font-display text-3xl font-bold leading-tight sm:text-4xl">Analyze a resume</h1>
      <p class="mt-3 max-w-2xl text-teal-50/90">PDF, DOC, and DOCX files are parsed with Workers AI and stored in R2 and D1.</p>
    </div>
    <form action="/upload" method="post" enctype="multipart/form-data" class="space-y-6 px-6 py-8 sm:px-8" data-testid="upload-form">
      <div>
        <label for="resume" class="block text-sm font-semibold text-slate-700">Resume file</label>
        <input
          id="resume"
          name="resume"
          type="file"
          accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          required
          class="mt-2 block w-full cursor-pointer rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm text-slate-700 file:mr-4 file:rounded-lg file:border-0 file:bg-accent file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-accentDark"
          data-testid="resume-input"
          aria-label="Choose resume file"
        />
        <p class="mt-2 text-xs text-slate-500">Max 10 MB. Supported: .pdf, .doc, .docx</p>
      </div>
      <button
        type="submit"
        class="inline-flex w-full items-center justify-center rounded-xl bg-accent px-5 py-3 text-sm font-bold text-white transition hover:bg-accentDark focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 sm:w-auto"
        data-testid="upload-button"
        aria-label="Upload and analyze resume"
      >
        Upload &amp; Analyze
      </button>
    </form>
  </section>`;
}

function renderCandidateDetail(row: CandidateRow): string {
  const education = parseJsonArrayField(row.education);
  const workExperience = parseJsonArrayField(row.work_experience);
  const responsibilities = parseJsonArrayField(row.responsibilities);
  const achievements = parseJsonArrayField(row.achievements);
  const skills = parseJsonArrayField(row.skills);
  const certifications = parseJsonArrayField(row.certifications);
  const status = row.status || "completed";

  return `<article class="rounded-3xl border border-white/70 bg-white/85 p-6 shadow-xl shadow-slate-900/5 backdrop-blur sm:p-8" data-testid="candidate-page">
    <div class="flex flex-col gap-4 border-b border-slate-200 pb-6 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <div class="flex flex-wrap items-center gap-2">
          <p class="text-sm font-semibold uppercase tracking-[0.18em] text-accent">Candidate profile</p>
          ${statusBadge(status)}
        </div>
        <h1 class="mt-2 font-display text-3xl font-bold text-ink sm:text-4xl" data-testid="candidate-name">${escapeHtml(row.name || "Unknown")}</h1>
        <p class="mt-2 text-sm text-slate-500">ID: ${escapeHtml(row.id)}</p>
        ${
          row.error_message
            ? `<p class="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="candidate-error">${escapeHtml(row.error_message)}</p>`
            : ""
        }
      </div>
      <a
        href="/download/${escapeHtml(row.id)}"
        class="inline-flex items-center justify-center rounded-xl bg-accent px-4 py-2.5 text-sm font-bold text-white hover:bg-accentDark focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2"
        data-testid="download-button"
        aria-label="Download original resume file"
      >
        Download original
      </a>
    </div>

    <dl class="mt-6 grid gap-4 sm:grid-cols-2">
      <div class="rounded-xl border border-slate-200 bg-mist/60 p-4">
        <dt class="text-xs font-semibold uppercase tracking-wide text-slate-500">Date of birth</dt>
        <dd class="mt-1 text-slate-800" data-testid="candidate-dob">${escapeHtml(row.date_of_birth || "—")}</dd>
      </div>
      <div class="rounded-xl border border-slate-200 bg-mist/60 p-4">
        <dt class="text-xs font-semibold uppercase tracking-wide text-slate-500">Email</dt>
        <dd class="mt-1 break-all text-slate-800" data-testid="candidate-email">${escapeHtml(row.email || "—")}</dd>
      </div>
      <div class="rounded-xl border border-slate-200 bg-mist/60 p-4">
        <dt class="text-xs font-semibold uppercase tracking-wide text-slate-500">Phone</dt>
        <dd class="mt-1 text-slate-800" data-testid="candidate-phone">${escapeHtml(row.phone || "—")}</dd>
      </div>
      <div class="rounded-xl border border-slate-200 bg-mist/60 p-4 sm:col-span-2">
        <dt class="text-xs font-semibold uppercase tracking-wide text-slate-500">Address</dt>
        <dd class="mt-1 whitespace-pre-wrap text-slate-800" data-testid="candidate-address">${escapeHtml(row.address || "—")}</dd>
      </div>
    </dl>

    ${renderTimelineSection("Work experience", workExperience, "list-work-experience")}
    ${renderTimelineSection("Education", education, "list-education")}
    ${renderBulletSection("Responsibilities", responsibilities, "list-responsibilities")}
    ${renderBulletSection("Achievements", achievements, "list-achievements")}
    ${renderChipSection("Skills", skills, "list-skills")}
    ${renderChipSection("Certifications", certifications, "list-certifications")}
  </article>`;
}

async function saveCandidate(
  db: D1Database,
  id: string,
  parsed: ParsedResume,
  r2Key: string,
  status: string,
  errorMessage: string | null = null
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO candidates (
        id, name, date_of_birth, email, phone, address,
        education, work_experience, responsibilities, achievements,
        skills, certifications, r2_object_key, status, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        date_of_birth = excluded.date_of_birth,
        email = excluded.email,
        phone = excluded.phone,
        address = excluded.address,
        education = excluded.education,
        work_experience = excluded.work_experience,
        responsibilities = excluded.responsibilities,
        achievements = excluded.achievements,
        skills = excluded.skills,
        certifications = excluded.certifications,
        r2_object_key = excluded.r2_object_key,
        status = excluded.status,
        error_message = excluded.error_message`
    )
    .bind(
      id,
      parsed.name,
      parsed.date_of_birth,
      parsed.email,
      parsed.phone,
      parsed.address,
      JSON.stringify(parsed.education),
      JSON.stringify(parsed.work_experience),
      JSON.stringify(parsed.responsibilities),
      JSON.stringify(parsed.achievements),
      JSON.stringify(parsed.skills),
      JSON.stringify(parsed.certifications),
      r2Key,
      status,
      errorMessage
    )
    .run();
}

async function processResumeFromR2(
  env: Bindings,
  candidateId: string,
  r2Key: string
): Promise<void> {
  await env.DB.prepare(
    `UPDATE candidates SET status = 'processing', error_message = NULL WHERE id = ?`
  )
    .bind(candidateId)
    .run();

  const object = await env.RESUME_BUCKET.get(r2Key);
  if (!object) {
    throw new Error(`R2 object not found: ${r2Key}`);
  }

  const arrayBuffer = await object.arrayBuffer();
  const filename =
    object.customMetadata?.originalFilename ||
    (getExtension(r2Key) ? r2Key : `${r2Key}.pdf`);

  const resumeText = await extractResumeText(filename, arrayBuffer);
  if (!resumeText.trim()) {
    throw new Error("Could not extract readable text from the document.");
  }

  const parsed = await parseResumeWithAi(env.AI, resumeText);
  await saveCandidate(env.DB, candidateId, parsed, r2Key, "completed", null);
}

async function listAllR2Keys(bucket: R2Bucket): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({ cursor, limit: 1000 });
    for (const obj of listed.objects) {
      if (isResumeKey(obj.key)) {
        keys.push(obj.key);
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return keys;
}

async function getProcessedKeys(db: D1Database): Promise<Set<string>> {
  const result = await db.prepare(`SELECT r2_object_key FROM candidates`).all<{
    r2_object_key: string;
  }>();
  return new Set((result.results ?? []).map((r) => r.r2_object_key));
}

app.get("/", async (c) => {
  const candidates = await listCandidates(c.env.DB);
  return c.html(appShell("Resume Analyzer", candidates, null, "upload", renderUploadForm()));
});

app.post("/upload", async (c) => {
  const candidates = await listCandidates(c.env.DB);
  try {
    const body = await c.req.parseBody();
    const file = body["resume"];

    if (!file || typeof file === "string") {
      return renderErrorPage("Please choose a resume file to upload.", 400, candidates);
    }

    const filename = file.name || "resume";
    const ext = getExtension(filename);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return renderErrorPage("Only .pdf, .doc, and .docx files are accepted.", 400, candidates);
    }

    const arrayBuffer = await file.arrayBuffer();
    if (arrayBuffer.byteLength === 0) {
      return renderErrorPage("The uploaded file is empty.", 400, candidates);
    }
    if (arrayBuffer.byteLength > MAX_FILE_BYTES) {
      return renderErrorPage("File exceeds the 10 MB size limit.", 400, candidates);
    }

    const id = crypto.randomUUID();
    const r2Key = id;
    const contentType = file.type || contentTypeForExtension(ext);

    await c.env.RESUME_BUCKET.put(r2Key, arrayBuffer, {
      httpMetadata: { contentType },
      customMetadata: {
        originalFilename: filename,
        contentType,
      },
    });

    const resumeText = await extractResumeText(filename, arrayBuffer);
    if (!resumeText.trim()) {
      return renderErrorPage(
        "Could not extract readable text from the uploaded document.",
        400,
        candidates
      );
    }

    const parsed = await parseResumeWithAi(c.env.AI, resumeText);
    await saveCandidate(c.env.DB, id, parsed, r2Key, "completed", null);

    return c.redirect(`/candidate/${id}`, 303);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error while processing the resume.";
    console.error("Upload failed:", message);
    return renderErrorPage(message, 500, candidates);
  }
});

app.get("/candidate/:id", async (c) => {
  const id = c.req.param("id");
  const candidates = await listCandidates(c.env.DB);
  const row = await c.env.DB.prepare("SELECT * FROM candidates WHERE id = ?")
    .bind(id)
    .first<CandidateRow>();

  if (!row) {
    return renderErrorPage("Candidate not found.", 404, candidates);
  }

  return c.html(
    appShell(
      `${row.name || "Candidate"} · Resume Analyzer`,
      candidates,
      id,
      "candidate",
      renderCandidateDetail(row)
    )
  );
});

app.get("/admin/scan", async (c) => {
  const candidates = await listCandidates(c.env.DB);
  const r2Keys = await listAllR2Keys(c.env.RESUME_BUCKET);
  const processed = await getProcessedKeys(c.env.DB);
  const unprocessed = r2Keys.filter((key) => !processed.has(key));

  const pendingCount = candidates.filter(
    (x) => x.status === "pending" || x.status === "processing"
  ).length;
  const failedCount = candidates.filter((x) => x.status === "failed").length;

  const flash = c.req.query("queued");
  const flashHtml = flash
    ? `<div class="mb-4 rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-900" data-testid="scan-flash" role="status">
        Queued ${escapeHtml(flash)} resume(s) for background processing.
      </div>`
    : "";

  const rows = unprocessed.length
    ? unprocessed
        .slice(0, 100)
        .map(
          (key) =>
            `<tr class="border-t border-slate-100">
              <td class="px-3 py-2 font-mono text-xs text-slate-700 break-all">${escapeHtml(key)}</td>
            </tr>`
        )
        .join("")
    : `<tr><td class="px-3 py-4 text-sm text-slate-500">No unprocessed resumes found in R2.</td></tr>`;

  const main = `<section class="rounded-3xl border border-white/70 bg-white/85 p-6 shadow-xl backdrop-blur sm:p-8" data-testid="scan-panel">
    <p class="text-sm font-semibold uppercase tracking-[0.18em] text-accent">Admin</p>
    <h1 class="mt-2 font-display text-3xl font-bold text-ink">Scan R2 for unprocessed resumes</h1>
    <p class="mt-3 max-w-2xl text-slate-600">Compare objects in the resume bucket against D1, then queue background AI analysis for anything missing.</p>

    ${flashHtml}

    <dl class="mt-6 grid gap-4 sm:grid-cols-3">
      <div class="rounded-xl border border-slate-200 bg-mist/60 p-4">
        <dt class="text-xs font-semibold uppercase tracking-wide text-slate-500">R2 objects</dt>
        <dd class="mt-1 text-2xl font-bold text-ink" data-testid="scan-r2-count">${r2Keys.length}</dd>
      </div>
      <div class="rounded-xl border border-slate-200 bg-mist/60 p-4">
        <dt class="text-xs font-semibold uppercase tracking-wide text-slate-500">Unprocessed</dt>
        <dd class="mt-1 text-2xl font-bold text-ink" data-testid="scan-unprocessed-count">${unprocessed.length}</dd>
      </div>
      <div class="rounded-xl border border-slate-200 bg-mist/60 p-4">
        <dt class="text-xs font-semibold uppercase tracking-wide text-slate-500">In flight / failed</dt>
        <dd class="mt-1 text-2xl font-bold text-ink" data-testid="scan-inflight-count">${pendingCount} / ${failedCount}</dd>
      </div>
    </dl>

    <form action="/admin/scan" method="post" class="mt-6" data-testid="scan-form">
      <button
        type="submit"
        class="inline-flex items-center justify-center rounded-xl bg-accent px-5 py-3 text-sm font-bold text-white hover:bg-accentDark focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="scan-process-button"
        aria-label="Queue unprocessed resumes for analysis"
        ${unprocessed.length === 0 ? "disabled" : ""}
      >
        Process ${unprocessed.length} unprocessed resume(s)
      </button>
    </form>

    <div class="mt-8 overflow-hidden rounded-xl border border-slate-200">
      <table class="min-w-full text-left" data-testid="unprocessed-table">
        <thead class="bg-mist/80 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <tr><th class="px-3 py-2">R2 object key</th></tr>
        </thead>
        <tbody class="bg-white">${rows}</tbody>
      </table>
      ${
        unprocessed.length > 100
          ? `<p class="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">Showing first 100 of ${unprocessed.length}.</p>`
          : ""
      }
    </div>
  </section>`;

  return c.html(appShell("Scan R2 · Resume Analyzer", candidates, null, "scan", main));
});

app.post("/admin/scan", async (c) => {
  const r2Keys = await listAllR2Keys(c.env.RESUME_BUCKET);
  const processed = await getProcessedKeys(c.env.DB);
  const unprocessed = r2Keys.filter((key) => !processed.has(key));

  let queued = 0;
  const emptyParsed: ParsedResume = {
    name: "",
    date_of_birth: "",
    email: "",
    phone: "",
    address: "",
    education: [],
    work_experience: [],
    responsibilities: [],
    achievements: [],
    skills: [],
    certifications: [],
  };

  for (const r2Key of unprocessed) {
    const candidateId = crypto.randomUUID();
    try {
      await saveCandidate(c.env.DB, candidateId, emptyParsed, r2Key, "pending", null);
      await c.env.DB.prepare(
        `UPDATE candidates SET name = ? WHERE id = ?`
      )
        .bind(`Processing ${r2Key.slice(0, 24)}…`, candidateId)
        .run();

      await c.env.RESUME_QUEUE.send({ candidateId, r2Key });
      queued += 1;
    } catch (error) {
      console.error("Failed to queue", r2Key, error);
    }
  }

  return c.redirect(`/admin/scan?queued=${queued}`, 303);
});

app.get("/download/:id", async (c) => {
  const id = c.req.param("id");
  const candidates = await listCandidates(c.env.DB);
  const row = await c.env.DB.prepare(
    "SELECT id, r2_object_key FROM candidates WHERE id = ?"
  )
    .bind(id)
    .first<{ id: string; r2_object_key: string }>();

  if (!row) {
    return renderErrorPage("Candidate not found.", 404, candidates);
  }

  const object = await c.env.RESUME_BUCKET.get(row.r2_object_key);
  if (!object) {
    return renderErrorPage("Original file not found in storage.", 404, candidates);
  }

  const filename =
    object.customMetadata?.originalFilename || `resume-${row.id}`;
  const contentType =
    object.httpMetadata?.contentType ||
    object.customMetadata?.contentType ||
    "application/octet-stream";

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set(
    "Content-Disposition",
    `attachment; filename="${filename.replace(/"/g, "")}"`
  );
  if (object.size) {
    headers.set("Content-Length", String(object.size));
  }

  return new Response(object.body, { headers });
});

app.notFound(async (c) => {
  const candidates = await listCandidates(c.env.DB).catch(() => [] as CandidateSummary[]);
  return c.html(
    appShell(
      "Not found",
      candidates,
      null,
      "upload",
      `<section class="rounded-2xl border border-slate-200 bg-white/90 p-8">
        <h1 class="font-display text-3xl font-bold">Page not found</h1>
        <a href="/" class="mt-4 inline-block font-semibold text-accent">Go home</a>
      </section>`
    ),
    404
  );
});

async function handleQueue(
  batch: MessageBatch<QueueMessage>,
  env: Bindings
): Promise<void> {
  for (const message of batch.messages) {
    const { candidateId, r2Key } = message.body;
    try {
      await processResumeFromR2(env, candidateId, r2Key);
      message.ack();
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error("Queue processing failed:", candidateId, errMsg);
      await env.DB.prepare(
        `UPDATE candidates SET status = 'failed', error_message = ? WHERE id = ?`
      )
        .bind(errMsg.slice(0, 500), candidateId)
        .run()
        .catch(() => undefined);

      if (message.attempts >= 3) {
        message.ack();
      } else {
        message.retry();
      }
    }
  }
}

export default {
  fetch: app.fetch,
  queue: handleQueue,
};
