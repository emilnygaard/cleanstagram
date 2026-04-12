/**
 * Puppeteer-based Instagram login.
 * Replaces the hand-rolled directLogin — a real Chromium browser handles
 * all of Instagram's JS, encryption, and anti-bot measures automatically.
 *
 * 2FA flow: the browser page is kept alive in pendingSessions until the
 * user submits the code (up to 5 minutes, then auto-cleaned).
 */
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ??
  (() => {
    for (const p of ["/usr/bin/chromium-browser", "/usr/bin/chromium", "/usr/bin/google-chrome"]) {
      try { require("fs").accessSync(p); return p; } catch {}
    }
    throw new Error("Chromium not found — install with: sudo apt install chromium-browser");
  })();

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage", // Pi's /dev/shm is too small by default
  "--disable-gpu",
  "--disable-extensions",
];

// ---------------------------------------------------------------------------
// Pending 2FA sessions — browser page kept open until code is submitted
// ---------------------------------------------------------------------------
interface PendingSession {
  browser: Browser;
  page: Page;
  username: string;
  timer: ReturnType<typeof setTimeout>;
}

const pendingSessions = new Map<string, PendingSession>();

function storePendingSession(id: string, session: PendingSession) {
  pendingSessions.set(id, session);
  // Auto-cleanup after 5 minutes if user never completes 2FA
  session.timer = setTimeout(() => closePendingSession(id), 5 * 60 * 1000);
}

async function closePendingSession(id: string) {
  const s = pendingSessions.get(id);
  if (!s) return;
  pendingSessions.delete(id);
  clearTimeout(s.timer);
  await s.browser.close().catch(() => {});
}

// ---------------------------------------------------------------------------
// Shared cookie extraction
// ---------------------------------------------------------------------------
async function extractCookies(page: Page) {
  const cookies = await page.cookies("https://www.instagram.com");
  const get = (name: string) => cookies.find((c) => c.name === name)?.value ?? "";
  return {
    sessionId: get("sessionid"),
    csrfToken: get("csrftoken"),
    dsUserId: get("ds_user_id"),
    mid: get("mid"),
  };
}

// ---------------------------------------------------------------------------
// Main login — returns ok, 2fa_required, checkpoint, or error
// ---------------------------------------------------------------------------
export async function puppeteerLogin(
  username: string,
  password: string
): Promise<
  | { status: "ok"; sessionId: string; csrfToken: string; dsUserId: string; mid: string }
  | { status: "2fa_required"; twoFactorIdentifier: string; csrfToken: string; username: string; mid: string }
  | { status: "checkpoint" }
  | { status: "error"; error: string }
> {
  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch({ executablePath: CHROMIUM_PATH, headless: true, args: LAUNCH_ARGS });
    const page = await browser.newPage();

    // Block images/fonts/media to speed up the login page load
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (type === "image" || type === "font" || type === "media") {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto("https://www.instagram.com/accounts/login/", {
      waitUntil: "networkidle2",
      timeout: 30_000,
    });

    // Dismiss cookie consent dialog if present (text varies by locale)
    try {
      const cookieBtnSelectors = [
        // Reject optional / necessary only
        'button[data-cookiebanner="accept_only_essential_button"]',
        'button[data-testid="cookie-policy-manage-dialog-accept-button"]',
      ];
      for (const sel of cookieBtnSelectors) {
        const btn = await page.$(sel);
        if (btn) { await btn.click(); break; }
      }
      // Fallback: find by text content
      if (!await page.$('input[name="username"]')) {
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll("button"));
          // Prefer "reject" / "necessary only" over "accept all"
          const reject = buttons.find((b) =>
            /afvis|reject|necessary|decline|refuse/i.test(b.textContent ?? "")
          );
          const accept = buttons.find((b) =>
            /tillad alle|allow all|accept all/i.test(b.textContent ?? "")
          );
          (reject ?? accept)?.click();
        });
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch {
      // No cookie dialog — continue
    }

    // Fill credentials
    await page.waitForSelector('input[name="username"]', { timeout: 10_000 });
    await page.type('input[name="username"]', username, { delay: 40 });
    await page.type('input[name="password"]', password, { delay: 40 });
    await page.click('button[type="submit"]');

    // Wait for Instagram to respond — either redirect, 2FA, or checkpoint
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20_000 }).catch(() => {});

    const url = page.url();
    console.log("[puppeteer] post-login URL:", url);

    // ---- 2FA required ----
    if (url.includes("/two_factor") || await page.$('input[name="verificationCode"]').then(Boolean).catch(() => false)) {
      const { csrfToken, mid } = await extractCookies(page);
      const sessionKey = crypto.randomUUID();
      storePendingSession(sessionKey, { browser, page, username, timer: undefined as never });
      browser = null; // ownership transferred — don't close in finally
      return { status: "2fa_required", twoFactorIdentifier: sessionKey, csrfToken, username, mid };
    }

    // ---- Checkpoint (email/SMS verify) ----
    if (url.includes("/challenge") || url.includes("/checkpoint")) {
      return { status: "checkpoint" };
    }

    // ---- Success ----
    const { sessionId, csrfToken, dsUserId, mid } = await extractCookies(page);
    if (!sessionId) {
      const bodySnippet = await page.evaluate(() => document.body?.innerText?.slice(0, 200) ?? "").catch(() => "");
      console.log("[puppeteer] no sessionid — page text:", bodySnippet);
      return { status: "error", error: "Login failed — wrong password or account locked" };
    }

    return { status: "ok", sessionId, csrfToken, dsUserId, mid };
  } catch (err) {
    console.error("[puppeteer] login error:", err);
    return { status: "error", error: err instanceof Error ? err.message : "Login failed" };
  } finally {
    await browser?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Complete 2FA — user submits the code; we finish in the open browser page
// ---------------------------------------------------------------------------
export async function puppeteerComplete2FA(
  twoFactorIdentifier: string,
  code: string
): Promise<{ sessionId: string; csrfToken: string; dsUserId: string; mid: string }> {
  const session = pendingSessions.get(twoFactorIdentifier);
  if (!session) throw new Error("2FA session expired — please log in again");

  const { page } = session;

  // Find and fill the verification code input
  const input = await page.$('input[name="verificationCode"]')
    ?? await page.$('input[autocomplete="one-time-code"]')
    ?? await page.$('input[type="number"]');

  if (!input) throw new Error("Could not find 2FA code input on page");

  await input.click({ clickCount: 3 }); // clear any existing value
  await input.type(code.replace(/\s/g, ""), { delay: 40 });

  // Submit — try the confirm button, fall back to Enter
  const btn = await page.$('button[type="submit"]') ?? await page.$("button");
  if (btn) {
    await btn.click();
  } else {
    await input.press("Enter");
  }

  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20_000 }).catch(() => {});

  const { sessionId, csrfToken, dsUserId, mid } = await extractCookies(page);
  await closePendingSession(twoFactorIdentifier);

  if (!sessionId) throw new Error("2FA verification failed — wrong code?");
  return { sessionId, csrfToken, dsUserId, mid };
}
