import { useState, useEffect } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function InstallPrompt() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    return localStorage.getItem("pwa-install-dismissed") === "1";
  });
  const [isIos, setIsIos] = useState(false);
  const [isInStandaloneMode, setIsInStandaloneMode] = useState(false);

  useEffect(() => {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const standalone =
      ("standalone" in navigator && (navigator as { standalone?: boolean }).standalone === true) ||
      window.matchMedia("(display-mode: standalone)").matches;
    setIsIos(ios);
    setIsInStandaloneMode(standalone);

    const handler = (e: Event) => {
      e.preventDefault();
      setPromptEvent(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  function dismiss() {
    localStorage.setItem("pwa-install-dismissed", "1");
    setDismissed(true);
  }

  async function install() {
    if (!promptEvent) return;
    await promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    if (outcome === "accepted") {
      setPromptEvent(null);
    }
    dismiss();
  }

  // Don't show if: already installed, dismissed, or no trigger available
  if (isInStandaloneMode || dismissed) return null;

  // Android — native install prompt available
  if (promptEvent) {
    return (
      <div className="fixed bottom-4 left-4 right-4 z-40 bg-gray-900 text-white rounded-2xl shadow-xl p-4 flex items-center gap-3">
        <img src="/pwa-64x64.png" alt="" className="w-10 h-10 rounded-xl shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">Add to Home Screen</p>
          <p className="text-xs text-white/60">Install for the full app experience</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button onClick={dismiss} className="text-xs text-white/50 hover:text-white px-2 py-1">
            Not now
          </button>
          <button
            onClick={install}
            className="text-xs bg-white text-gray-900 font-semibold px-3 py-1.5 rounded-lg"
          >
            Install
          </button>
        </div>
      </div>
    );
  }

  // iOS — manual instructions (Safari only, not already installed)
  if (isIos) {
    return (
      <div className="fixed bottom-4 left-4 right-4 z-40 bg-gray-900 text-white rounded-2xl shadow-xl p-4">
        <div className="flex items-start gap-3">
          <img src="/pwa-64x64.png" alt="" className="w-10 h-10 rounded-xl shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold mb-0.5">Add to Home Screen</p>
            <p className="text-xs text-white/70 leading-relaxed">
              Tap <ShareIcon /> then <strong>"Add to Home Screen"</strong> to install Cleanstagram.
            </p>
          </div>
          <button onClick={dismiss} className="text-white/40 hover:text-white text-xl leading-none shrink-0 pl-1">
            ✕
          </button>
        </div>
      </div>
    );
  }

  return null;
}

function ShareIcon() {
  return (
    <svg className="inline w-4 h-4 mb-0.5 mx-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  );
}
