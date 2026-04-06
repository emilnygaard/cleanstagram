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

  // Step 2 — Submit credentials to Instagram's AJAX login endpoint.
  // enc_password version 0 = plain-text password (no RSA/AES needed).
  const encPassword = `#PWD_INSTAGRAM_BROWSER:0:${Math.floor(Date.now() / 1000)}:${password}`;
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

  console.log("[login] status:", loginRes.status, "| authenticated:", data.authenticated,
    "| two_factor_required:", data.two_factor_required,
    "| checkpoint_url:", data.checkpoint_url ?? "(none)",
    "| message:", data.message ?? "(none)",
    "| has sessionid:", !!parseCsrfToken(setCookie, "sessionid"),
    "| has ds_user_id:", !!parseCsrfToken(setCookie, "ds_user_id"),
    "| ua:", userAgent.slice(0, 60));

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
