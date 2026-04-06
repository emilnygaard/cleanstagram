/**
 * Persists Instagram sessions to disk so the background fetcher can
 * pre-warm the cache even when no browser tab is open.
 * Node.js only — not used in the Cloudflare Worker build.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STORE_PATH = process.env.SESSION_STORE ?? join(process.cwd(), "stored-sessions.json");

export interface StoredSession {
  sessionId: string;
  csrfToken: string;
  dsUserId: string;
  mid: string;
  savedAt: number;
}

type Store = Record<string, StoredSession>;

function load(): Store {
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf8")) as Store;
  } catch {
    return {};
  }
}

function save(store: Store): void {
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

/** Upsert a session keyed by dsUserId */
export function storeSession(session: Omit<StoredSession, "savedAt">): void {
  try {
    const store = load();
    store[session.dsUserId] = { ...session, savedAt: Date.now() };
    save(store);
    console.log(`[sessions] stored session for user ${session.dsUserId.slice(0, 6)}…`);
  } catch (err) {
    console.warn("[sessions] failed to store session:", (err as Error).message);
  }
}

/** Update just the tokens for an existing session (e.g. after token refresh) */
export function updateSession(dsUserId: string, patch: Partial<StoredSession>): void {
  try {
    const store = load();
    if (store[dsUserId]) {
      store[dsUserId] = { ...store[dsUserId], ...patch, savedAt: Date.now() };
      save(store);
    }
  } catch { /* non-fatal */ }
}

export function getAllSessions(): StoredSession[] {
  return Object.values(load());
}
