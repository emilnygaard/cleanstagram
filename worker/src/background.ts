/**
 * Background prefetch loop.
 * Runs on the Pi, fetches feed + stories for every stored session at
 * randomised intervals to keep the cache warm without looking like a bot.
 *
 * Interval: 15–35 minutes (re-randomised every cycle, per user)
 * Initial delay: 30–90 seconds after server start
 */
import { getFeed } from "./feed.js";
import { getStoriesTray } from "./stories.js";
import { getAllSessions, updateSession } from "./session-store.js";
import { writeCache, cacheStats } from "./cache.js";

const MIN_MS  = 15 * 60 * 1000;
const MAX_MS  = 35 * 60 * 1000;
const JITTER  = () => MIN_MS + Math.random() * (MAX_MS - MIN_MS);

async function prefetchUser(s: {
  sessionId: string; csrfToken: string; dsUserId: string; mid: string;
}): Promise<void> {
  const tag = s.dsUserId.slice(0, 6);

  try {
    const feed = await getFeed(s.sessionId, s.csrfToken, undefined, s.dsUserId, s.mid);
    writeCache(s.dsUserId, "feed", feed);
    console.log(`[bg:${tag}] feed cached (${feed.posts.length} posts)`);
  } catch (err) {
    const msg = (err as Error).message;
    console.log(`[bg:${tag}] feed error: ${msg}`);
    // If the session is expired, don't keep hammering Instagram
    if (msg === "UNAUTHORIZED") return;
  }

  // Small pause between requests to look more human
  await sleep(2000 + Math.random() * 3000);

  try {
    const stories = await getStoriesTray(s.sessionId, s.csrfToken, s.dsUserId, s.mid);
    writeCache(s.dsUserId, "stories", stories);
    console.log(`[bg:${tag}] stories cached (${stories.stories.length} trays)`);
  } catch (err) {
    console.log(`[bg:${tag}] stories error: ${(err as Error).message}`);
  }
}

async function runCycle(): Promise<void> {
  const sessions = getAllSessions();
  if (sessions.length === 0) return;

  console.log(`[bg] prefetching for ${sessions.length} user(s)…`);

  for (const session of sessions) {
    await prefetchUser(session);
    if (sessions.length > 1) await sleep(5000 + Math.random() * 5000);
  }

  const stats = cacheStats();
  console.log(`[bg] done — cache: ${stats.files} files, ${stats.totalMB} MB`);
}

export function startBackgroundFetcher(): void {
  const initialDelay = 30_000 + Math.random() * 60_000;
  console.log(`[bg] first prefetch in ${Math.round(initialDelay / 1000)}s`);

  setTimeout(function cycle() {
    runCycle().finally(() => {
      const next = JITTER();
      console.log(`[bg] next prefetch in ${Math.round(next / 60_000)}m`);
      setTimeout(cycle, next);
    });
  }, initialDelay);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
