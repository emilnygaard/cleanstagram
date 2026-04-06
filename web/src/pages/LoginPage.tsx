import { useState, useEffect } from "react";
import type { FormEvent } from "react";
import { apiLogin, apiVerify2FA } from "../api";
import type { Session } from "../api";

interface Props {
  onLogin: (session: Session) => void;
}

type Step = "start" | "twofa" | "import-code";

export function LoginPage({ onLogin }: Props) {
  const [step, setStep] = useState<Step>("start");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const [importCode, setImportCode] = useState("");
  const [importError, setImportError] = useState<string | null>(null);

  const [twoFaCode, setTwoFaCode] = useState("");
  const [twoFaState, setTwoFaState] = useState<{
    identifier: string; csrfToken: string; username: string; mid?: string;
  } | null>(null);
  const [twoFaLoading, setTwoFaLoading] = useState(false);
  const [twoFaError, setTwoFaError] = useState<string | null>(null);

  // Handle ?session= or ?twofa= params if the old proxy flow ever redirects back
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionParam = params.get("session");
    const twofaParam = params.get("twofa");

    if (sessionParam) {
      try {
        const s = JSON.parse(decodeURIComponent(sessionParam)) as Session;
        window.history.replaceState({}, "", "/");
        onLogin(s);
      } catch { /* ignore */ }
    } else if (twofaParam) {
      try {
        const t = JSON.parse(decodeURIComponent(twofaParam)) as {
          twoFactorIdentifier: string; csrfToken: string; username: string; mid?: string;
        };
        window.history.replaceState({}, "", "/");
        setTwoFaState({ identifier: t.twoFactorIdentifier, csrfToken: t.csrfToken, username: t.username, mid: t.mid });
        setStep("twofa");
      } catch { /* ignore */ }
    }
  }, [onLogin]);

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setLoginError(null);
    setLoginLoading(true);
    try {
      const result = await apiLogin(username, password);
      if (result.status === "2fa_required") {
        setTwoFaState({
          identifier: result.twoFactorIdentifier,
          csrfToken: result.csrfToken,
          username: result.username,
          mid: result.mid,
        });
        setStep("twofa");
      } else {
        onLogin({ sessionId: result.sessionId, csrfToken: result.csrfToken, dsUserId: result.dsUserId, mid: result.mid });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Login failed";
      if (msg === "checkpoint_required") {
        setLoginError("Instagram needs to verify this login. Check your email or SMS for a verification link, click it, then try signing in again.");
      } else {
        setLoginError(msg);
      }
    } finally {
      setLoginLoading(false);
    }
  }

  function handleImportCode(e: FormEvent) {
    e.preventDefault();
    try {
      const decoded = atob(importCode.trim());
      const session = JSON.parse(decoded) as Session;
      if (!session.sessionId) throw new Error("Invalid code");
      onLogin(session);
    } catch {
      setImportError("Invalid session code.");
    }
  }

  async function handleVerify2FA(e: FormEvent) {
    e.preventDefault();
    if (!twoFaState) return;
    setTwoFaError(null);
    setTwoFaLoading(true);
    try {
      const session = await apiVerify2FA(
        twoFaState.username, twoFaCode, twoFaState.identifier, twoFaState.csrfToken, twoFaState.mid
      );
      onLogin(session);
    } catch (err) {
      setTwoFaError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setTwoFaLoading(false);
    }
  }

  // ── 2FA ────────────────────────────────────────────────────────────────────
  if (step === "twofa") {
    return (
      <Screen>
        <Card>
          <p className="text-sm font-medium text-gray-800 text-center mb-1">Two-factor authentication</p>
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

  // ── Import session code ─────────────────────────────────────────────────────
  if (step === "import-code") {
    return (
      <Screen>
        <BackBtn onClick={() => setStep("start")} />
        <Card>
          <h2 className="text-sm font-semibold text-gray-900 mb-1">Enter session code</h2>
          <p className="text-xs text-gray-500 mb-4">
            Paste a session code exported from another logged-in device.
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

  // ── Start — username/password form ─────────────────────────────────────────
  return (
    <Screen>
      <Card>
        <form onSubmit={handleLogin} className="space-y-3">
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={(e) => { setUsername(e.target.value); setLoginError(null); }}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            required
            className="w-full px-3 py-3 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-gray-900/10"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setLoginError(null); }}
            autoComplete="current-password"
            required
            className="w-full px-3 py-3 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-gray-900/10"
          />
          {loginError && <p className="text-red-500 text-sm text-center">{loginError}</p>}
          <Btn type="submit" disabled={loginLoading || !username || !password}>
            {loginLoading ? "Signing in…" : "Sign in"}
          </Btn>
        </form>
        <div className="text-center mt-3">
          <button
            onClick={() => setStep("import-code")}
            className="text-xs text-gray-400 underline hover:text-gray-600"
          >
            I have a session code
          </button>
        </div>
      </Card>
    </Screen>
  );
}

// ── Shared components ─────────────────────────────────────────────────────────

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm space-y-4">
        <div className="text-center mb-2">
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">cleanstagram</h1>
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

function Btn({ children, onClick, type = "button", disabled = false }: {
  children: React.ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="w-full py-2.5 bg-gray-900 text-white rounded-xl text-sm font-medium hover:bg-gray-800 disabled:opacity-40 transition-colors"
    >
      {children}
    </button>
  );
}

function BackBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-700 mb-1">
      ← Back
    </button>
  );
}
