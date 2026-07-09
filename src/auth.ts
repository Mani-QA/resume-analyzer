import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

export type AuthUser = {
  id: string;
  username: string;
  email: string;
  password_hash: string | null;
  google_sub: string | null;
  is_admin: number;
};

export type AuthBindings = {
  DB: D1Database;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
};

export type AuthVariables = {
  user: AuthUser;
};

const SESSION_COOKIE = "session";
const OAUTH_STATE_COOKIE = "oauth_state";
const OAUTH_PENDING_COOKIE = "oauth_pending";
const SESSION_DAYS = 30;

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    key,
    256
  );
  return `pbkdf2:100000:${bytesToHex(salt)}:${bytesToHex(new Uint8Array(bits))}`;
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  const salt = hexToBytes(parts[2]);
  const expected = parts[3];
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256
  );
  const actual = bytesToHex(new Uint8Array(bits));
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export function isValidUsername(username: string): boolean {
  return /^[a-zA-Z0-9_]{3,32}$/.test(username);
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function sessionExpiryIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + SESSION_DAYS);
  return d.toISOString();
}

export async function createSession(
  db: D1Database,
  userId: string
): Promise<string> {
  const id = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`
    )
    .bind(id, userId, sessionExpiryIso())
    .run();
  return id;
}

export function setSessionCookie(
  c: Context,
  sessionId: string,
  secure: boolean
): void {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function destroySession(
  db: D1Database,
  sessionId: string | undefined
): Promise<void> {
  if (!sessionId) return;
  await db.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sessionId).run();
}

export async function getUserFromSession(
  db: D1Database,
  sessionId: string | undefined
): Promise<AuthUser | null> {
  if (!sessionId) return null;
  const row = await db
    .prepare(
      `SELECT u.id, u.username, u.email, u.password_hash, u.google_sub, u.is_admin
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND datetime(s.expires_at) > datetime('now')`
    )
    .bind(sessionId)
    .first<AuthUser>();
  return row ?? null;
}

export async function findUserByEmail(
  db: D1Database,
  email: string
): Promise<AuthUser | null> {
  const row = await db
    .prepare(
      `SELECT id, username, email, password_hash, google_sub, is_admin
       FROM users WHERE lower(email) = lower(?)`
    )
    .bind(email)
    .first<AuthUser>();
  return row ?? null;
}

export async function findUserByUsername(
  db: D1Database,
  username: string
): Promise<AuthUser | null> {
  const row = await db
    .prepare(
      `SELECT id, username, email, password_hash, google_sub, is_admin
       FROM users WHERE lower(username) = lower(?)`
    )
    .bind(username)
    .first<AuthUser>();
  return row ?? null;
}

export async function findUserByGoogleSub(
  db: D1Database,
  googleSub: string
): Promise<AuthUser | null> {
  const row = await db
    .prepare(
      `SELECT id, username, email, password_hash, google_sub, is_admin
       FROM users WHERE google_sub = ?`
    )
    .bind(googleSub)
    .first<AuthUser>();
  return row ?? null;
}

export async function createPasswordUser(
  db: D1Database,
  username: string,
  email: string,
  passwordHash: string
): Promise<AuthUser> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO users (id, username, email, password_hash, is_admin)
       VALUES (?, ?, ?, ?, 0)`
    )
    .bind(id, username, email.toLowerCase(), passwordHash)
    .run();
  return {
    id,
    username,
    email: email.toLowerCase(),
    password_hash: passwordHash,
    google_sub: null,
    is_admin: 0,
  };
}

export async function createGoogleUser(
  db: D1Database,
  username: string,
  email: string,
  googleSub: string
): Promise<AuthUser> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO users (id, username, email, password_hash, google_sub, is_admin)
       VALUES (?, ?, ?, NULL, ?, 0)`
    )
    .bind(id, username, email.toLowerCase(), googleSub)
    .run();
  return {
    id,
    username,
    email: email.toLowerCase(),
    password_hash: null,
    google_sub: googleSub,
    is_admin: 0,
  };
}

export async function linkGoogleSub(
  db: D1Database,
  userId: string,
  googleSub: string
): Promise<void> {
  await db
    .prepare(`UPDATE users SET google_sub = ? WHERE id = ?`)
    .bind(googleSub, userId)
    .run();
}

function base64UrlEncode(data: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof data === "string") {
    bytes = new TextEncoder().encode(data);
  } else if (data instanceof Uint8Array) {
    bytes = data;
  } else {
    bytes = new Uint8Array(data);
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return atob(padded + pad);
}

async function hmacSign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );
  return base64UrlEncode(sig);
}

export async function createOAuthState(secret: string): Promise<string> {
  const nonce = crypto.randomUUID();
  const sig = await hmacSign(secret || "dev-secret", nonce);
  return `${nonce}.${sig}`;
}

export async function verifyOAuthState(
  secret: string,
  state: string
): Promise<boolean> {
  const [nonce, sig] = state.split(".");
  if (!nonce || !sig) return false;
  const expected = await hmacSign(secret || "dev-secret", nonce);
  return expected === sig;
}

export type PendingGoogle = { sub: string; email: string };

export async function setPendingGoogleCookie(
  c: Context,
  secret: string,
  pending: PendingGoogle,
  secure: boolean
): Promise<void> {
  const payload = base64UrlEncode(JSON.stringify(pending));
  const sig = await hmacSign(secret || "dev-secret", payload);
  setCookie(c, OAUTH_PENDING_COOKIE, `${payload}.${sig}`, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 15,
  });
}

export async function getPendingGoogle(
  c: Context,
  secret: string
): Promise<PendingGoogle | null> {
  const raw = getCookie(c, OAUTH_PENDING_COOKIE);
  if (!raw) return null;
  const idx = raw.lastIndexOf(".");
  if (idx <= 0) return null;
  const payload = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);
  const expected = await hmacSign(secret || "dev-secret", payload);
  if (expected !== sig) return null;
  try {
    return JSON.parse(base64UrlDecode(payload)) as PendingGoogle;
  } catch {
    return null;
  }
}

export function clearPendingGoogleCookie(c: Context): void {
  deleteCookie(c, OAUTH_PENDING_COOKIE, { path: "/" });
}

export function setOAuthStateCookie(
  c: Context,
  state: string,
  secure: boolean
): void {
  setCookie(c, OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 10,
  });
}

export function getOAuthStateCookie(c: Context): string | undefined {
  return getCookie(c, OAUTH_STATE_COOKIE);
}

export function clearOAuthStateCookie(c: Context): void {
  deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/" });
}

export function getSessionId(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export function isSecureRequest(c: Context): boolean {
  const url = new URL(c.req.url);
  return url.protocol === "https:";
}

export function googleAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string
): Promise<{ sub: string; email: string }> {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Google token exchange failed: ${text.slice(0, 200)}`);
  }
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) {
    throw new Error("Google token response missing access_token");
  }

  const userRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  if (!userRes.ok) {
    throw new Error("Failed to fetch Google user info");
  }
  const profile = (await userRes.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
  };
  if (!profile.sub || !profile.email) {
    throw new Error("Google profile missing sub or email");
  }
  return { sub: profile.sub, email: profile.email.toLowerCase() };
}

export function googleCallbackUrl(c: Context): string {
  const url = new URL(c.req.url);
  return `${url.origin}/auth/google/callback`;
}

export function isAdmin(user: AuthUser): boolean {
  return Number(user.is_admin) === 1;
}
