import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { getLoginPage, submitLogin, verify2FA } from "./auth";
import { puppeteerLogin, puppeteerComplete2FA } from "./puppeteer-auth";
import { getFeed } from "./feed";
import { getStoriesTray, markStoriesSeen } from "./stories";
import { getComments } from "./comments";
import { likeMedia } from "./like";
import { readCache, writeCache } from "./cache";
import { storeSession } from "./session-store";

// How old a cache entry can be before we serve it AND kick off a background refresh
const CACHE_STALE_MS = 5 * 60 * 1000; // 5 minutes

const app = new Hono();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-Session-Id", "X-CSRF-Token", "X-CSRF-Token-Hint", "X-DS-User-Id", "X-Browser-UA", "X-Mid", "X-No-Cache"],
    maxAge: 86400, // cache preflight for 24h — eliminates the OPTIONS round-trip on every request
  })
);

// ---------------------------------------------------------------------------
// GET /api/auth/login-page
// Returns the Instagram login HTML with the form action rewritten to hit our
// /api/auth/submit endpoint. The browser renders and submits it from the
// user's real IP — bypassing Instagram's datacenter IP block.
// ---------------------------------------------------------------------------
app.get("/api/auth/login-page", async (c) => {
  const ua = c.req.header("User-Agent") ?? "";
  const returnTo = c.req.query("returnTo") ?? "";
  return getLoginPage(ua, returnTo);
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
// Body: { username, password }
// Pi submits directly to Instagram from residential IP — no browser proxy needed.
// ---------------------------------------------------------------------------
app.post("/api/auth/login", async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>();
  if (!username || !password) return c.json({ error: "Missing username or password" }, 400);

  const result = await puppeteerLogin(username, password);

  if (result.status === "error") return c.json({ error: result.error }, 401);
  if (result.status === "checkpoint") return c.json({ error: "checkpoint_required" }, 401);
  // Persist session so the background fetcher can keep the cache warm
  if (result.status === "ok" && result.dsUserId) {
    storeSession({ sessionId: result.sessionId, csrfToken: result.csrfToken, dsUserId: result.dsUserId, mid: result.mid });
  }
  return c.json(result);
});

// ---------------------------------------------------------------------------
// POST /api/auth/submit
// Receives the login form POST from the browser and forwards to Instagram.
// ---------------------------------------------------------------------------
app.post("/api/auth/submit", async (c) => {
  const body = await c.req.text();
  const csrfHint = c.req.header("X-CSRF-Token-Hint") ?? "";
  const ua = c.req.header("User-Agent") ?? "";

  const result = await submitLogin(body, csrfHint, ua);

  if (result.status === "error") {
    return c.json({ error: result.error }, 401);
  }
  return c.json(result);
});

// ---------------------------------------------------------------------------
// POST /api/auth/2fa
// Body: { username, code, twoFactorIdentifier, csrfToken }
// ---------------------------------------------------------------------------
app.post("/api/auth/2fa", async (c) => {
  const { username, code, twoFactorIdentifier, csrfToken, mid } =
    await c.req.json<{
      username: string;
      code: string;
      twoFactorIdentifier: string;
      csrfToken: string;
      mid?: string;
    }>();

  if (!username || !code || !twoFactorIdentifier || !csrfToken) {
    return c.json({ error: "Missing required fields" }, 400);
  }

  try {
    // twoFactorIdentifier is a UUID when using the Puppeteer flow
    const isPuppeteerSession = /^[0-9a-f-]{36}$/i.test(twoFactorIdentifier);
    const result = isPuppeteerSession
      ? await puppeteerComplete2FA(twoFactorIdentifier, code)
      : await verify2FA(username, code, twoFactorIdentifier, csrfToken, mid);

    if (result.dsUserId) {
      storeSession({ sessionId: result.sessionId, csrfToken: result.csrfToken, dsUserId: result.dsUserId, mid: result.mid });
    }
    return c.json({ status: "ok", ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "2FA failed";
    return c.json({ error: message }, 401);
  }
});

// ---------------------------------------------------------------------------
// GET /api/feed?maxId=...
// Headers: X-Session-Id, X-CSRF-Token
// ---------------------------------------------------------------------------
app.get("/api/feed", async (c) => {
  const sessionId = c.req.header("X-Session-Id");
  const csrfToken = c.req.header("X-CSRF-Token");
  const dsUserId = c.req.header("X-DS-User-Id");
  const mid = c.req.header("X-Mid");
  const maxId = c.req.query("maxId");

  console.log(`[feed] sessionId=${sessionId ? sessionId.slice(0, 8) + "…" : "(missing)"} csrfToken=${csrfToken ? csrfToken.slice(0, 8) + "…" : "(missing)"} dsUserId=${dsUserId ?? "(none)"} mid=${mid ? mid.slice(0, 8) + "…" : "(none)"}`);

  if (!sessionId || !csrfToken) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  const noCache = c.req.header("X-No-Cache") === "1";

  // Serve from cache when available (first page only — paginated requests always fetch live)
  if (!noCache && !maxId && dsUserId) {
    const cached = readCache(dsUserId, "feed");
    if (cached) {
      const age = Date.now() - cached.fetchedAt;
      // Background-refresh if stale, but always return cached data immediately
      if (age > CACHE_STALE_MS) {
        getFeed(sessionId, csrfToken, undefined, dsUserId, mid)
          .then(f => writeCache(dsUserId, "feed", f))
          .catch(() => {});
      }
      console.log(`[feed] served from cache (age ${Math.round(age / 1000)}s)`);
      return c.json({ ...cached.data, cachedAt: cached.fetchedAt });
    }
  }

  try {
    const feed = await getFeed(sessionId, csrfToken, maxId, dsUserId, mid);
    if (!maxId && dsUserId) writeCache(dsUserId, "feed", feed);
    return c.json({ ...feed, cachedAt: Date.now() });
  } catch (err) {
    if (err instanceof Error && err.message === "UNAUTHORIZED") {
      return c.json({ error: "Session expired — please log in again" }, 401);
    }
    const message = err instanceof Error ? err.message : "Failed to fetch feed";
    return c.json({ error: message }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/stories
// Headers: X-Session-Id, X-CSRF-Token, (optional) X-DS-User-Id
// ---------------------------------------------------------------------------
app.get("/api/stories", async (c) => {
  const sessionId = c.req.header("X-Session-Id");
  const csrfToken = c.req.header("X-CSRF-Token");
  const dsUserId = c.req.header("X-DS-User-Id");
  const mid = c.req.header("X-Mid");

  if (!sessionId || !csrfToken) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  const noCache = c.req.header("X-No-Cache") === "1";

  if (!noCache && dsUserId) {
    const cached = readCache(dsUserId, "stories");
    if (cached) {
      const age = Date.now() - cached.fetchedAt;
      if (age > CACHE_STALE_MS) {
        getStoriesTray(sessionId, csrfToken, dsUserId, mid)
          .then(s => writeCache(dsUserId, "stories", s))
          .catch(() => {});
      }
      console.log(`[stories] served from cache (age ${Math.round(age / 1000)}s)`);
      return c.json(cached.data);
    }
  }

  try {
    const data = await getStoriesTray(sessionId, csrfToken, dsUserId, mid);
    if (dsUserId) writeCache(dsUserId, "stories", data);
    return c.json(data);
  } catch (err) {
    if (err instanceof Error && err.message === "UNAUTHORIZED") {
      return c.json({ error: "Session expired — please log in again" }, 401);
    }
    const message = err instanceof Error ? err.message : "Failed to fetch stories";
    return c.json({ error: message }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/comments/:mediaId?minId=...
// Headers: X-Session-Id, X-CSRF-Token
// ---------------------------------------------------------------------------
app.get("/api/comments/:mediaId", async (c) => {
  const sessionId = c.req.header("X-Session-Id");
  const csrfToken = c.req.header("X-CSRF-Token");
  const dsUserId = c.req.header("X-DS-User-Id");
  const mediaId = c.req.param("mediaId");
  const minId = c.req.query("minId");

  if (!sessionId || !csrfToken) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  try {
    const data = await getComments(sessionId, csrfToken, mediaId, minId, dsUserId);
    return c.json(data);
  } catch (err) {
    if (err instanceof Error && err.message === "UNAUTHORIZED") {
      return c.json({ error: "Session expired — please log in again" }, 401);
    }
    const message = err instanceof Error ? err.message : "Failed to fetch comments";
    return c.json({ error: message }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/stories/seen
// Body: { reels: { [userId]: ["itemId_takenAt_userId", ...] } }
// ---------------------------------------------------------------------------
app.post("/api/stories/seen", async (c) => {
  const sessionId = c.req.header("X-Session-Id");
  const csrfToken = c.req.header("X-CSRF-Token");
  const dsUserId = c.req.header("X-DS-User-Id");
  if (!sessionId || !csrfToken) return c.json({ error: "Not authenticated" }, 401);

  const { reels } = await c.req.json<{ reels: Record<string, string[]> }>();
  if (!reels || typeof reels !== "object") return c.json({ error: "Missing reels" }, 400);

  try {
    await markStoriesSeen(sessionId, csrfToken, reels, dsUserId);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof Error && err.message === "UNAUTHORIZED")
      return c.json({ error: "Session expired" }, 401);
    // Non-fatal — don't surface seen-marking errors to the user
    return c.json({ ok: false });
  }
});

// ---------------------------------------------------------------------------
// POST /api/like/:mediaId   — like a post
// POST /api/unlike/:mediaId — unlike a post
// Headers: X-Session-Id, X-CSRF-Token
// ---------------------------------------------------------------------------
app.post("/api/like/:mediaId", async (c) => {
  const sessionId = c.req.header("X-Session-Id");
  const csrfToken = c.req.header("X-CSRF-Token");
  const dsUserId = c.req.header("X-DS-User-Id");
  const mediaId = c.req.param("mediaId");
  if (!sessionId || !csrfToken) return c.json({ error: "Not authenticated" }, 401);
  try {
    await likeMedia(sessionId, csrfToken, mediaId, false, dsUserId);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof Error && err.message === "UNAUTHORIZED")
      return c.json({ error: "Session expired" }, 401);
    return c.json({ error: "Failed to like" }, 500);
  }
});

app.post("/api/unlike/:mediaId", async (c) => {
  const sessionId = c.req.header("X-Session-Id");
  const csrfToken = c.req.header("X-CSRF-Token");
  const dsUserId = c.req.header("X-DS-User-Id");
  const mediaId = c.req.param("mediaId");
  if (!sessionId || !csrfToken) return c.json({ error: "Not authenticated" }, 401);
  try {
    await likeMedia(sessionId, csrfToken, mediaId, true, dsUserId);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof Error && err.message === "UNAUTHORIZED")
      return c.json({ error: "Session expired" }, 401);
    return c.json({ error: "Failed to unlike" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/proxy/image?url=<encoded>
// Proxies Instagram/Facebook CDN images to avoid CORS issues and URL expiry.
// ---------------------------------------------------------------------------
const CDN_PATTERN =
  /^https:\/\/([a-z0-9-]+\.)*(cdninstagram\.com|fbcdn\.net|instagram\.com)\//i;

app.get("/api/proxy/image", async (c) => {
  const raw = c.req.query("url");
  if (!raw) return c.json({ error: "Missing url" }, 400);

  const url = decodeURIComponent(raw);
  if (!CDN_PATTERN.test(url)) {
    return c.json({ error: "URL not allowed" }, 403);
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        Referer: "https://www.instagram.com/",
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      },
    });

    if (!upstream.ok) {
      return new Response("Upstream error", { status: upstream.status });
    }

    // Buffer the full response before sending — streaming bodies are not
    // reliable through Tailscale Funnel / Node.js HTTP adapter.
    const buffer = await upstream.arrayBuffer();
    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "image/jpeg",
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch {
    return c.json({ error: "Failed to fetch image" }, 500);
  }
});

export default app;
