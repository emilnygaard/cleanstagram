/**
 * File-based cache for feed and stories responses.
 * Node.js only — not used in the Cloudflare Worker build.
 *
 * Layout:  cache/{userHash}/feed.json
 *          cache/{userHash}/stories.json
 * Each file: { data: <payload>, fetchedAt: <unix ms> }
 * Total cap: 500 MB — oldest files are evicted first.
 */
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const CACHE_DIR = process.env.CACHE_DIR ?? join(process.cwd(), "cache");
const MAX_BYTES  = 500 * 1024 * 1024; // 500 MB
const TARGET_BYTES = MAX_BYTES * 0.75; // evict down to 75 % to avoid thrashing

export interface CacheEntry<T = unknown> {
  data: T;
  fetchedAt: number; // unix ms
}

// Stable, non-reversible directory name derived from the user's Instagram ID
function userDir(dsUserId: string): string {
  const hash = createHash("sha256").update(dsUserId).digest("hex").slice(0, 16);
  return join(CACHE_DIR, hash);
}

export function readCache<T>(dsUserId: string, key: string): CacheEntry<T> | null {
  try {
    const raw = readFileSync(join(userDir(dsUserId), `${key}.json`), "utf8");
    return JSON.parse(raw) as CacheEntry<T>;
  } catch {
    return null;
  }
}

export function writeCache<T>(dsUserId: string, key: string, data: T): void {
  try {
    const dir = userDir(dsUserId);
    mkdirSync(dir, { recursive: true });
    const entry: CacheEntry<T> = { data, fetchedAt: Date.now() };
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(entry));
    evictIfNeeded();
  } catch (err) {
    console.warn("[cache] write failed:", (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Cache eviction — keep total size under MAX_BYTES
// ---------------------------------------------------------------------------
function listFiles(): { path: string; mtime: number; size: number }[] {
  const files: { path: string; mtime: number; size: number }[] = [];
  try {
    for (const userHash of readdirSync(CACHE_DIR)) {
      const userPath = join(CACHE_DIR, userHash);
      try {
        for (const file of readdirSync(userPath)) {
          const p = join(userPath, file);
          const s = statSync(p);
          files.push({ path: p, mtime: s.mtimeMs, size: s.size });
        }
      } catch { /* skip unreadable dirs */ }
    }
  } catch { /* cache dir doesn't exist yet */ }
  return files;
}

function evictIfNeeded(): void {
  const files = listFiles();
  let total = files.reduce((s, f) => s + f.size, 0);
  if (total <= MAX_BYTES) return;

  // Oldest first
  files.sort((a, b) => a.mtime - b.mtime);
  for (const f of files) {
    if (total <= TARGET_BYTES) break;
    try { rmSync(f.path); total -= f.size; } catch { /* ignore */ }
  }
  console.log(`[cache] evicted — total now ~${Math.round(total / 1024 / 1024)} MB`);
}

export function cacheStats(): { files: number; totalMB: number } {
  const files = listFiles();
  return {
    files: files.length,
    totalMB: Math.round(files.reduce((s, f) => s + f.size, 0) / 1024 / 1024 * 10) / 10,
  };
}
