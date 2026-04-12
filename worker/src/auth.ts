import {
  createPublicKey,
  generateKeyPairSync,
  diffieHellman,
  randomBytes,
  createCipheriv,
} from "node:crypto";

// ---------------------------------------------------------------------------
// Auth via proxied Instagram login page.
//
// Instagram blocks login attempts from datacenter IPs (like Cloudflare Workers)
// regardless of encryption correctness. Solution: the *browser* submits the
// login form from the user's real IP. The Worker only:
//   1. Proxies the login page HTML (so the browser has it on our domain)
//   2. Proxies the form POST to Instagram (the actual HTTP request still comes
//      from the user's browser, not the Worker)
//   3. Reads the session cookies from Instagram's response and returns them
//      as JSON so our React app can store them.
// ---------------------------------------------------------------------------

const IG_BASE = "https://www.instagram.com";

// ---------------------------------------------------------------------------
// GET /api/auth/login-page
// Returns the raw Instagram login HTML with all URLs rewritten to go through
// our /api/auth/proxy-asset endpoint, and the login form action rewritten to
// /api/auth/submit.
// ---------------------------------------------------------------------------
export async function getLoginPage(
  userAgent: string,
  returnTo: string
): Promise<Response> {
  const res = await fetch(`${IG_BASE}/accounts/login/`, {
    headers: {
      "User-Agent": userAgent,
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml,*/*",
    },
    redirect: "follow",
  });

  let html = await res.text();
  const cookies = res.headers.get("set-cookie") ?? "";
  const csrfToken = parseCsrfToken(cookies) ?? "";

  // 1. Strip `crossorigin` attributes — they force CORS mode on CDN script/link
  //    requests. Without them, the browser loads assets as simple requests that
  //    the CDN allows from any origin.
  html = html.replace(/\s+crossorigin(?:="[^"]*")?/gi, "");

  // 2. Strip CSP meta tags — the page's CSP was authored for www.instagram.com;
  //    served from our origin it just breaks things.
  html = html.replace(
    /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*\/?>/gi,
    ""
  );

  // 3. Add <base> tag so Instagram's relative URLs (/ajax/qm/, etc.) resolve
  //    against instagram.com instead of our Worker origin.
  //    Must come before any other relative URLs in the document.
  html = html.replace("<head>", `<head>\n<base href="${IG_BASE}/">`);

  // 4. Inject our submit interceptor before </head>.
  //    Use window.location.origin for the submit URL so it always points at
  //    our Worker (even though <base> now points at instagram.com).
  const safeReturn = returnTo.replace(/['"<>]/g, "");
  const inject = `<script>
(function() {
  // Instagram's cookie consent dialog makes CORS-blocked API calls when
  // served from our Pi origin. Rather than trying to intercept the network
  // calls, watch the DOM and remove the dialog as soon as it appears.
  // The login form underneath is fully functional without accepting cookies.
  function removeCookieDialogs() {
    document.querySelectorAll('[role="dialog"],[role="alertdialog"]').forEach(function(el) {
      if ((el.textContent || '').toLowerCase().includes('cookie')) {
        el.parentNode && el.parentNode.removeChild(el);
      }
    });
    // Remove any fixed/absolute overlays that block interaction
    document.querySelectorAll('body > div').forEach(function(el) {
      var s = window.getComputedStyle(el);
      if ((s.position === 'fixed' || s.position === 'absolute') && s.zIndex > '10') {
        var txt = (el.textContent || '').toLowerCase();
        if (txt.includes('cookie') || txt.includes('consent')) {
          el.parentNode && el.parentNode.removeChild(el);
        }
      }
    });
  }
  removeCookieDialogs();
  var _obs = new MutationObserver(removeCookieDialogs);
  _obs.observe(document.documentElement, { childList: true, subtree: true });
  // Stop observing after 15s — we only need this during initial page load
  setTimeout(function() { _obs.disconnect(); }, 15000);

  document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('form').forEach(function(form) {
      form.addEventListener('submit', function(e) {
        e.preventDefault();
        var params = new URLSearchParams();
        new FormData(form).forEach(function(v, k) { params.append(k, v); });
        // Use absolute URL — <base> points at instagram.com so relative won't work
        fetch(window.location.origin + '/api/auth/submit', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-CSRF-Token-Hint': '${csrfToken}'
          },
          body: params.toString()
        })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          var base = '${safeReturn}';
          if (d.sessionId) {
            window.location.href = base + '/?session=' + encodeURIComponent(JSON.stringify(d));
          } else if (d.twoFactorIdentifier) {
            window.location.href = base + '/?twofa=' + encodeURIComponent(JSON.stringify(d));
          } else {
            alert(d.error || 'Login failed — please try again');
          }
        })
        .catch(function() { alert('Network error — please try again'); });
      });
    });
  });
})();
</script>`;

  html = html.replace("</head>", inject + "\n</head>");

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// POST /api/auth/submit
// The browser POSTs the login form here (from the user's real IP via their
// browser). We forward it straight to Instagram and extract the session cookie.
// ---------------------------------------------------------------------------
export async function submitLogin(
  formBody: string,
  csrfHint: string,
  userAgent: string
): Promise<
  | { status: "ok"; sessionId: string; csrfToken: string }
  | { status: "2fa_required"; twoFactorIdentifier: string; csrfToken: string; username: string }
  | { status: "error"; error: string }
> {
  // Parse to get username for 2FA state
  const params = new URLSearchParams(formBody);
  const username = params.get("username") ?? "";

  const res = await fetch(`${IG_BASE}/accounts/login/ajax/`, {
    method: "POST",
    headers: {
      "User-Agent": userAgent,
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRFToken": csrfHint,
      "X-Requested-With": "XMLHttpRequest",
      "X-IG-App-ID": "936619743392459",
      Referer: `${IG_BASE}/accounts/login/`,
      Origin: IG_BASE,
      Cookie: `csrftoken=${csrfHint}`,
    },
    body: formBody,
  });

  const setCookie = res.headers.get("set-cookie") ?? "";
  const data = (await res.json()) as Record<string, unknown>;

  if (data.two_factor_required) {
    const tf = data.two_factor_info as Record<string, string>;
    return {
      status: "2fa_required",
      twoFactorIdentifier: tf.two_factor_identifier,
      csrfToken: parseCsrfToken(setCookie) ?? csrfHint,
      username,
    };
  }

  if (!data.authenticated) {
    return {
      status: "error",
      error: data.message ? String(data.message) : "Login failed — check your credentials",
    };
  }

  const sessionId = parseCsrfToken(setCookie, "sessionid");
  if (!sessionId) return { status: "error", error: "No session cookie returned" };

  return {
    status: "ok",
    sessionId,
    csrfToken: parseCsrfToken(setCookie) ?? csrfHint,
  };
}

// ---------------------------------------------------------------------------
// POST /api/auth/login
// The Pi submits the login directly to Instagram from its residential IP.
// We forward the browser's real User-Agent so Instagram doesn't flag it as a
// new/unknown device, and we capture all initial cookies (including `mid`,
// the device identifier) so the session looks like a real browser session.
// ---------------------------------------------------------------------------
export async function directLogin(
  username: string,
  password: string,
  userAgent: string
): Promise<
  | { status: "ok"; sessionId: string; csrfToken: string; dsUserId: string; mid: string }
  | { status: "2fa_required"; twoFactorIdentifier: string; csrfToken: string; username: string; mid: string }
  | { status: "checkpoint" }
  | { status: "error"; error: string }
> {
  // Step 1 — Fetch the login page with the real browser UA.
  // This gives us the csrftoken AND the `mid` device-ID cookie that Instagram
  // plants on first visit. Including `mid` in the login request makes the
  // session look like it came from a real browser rather than a headless client.
  const pageRes = await fetch(`${IG_BASE}/accounts/login/`, {
    headers: {
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml,*/*",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });

  // Collect ALL cookies set by the page (csrftoken, mid, ig_did, …)
  const pageCookieHeader = pageRes.headers.get("set-cookie") ?? "";
  const initialCookies = parseCookieMap(pageCookieHeader);
  const csrfToken = initialCookies.get("csrftoken") ?? "";
  const cookieStr = [...initialCookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

  // Step 2 — Encrypt password with Instagram's public key (version 10).
  // The key config is embedded in the login page HTML.
  const pageHtml = await pageRes.text();
  const timestamp = Math.floor(Date.now() / 1000);
  const encConfig = extractEncryptionConfig(pageHtml);
  if (encConfig) {
    console.log("[login] enc keyId:", encConfig.keyId);
    console.log("[login] enc pubkey first 120:", JSON.stringify(encConfig.publicKey.slice(0, 120)));
  } else {
    console.log("[login] enc config NOT FOUND in page html (length:", pageHtml.length, ")");
    // Log a snippet around where we'd expect the key
    const idx = pageHtml.indexOf("key_id");
    if (idx >= 0) console.log("[login] key_id context:", JSON.stringify(pageHtml.slice(idx, idx + 200)));
  }
  const encPassword = encConfig
    ? encryptPassword(password, encConfig.keyId, encConfig.publicKey, timestamp)
    : `#PWD_INSTAGRAM_BROWSER:0:${timestamp}:${password}`; // fallback if key not found
  const body = new URLSearchParams({
    username,
    enc_password: encPassword,
    queryParams: "{}",
    optIntoOneTap: "false",
  });

  const loginRes = await fetch(`${IG_BASE}/accounts/login/ajax/`, {
    method: "POST",
    headers: {
      "User-Agent": userAgent,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRFToken": csrfToken,
      "X-Requested-With": "XMLHttpRequest",
      "X-IG-App-ID": "936619743392459",
      Referer: `${IG_BASE}/accounts/login/`,
      Origin: IG_BASE,
      Cookie: cookieStr,           // include mid + all initial cookies
    },
    body: body.toString(),
    redirect: "manual",
  });

  if (loginRes.status === 301 || loginRes.status === 302) {
    return { status: "error", error: "Login blocked — try again later" };
  }

  const setCookie = loginRes.headers.get("set-cookie") ?? "";
  let data: Record<string, unknown>;
  try {
    data = (await loginRes.json()) as Record<string, unknown>;
  } catch {
    return { status: "error", error: "Unexpected response from Instagram" };
  }

  console.log("[login] status:", loginRes.status,
    "| csrfToken from page:", csrfToken ? csrfToken.slice(0, 8) + "…" : "(MISSING)",
    "| mid from page:", initialCookies.get("mid") ? "✓" : "(MISSING)",
    "| enc version:", encConfig ? `10 (keyId=${encConfig.keyId})` : "0 (fallback)",
    "| authenticated:", data.authenticated,
    "| two_factor_required:", data.two_factor_required,
    "| checkpoint_url:", data.checkpoint_url ?? "(none)",
    "| message:", data.message ?? "(none)",
    "| has sessionid:", !!parseCsrfToken(setCookie, "sessionid"),
    "| has ds_user_id:", !!parseCsrfToken(setCookie, "ds_user_id"),
    "| ua:", userAgent.slice(0, 60));
  console.log("[login] full response:", JSON.stringify(data));

  // Instagram sometimes requires email/SMS verification after a new-device login.
  // The session is created but won't work until the checkpoint is cleared.
  if (data.checkpoint_url || (data.message === "checkpoint_required")) {
    return { status: "checkpoint" };
  }

  if (data.two_factor_required) {
    const tf = data.two_factor_info as Record<string, string>;
    return {
      status: "2fa_required",
      twoFactorIdentifier: tf.two_factor_identifier,
      csrfToken: parseCsrfToken(setCookie, "csrftoken") ?? csrfToken,
      username,
      mid: initialCookies.get("mid") ?? "",  // carry mid through 2FA flow
    };
  }

  if (!data.authenticated) {
    const msg = data.message ? String(data.message) : "Wrong username or password";
    return { status: "error", error: msg };
  }

  const sessionId = parseCsrfToken(setCookie, "sessionid");
  if (!sessionId) return { status: "error", error: "No session cookie returned" };

  return {
    status: "ok",
    sessionId,
    csrfToken: parseCsrfToken(setCookie, "csrftoken") ?? csrfToken,
    dsUserId: parseCsrfToken(setCookie, "ds_user_id") ?? "",
    mid: initialCookies.get("mid") ?? "",
  };
}

// ---------------------------------------------------------------------------
// Password encryption — Instagram enc_password version 10
// RSA-OAEP (SHA-256) wraps a random AES-256-GCM key; AES-GCM encrypts the
// password. The public key and key ID are embedded in the login page HTML.
// Node.js crypto is used directly — this function only runs on the Pi.
// ---------------------------------------------------------------------------

function extractEncryptionConfig(html: string): { keyId: number; publicKey: string } | null {
  // Instagram embeds the key config in various script tags; match key_id followed
  // (within 300 chars) by public_key to avoid cross-field matches.
  const m = html.match(/"key_id"\s*:\s*"?(\d+)"?.{0,300}?"public_key"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
  if (!m) return null;
  // publicKey is now a raw hex string (X25519), no PEM unescaping needed
  return { keyId: Number(m[1]), publicKey: m[2] };
}

function encryptPassword(
  password: string,
  keyId: number,
  publicKeyHex: string,
  timestamp: number
): string {
  // Instagram's public key is a raw 32-byte X25519 key (hex-encoded).
  // Wrap it in SPKI DER so Node.js can import it.
  const serverKeyBytes = Buffer.from(publicKeyHex, "hex");
  // X25519 SPKI DER prefix: SEQUENCE { AlgorithmIdentifier { OID 1.3.101.110 } BIT STRING }
  const spkiPrefix = Buffer.from("302a300506032b656e032100", "hex");
  const serverPublicKey = createPublicKey({
    key: Buffer.concat([spkiPrefix, serverKeyBytes]),
    format: "der",
    type: "spki",
  });

  // Generate ephemeral X25519 keypair
  const { publicKey: ephemeralPub, privateKey: ephemeralPriv } =
    generateKeyPairSync("x25519");

  // X25519 shared secret — used directly as the AES-256 key
  const aesKey = diffieHellman({ privateKey: ephemeralPriv, publicKey: serverPublicKey });

  // Ephemeral public key as raw 32 bytes (strip the 12-byte SPKI header)
  const ephemeralPubBytes = (ephemeralPub.export({ type: "spki", format: "der" }) as Buffer).slice(-32);

  // Random 12-byte IV
  const iv = randomBytes(12);

  // AES-256-GCM encrypt; timestamp string is the additional data
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  cipher.setAAD(Buffer.from(String(timestamp)));
  const ciphertext = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  const authTag    = cipher.getAuthTag(); // 16 bytes

  // Payload: [0x01][keyId:1][iv:12][ephemeralPub:32][authTag:16][ciphertext]
  const payload = Buffer.concat([
    Buffer.from([0x01, keyId & 0xff]),
    iv,
    ephemeralPubBytes,
    authTag,
    ciphertext,
  ]);

  return `#PWD_INSTAGRAM_BROWSER:10:${keyId}:${timestamp}:${payload.toString("base64")}`;
}

/** Parse a concatenated set-cookie header string into a name→value map. */
function parseCookieMap(setCookieHeader: string): Map<string, string> {
  const map = new Map<string, string>();
  // Each Set-Cookie is joined with ", " when accessed via headers.get().
  // Split on ", " only when followed by a cookie name (word chars + "="),
  // to avoid splitting on dates like "Thu, 01 Jan 2026 …".
  const parts = setCookieHeader.split(/,\s*(?=[a-z_][a-z0-9_-]*=)/i);
  for (const part of parts) {
    const nameVal = part.trim().split(";")[0];
    const eq = nameVal.indexOf("=");
    if (eq > 0) {
      map.set(nameVal.slice(0, eq).trim(), nameVal.slice(eq + 1).trim());
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// POST /api/auth/2fa  (unchanged — browser submits 2FA code to our worker,
// worker forwards to Instagram from worker IP; 2FA verification is less
// IP-sensitive than password auth)
// ---------------------------------------------------------------------------
export async function verify2FA(
  username: string,
  code: string,
  twoFactorIdentifier: string,
  csrfToken: string,
  mid?: string
): Promise<{ sessionId: string; csrfToken: string; dsUserId: string; mid: string }> {
  const body = new URLSearchParams({
    username,
    verificationCode: code.replace(/\s/g, ""),
    identifier: twoFactorIdentifier,
    queryParams: "{}",
    trustedDevice: "0",
    verificationMethod: "1",
  });

  const cookieParts = [`csrftoken=${csrfToken}`, ...(mid ? [`mid=${mid}`] : [])];

  const res = await fetch(`${IG_BASE}/accounts/login/ajax/two_factor/`, {
    method: "POST",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRFToken": csrfToken,
      "X-Requested-With": "XMLHttpRequest",
      "X-IG-App-ID": "936619743392459",
      Referer: `${IG_BASE}/accounts/login/`,
      Origin: IG_BASE,
      Cookie: cookieParts.join("; "),
    },
    body: body.toString(),
  });

  const setCookie = res.headers.get("set-cookie") ?? "";
  const data = (await res.json()) as Record<string, unknown>;

  console.log("[2fa] authenticated:", data.authenticated,
    "| has sessionid:", !!parseCsrfToken(setCookie, "sessionid"),
    "| has ds_user_id:", !!parseCsrfToken(setCookie, "ds_user_id"),
    "| mid sent:", !!mid);

  if (!data.authenticated) throw new Error("2FA verification failed — wrong code?");

  const sessionId = parseCsrfToken(setCookie, "sessionid");
  if (!sessionId) throw new Error("No sessionid in 2FA response");

  return {
    sessionId,
    csrfToken: parseCsrfToken(setCookie, "csrftoken") ?? csrfToken,
    dsUserId: parseCsrfToken(setCookie, "ds_user_id") ?? "",
    mid: parseCsrfToken(setCookie, "mid") ?? mid ?? "",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseCsrfToken(setCookieHeader: string, name = "csrftoken"): string | null {
  const pattern = new RegExp(`(?:^|,|;)\\s*${name}=([^;,\\s]+)`, "i");
  return setCookieHeader.match(pattern)?.[1] ?? null;
}
