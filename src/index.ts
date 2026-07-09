import { Hono } from "hono";
import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";
import {
  type AuthUser,
  type AuthVariables,
  clearOAuthStateCookie,
  clearPendingGoogleCookie,
  clearSessionCookie,
  createGoogleUser,
  createOAuthState,
  createPasswordUser,
  createSession,
  destroySession,
  exchangeGoogleCode,
  findUserByEmail,
  findUserByGoogleSub,
  findUserByUsername,
  getOAuthStateCookie,
  getPendingGoogle,
  getSessionId,
  getUserFromSession,
  googleAuthUrl,
  googleCallbackUrl,
  hashPassword,
  isAdmin,
  isSecureRequest,
  isValidEmail,
  isValidUsername,
  linkGoogleSub,
  setOAuthStateCookie,
  setPendingGoogleCookie,
  setSessionCookie,
  verifyOAuthState,
  verifyPassword,
} from "./auth";

type QueueMessage = {
  candidateId: string;
  r2Key: string;
};

type Bindings = {
  DB: D1Database;
  RESUME_BUCKET: R2Bucket;
  AI: Ai;
  RESUME_QUEUE: Queue<QueueMessage>;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
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
  uploaded_by: string | null;
  uploader_username?: string | null;
  uploader_email?: string | null;
  created_at?: string | null;
};

type CandidateSummary = {
  id: string;
  name: string | null;
  email: string | null;
  status: string | null;
  created_at: string | null;
  uploaded_by?: string | null;
  uploader_username?: string | null;
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

const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();

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

async function listCandidates(
  db: D1Database,
  user: AuthUser
): Promise<CandidateSummary[]> {
  if (isAdmin(user)) {
    const result = await db
      .prepare(
        `SELECT c.id, c.name, c.email, c.status, c.created_at, c.uploaded_by,
                u.username AS uploader_username
         FROM candidates c
         LEFT JOIN users u ON u.id = c.uploaded_by
         ORDER BY datetime(c.created_at) DESC, c.rowid DESC`
      )
      .all<CandidateSummary>();
    return result.results ?? [];
  }

  const result = await db
    .prepare(
      `SELECT id, name, email, status, created_at, uploaded_by
       FROM candidates
       WHERE uploaded_by = ?
       ORDER BY datetime(created_at) DESC, rowid DESC`
    )
    .bind(user.id)
    .all<CandidateSummary>();
  return result.results ?? [];
}

async function getCandidateForUser(
  db: D1Database,
  id: string,
  user: AuthUser
): Promise<CandidateRow | null> {
  if (isAdmin(user)) {
    return (
      (await db
        .prepare(
          `SELECT c.*, u.username AS uploader_username, u.email AS uploader_email
           FROM candidates c
           LEFT JOIN users u ON u.id = c.uploaded_by
           WHERE c.id = ?`
        )
        .bind(id)
        .first<CandidateRow>()) ?? null
    );
  }

  return (
    (await db
      .prepare(`SELECT * FROM candidates WHERE id = ? AND uploaded_by = ?`)
      .bind(id, user.id)
      .first<CandidateRow>()) ?? null
  );
}

function renderAuthLayout(title: string, body: string): string {
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
  <header class="mx-auto flex max-w-md items-center justify-between px-4 pt-6">
    <a href="/" class="font-display text-lg font-bold text-ink" data-testid="auth-brand-link">Resume Analyzer</a>
    <a href="/login" class="text-sm font-semibold text-accent hover:text-accentDark" data-testid="auth-login-link">Log in</a>
  </header>
  <main class="mx-auto flex min-h-[calc(100vh-5rem)] max-w-md items-center px-4 py-10">
    ${body}
  </main>
</body>
</html>`;
}

function renderLandingPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Resume Analyzer — AI resume parsing for hiring teams</title>
  <meta name="description" content="Upload resumes, extract structured candidate data with AI, and keep every profile organized in one place." />
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
          },
          keyframes: {
            rise: {
              "0%": { opacity: "0", transform: "translateY(18px)" },
              "100%": { opacity: "1", transform: "translateY(0)" }
            },
            drift: {
              "0%, 100%": { transform: "translate3d(0,0,0) scale(1)" },
              "50%": { transform: "translate3d(2%, -3%, 0) scale(1.05)" }
            },
            shimmer: {
              "0%": { backgroundPosition: "0% 50%" },
              "100%": { backgroundPosition: "100% 50%" }
            }
          },
          animation: {
            rise: "rise 0.8s ease-out both",
            "rise-delay": "rise 0.8s ease-out 0.15s both",
            "rise-delay-2": "rise 0.8s ease-out 0.3s both",
            drift: "drift 14s ease-in-out infinite",
            shimmer: "shimmer 8s linear infinite"
          }
        }
      }
    };
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet" />
</head>
<body class="bg-slate-950 text-white font-sans antialiased">
  <header class="absolute inset-x-0 top-0 z-20">
    <div class="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6 lg:px-8">
      <a href="/" class="font-display text-xl font-bold tracking-tight text-white" data-testid="landing-brand">Resume Analyzer</a>
      <nav class="flex items-center gap-3" aria-label="Account">
        <a href="/login" class="rounded-lg px-3 py-2 text-sm font-semibold text-teal-50/90 hover:text-white" data-testid="landing-login">Log in</a>
        <a href="/signup" class="rounded-lg bg-white px-4 py-2 text-sm font-bold text-slate-900 hover:bg-teal-50" data-testid="landing-signup">Sign up</a>
      </nav>
    </div>
  </header>

  <section class="relative min-h-screen overflow-hidden" data-testid="landing-hero" aria-label="Hero">
    <div class="absolute inset-0 bg-[radial-gradient(ellipse_at_20%_20%,rgba(13,148,136,0.45),transparent_50%),radial-gradient(ellipse_at_80%_10%,rgba(15,23,42,0.9),transparent_45%),linear-gradient(160deg,#042f2e_0%,#0f172a_45%,#134e4a_100%)]"></div>
    <div class="animate-drift absolute -left-24 top-24 h-72 w-72 rounded-full bg-teal-400/20 blur-3xl"></div>
    <div class="animate-drift absolute bottom-10 right-0 h-96 w-96 rounded-full bg-cyan-300/10 blur-3xl" style="animation-delay:-4s"></div>
    <div class="relative z-10 mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-4 pb-20 pt-28 text-center sm:px-6">
      <p class="animate-rise font-display text-5xl font-bold leading-none tracking-tight text-white sm:text-6xl md:text-7xl" data-testid="landing-brand-hero">Resume Analyzer</p>
      <h1 class="animate-rise-delay mt-6 font-display text-3xl font-semibold leading-tight text-teal-50 sm:text-4xl md:text-5xl">
        Turn every resume into a clear candidate profile
      </h1>
      <p class="animate-rise-delay-2 mt-5 max-w-xl text-lg leading-relaxed text-teal-100/85">
        Upload PDF or Word resumes. Smart AI pulls out contact details, experience, skills, and more—so you can review candidates faster.
      </p>
      <div class="animate-rise-delay-2 mt-10 flex w-full max-w-md flex-col items-center gap-4">
        <a href="/signup" class="inline-flex w-full items-center justify-center rounded-2xl bg-accent px-8 py-4 text-lg font-bold text-white shadow-lg shadow-teal-950/40 transition hover:bg-accentDark focus:outline-none focus:ring-2 focus:ring-teal-200 focus:ring-offset-2 focus:ring-offset-slate-900 sm:text-xl" data-testid="landing-cta-signup" aria-label="Get started free with Resume Analyzer">
          Get started free
        </a>
        <p class="text-sm text-teal-100/80">
          Already have an account?
          <a href="/login" class="ml-1 font-semibold text-white underline decoration-white/40 underline-offset-4 hover:decoration-white" data-testid="landing-cta-login" aria-label="Log in to Resume Analyzer">Log in</a>
        </p>
      </div>
    </div>
  </section>

  <section class="bg-mist py-20 text-ink" aria-labelledby="features-heading">
    <div class="mx-auto max-w-6xl px-4 text-center sm:px-6 lg:px-8">
      <h2 id="features-heading" class="font-display text-3xl font-bold text-ink sm:text-4xl">Built for structured hiring reviews</h2>
      <p class="mx-auto mt-3 max-w-2xl text-slate-600">One upload becomes a searchable profile with the fields recruiters actually need.</p>
      <ul class="mt-12 grid gap-10 text-left md:grid-cols-3 md:text-center">
        <li>
          <p class="text-xs font-bold uppercase tracking-[0.18em] text-accent">Parse</p>
          <h3 class="mt-2 font-display text-xl font-semibold">Smart AI extraction</h3>
          <p class="mt-2 text-slate-600">Pull name, contact info, education, work history, skills, and certifications from PDF and Word files.</p>
        </li>
        <li>
          <p class="text-xs font-bold uppercase tracking-[0.18em] text-accent">Organize</p>
          <h3 class="mt-2 font-display text-xl font-semibold">Your candidate library</h3>
          <p class="mt-2 text-slate-600">Browse uploads in a sidebar, open any profile instantly, and download the original resume when you need it.</p>
        </li>
        <li>
          <p class="text-xs font-bold uppercase tracking-[0.18em] text-accent">Scale</p>
          <h3 class="mt-2 font-display text-xl font-semibold">Bulk resume processing</h3>
          <p class="mt-2 text-slate-600">Admins can scan existing files in storage and run analysis in the background for resumes that are not yet parsed.</p>
        </li>
      </ul>
    </div>
  </section>

  <section class="bg-white py-20 text-ink" aria-labelledby="how-heading">
    <div class="mx-auto max-w-6xl px-4 text-center sm:px-6 lg:px-8">
      <h2 id="how-heading" class="font-display text-3xl font-bold sm:text-4xl">How it works</h2>
      <ol class="mt-10 grid gap-8 text-left sm:grid-cols-3 sm:text-center">
        <li class="border-t-2 border-accent pt-4">
          <p class="text-sm font-bold text-accent">01</p>
          <h3 class="mt-2 font-display text-xl font-semibold">Create an account</h3>
          <p class="mt-2 text-slate-600">Sign up with email or Google. Your uploads stay private to your account.</p>
        </li>
        <li class="border-t-2 border-accent pt-4">
          <p class="text-sm font-bold text-accent">02</p>
          <h3 class="mt-2 font-display text-xl font-semibold">Upload a resume</h3>
          <p class="mt-2 text-slate-600">Drop in a PDF or Word file. We store the original securely and read the content automatically.</p>
        </li>
        <li class="border-t-2 border-accent pt-4">
          <p class="text-sm font-bold text-accent">03</p>
          <h3 class="mt-2 font-display text-xl font-semibold">Review the profile</h3>
          <p class="mt-2 text-slate-600">See experience, skills, and more in a clean layout—ready for screening decisions.</p>
        </li>
      </ol>
    </div>
  </section>

  <section class="relative overflow-hidden bg-slate-900 py-20 text-white" aria-labelledby="cta-heading">
    <div class="absolute inset-0 bg-[linear-gradient(120deg,rgba(13,148,136,0.35),transparent_55%)]"></div>
    <div class="relative mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
      <h2 id="cta-heading" class="font-display text-3xl font-bold sm:text-4xl">Start analyzing resumes today</h2>
      <p class="mx-auto mt-3 max-w-xl text-teal-100/80">Create a free account and upload your first resume in minutes.</p>
      <a href="/signup" class="mt-8 inline-flex w-full max-w-md items-center justify-center rounded-2xl bg-accent px-8 py-4 text-lg font-bold text-white hover:bg-accentDark sm:text-xl" data-testid="landing-footer-signup" aria-label="Sign up now">
        Get started free
      </a>
      <p class="mt-4 text-sm text-teal-100/80">
        Already have an account?
        <a href="/login" class="ml-1 font-semibold text-white underline decoration-white/40 underline-offset-4 hover:decoration-white" data-testid="landing-footer-login">Log in</a>
      </p>
    </div>
  </section>

  <footer class="border-t border-slate-800 bg-slate-950 py-8 text-center text-sm text-slate-400">
    <div class="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
      <p class="font-display font-semibold text-slate-200">Resume Analyzer</p>
      <p class="mt-1">AI-powered resume parsing for hiring teams.</p>
    </div>
  </footer>
</body>
</html>`;
}

function renderSidebar(
  candidates: CandidateSummary[],
  activeId: string | null,
  activeNav: "upload" | "scan" | "candidate",
  user: AuthUser | null
): string {
  const listHtml = candidates.length
    ? candidates
        .map((c) => {
          const selected = c.id === activeId;
          const label = c.name?.trim() || "Unnamed candidate";
          const email = c.email?.trim() || "No email";
          const uploader =
            user && isAdmin(user) && c.uploader_username
              ? ` · @${c.uploader_username}`
              : "";
          const search = `${label} ${email} ${c.uploader_username || ""}`.toLowerCase();
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
              <span class="mt-0.5 block truncate text-xs ${selected ? "text-teal-50" : "text-slate-500"}">${escapeHtml(email)}${escapeHtml(uploader)}</span>
            </a>
          </div>`;
        })
        .join("")
    : `<p class="px-3 py-4 text-sm text-slate-500">No candidates yet. Upload a resume to get started.</p>`;

  const scanNav =
    user && isAdmin(user)
      ? `<a href="/admin/scan" class="flex-1 rounded-lg px-2 py-1.5 text-center text-xs font-bold ${
          activeNav === "scan" ? "bg-slate-900 text-white" : "bg-mist text-slate-700 hover:bg-slate-200"
        }" data-testid="nav-scan">Scan R2</a>`
      : "";

  const userBlock = user
    ? `<div class="mt-4 rounded-xl border border-slate-200 bg-white/80 px-3 py-2" data-testid="user-menu">
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0">
            <p class="truncate text-sm font-semibold text-ink">@${escapeHtml(user.username)}</p>
            <p class="truncate text-xs text-slate-500">${escapeHtml(user.email)}</p>
          </div>
          ${
            isAdmin(user)
              ? `<span class="shrink-0 rounded-md bg-slate-900 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">Admin</span>`
              : ""
          }
        </div>
        <form action="/logout" method="post" class="mt-2">
          <button type="submit" class="w-full rounded-lg bg-mist px-2 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-200" data-testid="logout-button" aria-label="Log out">Log out</button>
        </form>
      </div>`
    : "";

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
        ${scanNav}
      </nav>
      ${userBlock}
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
  main: string,
  user: AuthUser | null = null
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
    ${renderSidebar(candidates, activeId, activeNav, user)}
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
  candidates: CandidateSummary[] = [],
  user: AuthUser | null = null
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
    </section>`,
    user
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
      <p class="mt-3 max-w-2xl text-teal-50/90">PDF, DOC, and DOCX files are analyzed with AI and saved securely for your account.</p>
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

function renderCandidateDetail(row: CandidateRow, viewer: AuthUser): string {
  const education = parseJsonArrayField(row.education);
  const workExperience = parseJsonArrayField(row.work_experience);
  const responsibilities = parseJsonArrayField(row.responsibilities);
  const achievements = parseJsonArrayField(row.achievements);
  const skills = parseJsonArrayField(row.skills);
  const certifications = parseJsonArrayField(row.certifications);
  const status = row.status || "completed";

  const uploaderLabel = row.uploader_username
    ? `@${row.uploader_username}${row.uploader_email ? ` (${row.uploader_email})` : ""}`
    : row.uploaded_by
      ? row.uploaded_by
      : "Unknown";

  const uploaderBlock = isAdmin(viewer)
    ? `<div class="rounded-xl border border-slate-200 bg-mist/60 p-4 sm:col-span-2">
        <dt class="text-xs font-semibold uppercase tracking-wide text-slate-500">Uploaded by</dt>
        <dd class="mt-1 text-slate-800" data-testid="candidate-uploader">${escapeHtml(uploaderLabel)}</dd>
      </div>`
    : "";

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
      ${uploaderBlock}
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
  errorMessage: string | null = null,
  uploadedBy: string | null = null
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO candidates (
        id, name, date_of_birth, email, phone, address,
        education, work_experience, responsibilities, achievements,
        skills, certifications, r2_object_key, status, error_message, uploaded_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        error_message = excluded.error_message,
        uploaded_by = COALESCE(excluded.uploaded_by, candidates.uploaded_by)`
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
      errorMessage,
      uploadedBy
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
  await saveCandidate(env.DB, candidateId, parsed, r2Key, "completed", null, null);
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
  const user = await getUserFromSession(c.env.DB, getSessionId(c));
  if (!user) {
    return c.html(renderLandingPage());
  }
  c.set("user", user);
  const candidates = await listCandidates(c.env.DB, user);
  return c.html(
    appShell("Resume Analyzer", candidates, null, "upload", renderUploadForm(), user)
  );
});

app.get("/app", async (c) => {
  const user = await getUserFromSession(c.env.DB, getSessionId(c));
  if (!user) return c.redirect("/login", 302);
  c.set("user", user);
  const candidates = await listCandidates(c.env.DB, user);
  return c.html(
    appShell("Resume Analyzer", candidates, null, "upload", renderUploadForm(), user)
  );
});

app.get("/signup", async (c) => {
  const user = await getUserFromSession(c.env.DB, getSessionId(c));
  if (user) return c.redirect("/", 302);
  const error = c.req.query("error") || "";
  return c.html(
    renderAuthLayout(
      "Sign up · Resume Analyzer",
      `<section class="w-full rounded-3xl border border-white/70 bg-white/90 p-8 shadow-xl" data-testid="signup-panel">
        <p class="text-xs font-bold uppercase tracking-[0.2em] text-accent">Resume Analyzer</p>
        <h1 class="mt-2 font-display text-3xl font-bold text-ink">Create account</h1>
        ${error ? `<p class="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="auth-error">${escapeHtml(error)}</p>` : ""}
        <form action="/signup" method="post" class="mt-6 space-y-4" data-testid="signup-form">
          <div>
            <label for="username" class="block text-sm font-semibold text-slate-700">Username</label>
            <input id="username" name="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_]+" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" data-testid="signup-username" aria-label="Username" />
          </div>
          <div>
            <label for="email" class="block text-sm font-semibold text-slate-700">Email</label>
            <input id="email" name="email" type="email" required class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" data-testid="signup-email" aria-label="Email" />
          </div>
          <div>
            <label for="password" class="block text-sm font-semibold text-slate-700">Password</label>
            <input id="password" name="password" type="password" required minlength="8" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" data-testid="signup-password" aria-label="Password" />
          </div>
          <button type="submit" class="w-full rounded-xl bg-accent px-4 py-3 text-sm font-bold text-white hover:bg-accentDark" data-testid="signup-submit">Sign up</button>
        </form>
        <a href="/auth/google" class="mt-4 flex w-full items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-bold text-slate-800 hover:bg-mist" data-testid="google-signup">Continue with Google</a>
        <p class="mt-4 text-center text-sm text-slate-600">Already have an account? <a href="/login" class="font-semibold text-accent" data-testid="login-link">Log in</a></p>
      </section>`
    )
  );
});

app.post("/signup", async (c) => {
  const body = await c.req.parseBody();
  const username = String(body["username"] || "").trim();
  const email = String(body["email"] || "").trim().toLowerCase();
  const password = String(body["password"] || "");

  if (!isValidUsername(username)) {
    return c.redirect("/signup?error=" + encodeURIComponent("Username must be 3–32 characters: letters, numbers, underscore."), 303);
  }
  if (!isValidEmail(email)) {
    return c.redirect("/signup?error=" + encodeURIComponent("Enter a valid email address."), 303);
  }
  if (password.length < 8) {
    return c.redirect("/signup?error=" + encodeURIComponent("Password must be at least 8 characters."), 303);
  }
  if (await findUserByUsername(c.env.DB, username)) {
    return c.redirect("/signup?error=" + encodeURIComponent("Username is already taken."), 303);
  }
  if (await findUserByEmail(c.env.DB, email)) {
    return c.redirect("/signup?error=" + encodeURIComponent("Email is already registered."), 303);
  }

  const passwordHash = await hashPassword(password);
  const user = await createPasswordUser(c.env.DB, username, email, passwordHash);
  const sessionId = await createSession(c.env.DB, user.id);
  setSessionCookie(c, sessionId, isSecureRequest(c));
  return c.redirect("/", 303);
});

app.get("/login", async (c) => {
  const user = await getUserFromSession(c.env.DB, getSessionId(c));
  if (user) return c.redirect("/", 302);
  const error = c.req.query("error") || "";
  return c.html(
    renderAuthLayout(
      "Log in · Resume Analyzer",
      `<section class="w-full rounded-3xl border border-white/70 bg-white/90 p-8 shadow-xl" data-testid="login-panel">
        <p class="text-xs font-bold uppercase tracking-[0.2em] text-accent">Resume Analyzer</p>
        <h1 class="mt-2 font-display text-3xl font-bold text-ink">Log in</h1>
        ${error ? `<p class="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="auth-error">${escapeHtml(error)}</p>` : ""}
        <form action="/login" method="post" class="mt-6 space-y-4" data-testid="login-form">
          <div>
            <label for="email" class="block text-sm font-semibold text-slate-700">Email</label>
            <input id="email" name="email" type="email" required class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" data-testid="login-email" aria-label="Email" />
          </div>
          <div>
            <label for="password" class="block text-sm font-semibold text-slate-700">Password</label>
            <input id="password" name="password" type="password" required class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" data-testid="login-password" aria-label="Password" />
          </div>
          <button type="submit" class="w-full rounded-xl bg-accent px-4 py-3 text-sm font-bold text-white hover:bg-accentDark" data-testid="login-submit">Log in</button>
        </form>
        <a href="/auth/google" class="mt-4 flex w-full items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-bold text-slate-800 hover:bg-mist" data-testid="google-login">Continue with Google</a>
        <p class="mt-4 text-center text-sm text-slate-600">Need an account? <a href="/signup" class="font-semibold text-accent" data-testid="signup-link">Sign up</a></p>
      </section>`
    )
  );
});

app.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const email = String(body["email"] || "").trim().toLowerCase();
  const password = String(body["password"] || "");
  const user = await findUserByEmail(c.env.DB, email);
  if (!user || !user.password_hash || !(await verifyPassword(password, user.password_hash))) {
    return c.redirect("/login?error=" + encodeURIComponent("Invalid email or password."), 303);
  }
  const sessionId = await createSession(c.env.DB, user.id);
  setSessionCookie(c, sessionId, isSecureRequest(c));
  return c.redirect("/", 303);
});

app.post("/logout", async (c) => {
  const sessionId = getSessionId(c);
  await destroySession(c.env.DB, sessionId);
  clearSessionCookie(c);
  return c.redirect("/login", 303);
});

app.get("/auth/google", async (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return c.redirect("/login?error=" + encodeURIComponent("Google sign-in is not configured."), 302);
  }
  const secret = c.env.SESSION_SECRET || "dev-secret";
  const state = await createOAuthState(secret);
  setOAuthStateCookie(c, state, isSecureRequest(c));
  return c.redirect(googleAuthUrl(clientId, googleCallbackUrl(c), state), 302);
});

app.get("/auth/google/callback", async (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID;
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return c.redirect("/login?error=" + encodeURIComponent("Google sign-in is not configured."), 302);
  }

  const code = c.req.query("code");
  const state = c.req.query("state") || "";
  const storedState = getOAuthStateCookie(c) || "";
  clearOAuthStateCookie(c);

  const secret = c.env.SESSION_SECRET || "dev-secret";
  if (!code || state !== storedState || !(await verifyOAuthState(secret, state))) {
    return c.redirect("/login?error=" + encodeURIComponent("Google sign-in failed (invalid state)."), 302);
  }

  try {
    const profile = await exchangeGoogleCode(
      clientId,
      clientSecret,
      code,
      googleCallbackUrl(c)
    );

    let user = await findUserByGoogleSub(c.env.DB, profile.sub);
    if (!user) {
      const byEmail = await findUserByEmail(c.env.DB, profile.email);
      if (byEmail) {
        await linkGoogleSub(c.env.DB, byEmail.id, profile.sub);
        user = { ...byEmail, google_sub: profile.sub };
      }
    }

    if (user) {
      const sessionId = await createSession(c.env.DB, user.id);
      setSessionCookie(c, sessionId, isSecureRequest(c));
      return c.redirect("/", 302);
    }

    await setPendingGoogleCookie(c, secret, profile, isSecureRequest(c));
    return c.redirect("/auth/google/username", 302);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google sign-in failed.";
    console.error(message);
    return c.redirect("/login?error=" + encodeURIComponent("Google sign-in failed."), 302);
  }
});

app.get("/auth/google/username", async (c) => {
  const secret = c.env.SESSION_SECRET || "dev-secret";
  const pending = await getPendingGoogle(c, secret);
  if (!pending) return c.redirect("/login", 302);
  const error = c.req.query("error") || "";
  return c.html(
    renderAuthLayout(
      "Choose username · Resume Analyzer",
      `<section class="w-full rounded-3xl border border-white/70 bg-white/90 p-8 shadow-xl" data-testid="google-username-panel">
        <p class="text-xs font-bold uppercase tracking-[0.2em] text-accent">Google signup</p>
        <h1 class="mt-2 font-display text-3xl font-bold text-ink">Choose a username</h1>
        <p class="mt-2 text-sm text-slate-600">Signed in as ${escapeHtml(pending.email)}. Pick a unique username to finish signup.</p>
        ${error ? `<p class="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="auth-error">${escapeHtml(error)}</p>` : ""}
        <form action="/auth/google/username" method="post" class="mt-6 space-y-4" data-testid="google-username-form">
          <div>
            <label for="username" class="block text-sm font-semibold text-slate-700">Username</label>
            <input id="username" name="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_]+" class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" data-testid="google-username" aria-label="Username" />
          </div>
          <button type="submit" class="w-full rounded-xl bg-accent px-4 py-3 text-sm font-bold text-white hover:bg-accentDark" data-testid="google-username-submit">Continue</button>
        </form>
      </section>`
    )
  );
});

app.post("/auth/google/username", async (c) => {
  const secret = c.env.SESSION_SECRET || "dev-secret";
  const pending = await getPendingGoogle(c, secret);
  if (!pending) return c.redirect("/login", 303);

  const body = await c.req.parseBody();
  const username = String(body["username"] || "").trim();
  if (!isValidUsername(username)) {
    return c.redirect(
      "/auth/google/username?error=" +
        encodeURIComponent("Username must be 3–32 characters: letters, numbers, underscore."),
      303
    );
  }
  if (await findUserByUsername(c.env.DB, username)) {
    return c.redirect(
      "/auth/google/username?error=" + encodeURIComponent("Username is already taken."),
      303
    );
  }

  const user = await createGoogleUser(c.env.DB, username, pending.email, pending.sub);
  clearPendingGoogleCookie(c);
  const sessionId = await createSession(c.env.DB, user.id);
  setSessionCookie(c, sessionId, isSecureRequest(c));
  return c.redirect("/", 303);
});

app.post("/upload", async (c) => {
  const user = await getUserFromSession(c.env.DB, getSessionId(c));
  if (!user) return c.redirect("/login", 303);
  const candidates = await listCandidates(c.env.DB, user);
  try {
    const body = await c.req.parseBody();
    const file = body["resume"];

    if (!file || typeof file === "string") {
      return renderErrorPage("Please choose a resume file to upload.", 400, candidates, user);
    }

    const filename = file.name || "resume";
    const ext = getExtension(filename);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return renderErrorPage("Only .pdf, .doc, and .docx files are accepted.", 400, candidates, user);
    }

    const arrayBuffer = await file.arrayBuffer();
    if (arrayBuffer.byteLength === 0) {
      return renderErrorPage("The uploaded file is empty.", 400, candidates, user);
    }
    if (arrayBuffer.byteLength > MAX_FILE_BYTES) {
      return renderErrorPage("File exceeds the 10 MB size limit.", 400, candidates, user);
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
        candidates,
        user
      );
    }

    const parsed = await parseResumeWithAi(c.env.AI, resumeText);
    await saveCandidate(c.env.DB, id, parsed, r2Key, "completed", null, user.id);

    return c.redirect(`/candidate/${id}`, 303);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error while processing the resume.";
    console.error("Upload failed:", message);
    return renderErrorPage(message, 500, candidates, user);
  }
});

app.get("/candidate/:id", async (c) => {
  const user = await getUserFromSession(c.env.DB, getSessionId(c));
  if (!user) return c.redirect("/login", 302);
  const id = c.req.param("id");
  const candidates = await listCandidates(c.env.DB, user);
  const row = await getCandidateForUser(c.env.DB, id, user);

  if (!row) {
    return renderErrorPage("Candidate not found.", 404, candidates, user);
  }

  return c.html(
    appShell(
      `${row.name || "Candidate"} · Resume Analyzer`,
      candidates,
      id,
      "candidate",
      renderCandidateDetail(row, user),
      user
    )
  );
});

app.get("/admin/scan", async (c) => {
  const user = await getUserFromSession(c.env.DB, getSessionId(c));
  if (!user) return c.redirect("/login", 302);
  if (!isAdmin(user)) {
    return renderErrorPage("Admin access required.", 403, await listCandidates(c.env.DB, user), user);
  }

  const candidates = await listCandidates(c.env.DB, user);
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

  return c.html(appShell("Scan R2 · Resume Analyzer", candidates, null, "scan", main, user));
});

app.post("/admin/scan", async (c) => {
  const user = await getUserFromSession(c.env.DB, getSessionId(c));
  if (!user) return c.redirect("/login", 303);
  if (!isAdmin(user)) {
    return renderErrorPage("Admin access required.", 403, await listCandidates(c.env.DB, user), user);
  }

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
      await saveCandidate(c.env.DB, candidateId, emptyParsed, r2Key, "pending", null, user.id);
      await c.env.DB.prepare(`UPDATE candidates SET name = ? WHERE id = ?`)
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
  const user = await getUserFromSession(c.env.DB, getSessionId(c));
  if (!user) return c.redirect("/login", 302);
  const id = c.req.param("id");
  const candidates = await listCandidates(c.env.DB, user);
  const row = await getCandidateForUser(c.env.DB, id, user);

  if (!row) {
    return renderErrorPage("Candidate not found.", 404, candidates, user);
  }

  const object = await c.env.RESUME_BUCKET.get(row.r2_object_key);
  if (!object) {
    return renderErrorPage("Original file not found in storage.", 404, candidates, user);
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
  const user = await getUserFromSession(c.env.DB, getSessionId(c)).catch(() => null);
  if (!user) {
    return c.redirect("/login", 302);
  }
  const candidates = await listCandidates(c.env.DB, user).catch(() => [] as CandidateSummary[]);
  return c.html(
    appShell(
      "Not found",
      candidates,
      null,
      "upload",
      `<section class="rounded-2xl border border-slate-200 bg-white/90 p-8">
        <h1 class="font-display text-3xl font-bold">Page not found</h1>
        <a href="/" class="mt-4 inline-block font-semibold text-accent">Go home</a>
      </section>`,
      user
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
