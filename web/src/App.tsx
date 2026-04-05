import { useState, useEffect } from "react";
import { LoginPage } from "./pages/LoginPage";
import { FeedPage } from "./pages/FeedPage";
import { InstallPrompt } from "./components/InstallPrompt";
import type { Session } from "./api";

const SESSION_KEY = "cleanstagram_session";

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function saveSession(session: Session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

/** Base64-encode the session object for easy transfer to another device */
export function exportSessionCode(session: Session): string {
  return btoa(JSON.stringify(session));
}

export default function App() {
  const [session, setSession] = useState<Session | null>(loadSession);

  // Keep localStorage in sync — but only save, never clear here.
  // Clearing on null would wipe storage if session is briefly null during init.
  useEffect(() => {
    if (session) saveSession(session);
  }, [session]);

  function handleLogin(s: Session) {
    saveSession(s); // write synchronously before any potential SW reload
    setSession(s);
  }

  function handleLogout() {
    clearSession();
    setSession(null);
  }

  if (!session) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <>
      <FeedPage
        session={session}
        sessionCode={exportSessionCode(session)}
        onLogout={handleLogout}
      />
      <InstallPrompt />
    </>
  );
}
