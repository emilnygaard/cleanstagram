import { useState, useEffect } from "react";
import type { FormEvent } from "react";
import { apiVerify2FA } from "../api";
import type { Session } from "../api";

interface Props {
  onLogin: (session: Session) => void;
}

type Step = "start" | "guide" | "paste" | "twofa" | "import-code";

// Detect platform for tailored instructions
function getPlatform(): "ios" | "android" | "mac" | "windows" | "other" {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Mac/.test(ua)) return "mac";
  if (/Windows/.test(ua)) return "windows";
  return "other";
}

const DEVTOOLS_STEPS: Record<string, { key: string; open: string; copy: string }> = {
  mac: {
    key: "Press ⌥⌘I",
    open: "Open DevTools with ⌥⌘I (Option+Command+I)",
    copy: "Right-click the cookie value → Copy value",
  },
  windows: {
    key: "Press F12",
    open: "Open DevTools with F12",
    copy: "Right-click the cookie value → Copy value",
  },
  other: {
    key: "Press F12",
    open: "Open DevTools with F12 or ⌥⌘I",
    copy: "Right-click the cookie value → Copy value",
  },
};

export function LoginPage({ onLogin }: Props) {
  const [step, setStep] = useState<Step>("start");
  const [pasteValue, setPasteValue] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [importCode, setImportCode] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const platform = getPlatform();
  const isMobile = platform === "ios" || platform === "android";

  // 2FA state
  const [twoFaCode, setTwoFaCode] = useState("");
  const [twoFaState, setTwoFaState] = useState<{
    identifier: string; csrfToken: string; username: string;
  } | null>(null);
  const [twoFaLoading, setTwoFaLoading] = useState(false);
  const [twoFaError, setTwoFaError] = useState<string | null>(null);

  // Handle ?session= or ?twofa= params on return from Instagram
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionParam = params.get("session");
    const twofaParam = params.get("twofa");

    if (sessionParam) {
      try {
        const s = JSON.parse(decodeURIComponent(sessionParam)) as Session;
        window.history.replaceState({}, "", "/");
        onLogin(s);
      } catch {
        setPasteError("Couldn't read session — please try again.");
      }
    } else if (twofaParam) {
      try {
        const t = JSON.parse(decodeURIComponent(twofaParam)) as {
          twoFactorIdentifier: string; csrfToken: string; username: string;
        };
        window.history.replaceState({}, "", "/");
        setTwoFaState({ identifier: t.twoFactorIdentifier, csrfToken: t.csrfToken, username: t.username });
        setStep("twofa");
      } catch { /* ignore */ }
    }
  }, [onLogin]);

  function handleOpenInstagram() {
    window.open("https://www.instagram.com/accounts/login/", "_blank", "noopener");
    setStep("guide");
  }

  function handlePasteSubmit(e: FormEvent) {
    e.preventDefault();
    const raw = pasteValue.trim();
    const sessionId = raw.match(/sessionid=([^;,\s]+)/)?.[1] ?? null;
    const csrfToken = raw.match(/csrftoken=([^;,\s]+)/)?.[1] ?? "unknown";
    const dsUserId = raw.match(/ds_user_id=([^;,\s]+)/)?.[1];

    if (!sessionId) {
      setPasteError("Couldn't find sessionid — make sure you copied the full Cookie header value.");
      return;
    }
    onLogin({ sessionId, csrfToken, dsUserId });
  }

  function handleImportCode(e: FormEvent) {
    e.preventDefault();
    try {
      const decoded = atob(importCode.trim());
      const session = JSON.parse(decoded) as Session;
      if (!session.sessionId) throw new Error("Invalid code");
      onLogin(session);
    } catch {
      setImportError("Invalid session code. Ask the person who shared it to export it again.");
    }
  }

  async function handleVerify2FA(e: FormEvent) {
    e.preventDefault();
    if (!twoFaState) return;
    setTwoFaError(null);
    setTwoFaLoading(true);
    try {
      const session = await apiVerify2FA(
        twoFaState.username, twoFaCode, twoFaState.identifier, twoFaState.csrfToken
      );
      onLogin(session);
    } catch (err) {
      setTwoFaError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setTwoFaLoading(false);
    }
  }

  const devtools = DEVTOOLS_STEPS[platform] ?? DEVTOOLS_STEPS.other;

  // ── 2FA screen ─────────────────────────────────────────────────────────
  if (step === "twofa") {
    return (
      <Screen>
        <Card>
          <p className="text-sm text-gray-500 text-center mb-4">
            Enter the verification code sent to your phone.
          </p>
          <form onSubmit={handleVerify2FA} className="space-y-3">
            <input
              type="text"
              inputMode="numeric"
              placeholder="6-digit code"
              value={twoFaCode}
              onChange={(e) => setTwoFaCode(e.target.value)}
              autoComplete="one-time-code"
              required
              maxLength={8}
              autoFocus
              className="w-full px-3 py-3 border border-gray-200 rounded-xl text-center tracking-widest text-lg font-mono focus:outline-none focus:ring-2 focus:ring-gray-900/10"
            />
            {twoFaError && <p className="text-red-500 text-sm text-center">{twoFaError}</p>}
            <Btn type="submit" disabled={twoFaLoading}>
              {twoFaLoading ? "Verifying…" : "Verify"}
            </Btn>
          </form>
        </Card>
      </Screen>
    );
  }

  // ── Import session code ─────────────────────────────────────────────────
  if (step === "import-code") {
    return (
      <Screen>
        <BackBtn onClick={() => setStep("start")} />
        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-1">Enter session code</h2>
          <p className="text-xs text-gray-500 mb-4">
            Ask someone already logged in to share their session code with you.
          </p>
          <form onSubmit={handleImportCode} className="space-y-3">
            <textarea
              rows={3}
              placeholder="Paste your session code here…"
              value={importCode}
              onChange={(e) => { setImportCode(e.target.value); setImportError(null); }}
              className="w-full px-3 py-2 border border-gray-200 rounded-xl text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-gray-900/10"
            />
            {importError && <p className="text-red-500 text-xs">{importError}</p>}
            <Btn type="submit" disabled={!importCode.trim()}>
              Sign in with code
            </Btn>
          </form>
        </Card>
      </Screen>
    );
  }

  // ── Paste cookies ───────────────────────────────────────────────────────
  if (step === "paste") {
    return (
      <Screen>
        <BackBtn onClick={() => setStep("guide")} />
        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-1">Paste your cookies</h2>
          <p className="text-xs text-gray-500 mb-3">
            Paste the value of the <code className="bg-gray-100 px-1 rounded">cookie</code> request header below.
          </p>
          <form onSubmit={handlePasteSubmit} className="space-y-3">
            <textarea
              rows={4}
              placeholder="sessionid=abc123; csrftoken=xyz; ds_user_id=456…"
              value={pasteValue}
              onChange={(e) => { setPasteValue(e.target.value); setPasteError(null); }}
              autoFocus
              className="w-full px-3 py-2 border border-gray-200 rounded-xl text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-gray-900/10"
            />
            {pasteError && <p className="text-red-500 text-xs">{pasteError}</p>}
            <Btn type="submit" disabled={!pasteValue.trim()}>
              Connect →
            </Btn>
          </form>
        </Card>
      </Screen>
    );
  }

  // ── DevTools guide ──────────────────────────────────────────────────────
  if (step === "guide") {
    return (
      <Screen>
        <BackBtn onClick={() => setStep("start")} />
        <div className="space-y-3">
          <Step n={1} title="Log in to Instagram" done>
            <p className="text-xs text-gray-500">
              Sign in on the Instagram tab that just opened.
            </p>
            <button
              onClick={handleOpenInstagram}
              className="mt-1.5 text-xs text-gray-400 underline"
            >
              Reopen tab
            </button>
          </Step>

          <Step n={2} title={devtools.open}>
            <ol className="text-xs text-gray-600 space-y-1.5 pl-3 list-decimal mt-1">
              <li>Go to the <strong>Network</strong> tab and reload the page</li>
              <li>
                Click the first request to{" "}
                <code className="bg-gray-100 px-1 rounded">www.instagram.com</code>
              </li>
              <li>
                In <strong>Request Headers</strong>, find the{" "}
                <code className="bg-gray-100 px-1 rounded">cookie</code> row
              </li>
              <li>{devtools.copy}</li>
            </ol>
          </Step>

          <Step n={3} title="Paste it below">
            <Btn onClick={() => setStep("paste")} className="mt-2 py-2 text-xs">
              Paste cookies →
            </Btn>
          </Step>
        </div>
      </Screen>
    );
  }

  // ── Start ────────────────────────────────────────────────────────────────
  return (
    <Screen>
      <div className="space-y-3">
        {isMobile ? (
          // Mobile: explain that setup is easiest on desktop
          <Card className="text-center space-y-3">
            <div className="text-3xl">💻</div>
            <h2 className="text-sm font-semibold text-gray-900">First-time setup</h2>
            <p className="text-xs text-gray-500 leading-relaxed">
              Cleanstagram needs your Instagram session, which is easiest to set up on
              a <strong>desktop or laptop</strong> browser with DevTools.
            </p>
            <p className="text-xs text-gray-500 leading-relaxed">
              Once set up on any device, sessions stay active for weeks.
            </p>
            <div className="pt-1 space-y-2">
              <Btn onClick={handleOpenInstagram}>
                Set up on this device →
              </Btn>
              <button
                onClick={() => setStep("import-code")}
                className="w-full py-2.5 text-sm text-gray-500 hover:text-gray-800 border border-gray-200 rounded-xl transition-colors"
              >
                I have a session code
              </button>
            </div>
          </Card>
        ) : (
          <Card className="space-y-3">
            <p className="text-sm text-gray-600 text-center">
              Connect your Instagram account to get started.
            </p>
            <Btn onClick={handleOpenInstagram}>
              Connect Instagram →
            </Btn>
            <div className="text-center">
              <button
                onClick={() => setStep("import-code")}
                className="text-xs text-gray-400 underline hover:text-gray-600"
              >
                I have a session code
              </button>
            </div>
          </Card>
        )}
      </div>
    </Screen>
  );
}

// ── Small shared components ─────────────────────────────────────────────────

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm space-y-4">
        <div className="text-center mb-2">
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
            cleanstagram
          </h1>
          <p className="text-sm text-gray-400 mt-1">Instagram, without the noise</p>
        </div>
        {children}
      </div>
    </div>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-white border border-gray-200 rounded-2xl p-5 shadow-sm ${className}`}>
      {children}
    </div>
  );
}

function Btn({
  children,
  onClick,
  type = "button",
  disabled = false,
  className = "",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`w-full py-2.5 bg-gray-900 text-white rounded-xl text-sm font-medium hover:bg-gray-800 disabled:opacity-40 transition-colors ${className}`}
    >
      {children}
    </button>
  );
}

function BackBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-700 mb-1"
    >
      ← Back
    </button>
  );
}

function Step({
  n,
  title,
  done = false,
  children,
}: {
  n: number;
  title: string;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span
          className={`shrink-0 w-6 h-6 rounded-full text-white text-xs flex items-center justify-center font-medium ${
            done ? "bg-green-500" : "bg-gray-900"
          }`}
        >
          {done ? "✓" : n}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900">{title}</p>
          {children}
        </div>
      </div>
    </div>
  );
}
