import { useState, useEffect, useRef, useCallback } from "react";
import type { StoryTray, Session } from "../api";
import { proxyImage, apiMarkStoriesSeen } from "../api";

interface Props {
  stories: StoryTray[];
  initialTrayIndex: number;
  session: Session;
  onClose: () => void;
  onTrayViewed: (userId: string, latestReelMedia: number) => void;
}

const PHOTO_DURATION_MS = 5000;

export function StoryViewer({ stories, initialTrayIndex, session, onClose, onTrayViewed }: Props) {
  const [trayIdx, setTrayIdx] = useState(initialTrayIndex);
  const [itemIdx, setItemIdx] = useState(0);
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef<number>(Date.now());
  const elapsedRef = useRef<number>(0); // for pause/resume
  const videoRef = useRef<HTMLVideoElement>(null);

  const tray = stories[trayIdx];
  const item = tray?.items[itemIdx];

  // Mark tray seen locally whenever the active tray changes
  useEffect(() => {
    if (tray) {
      onTrayViewed(tray.user.id, tray.latestReelMedia);
    }
  }, [trayIdx, tray, onTrayViewed]);

  // Mark the current item as seen on Instagram (fire-and-forget)
  useEffect(() => {
    if (!tray || !item) return;
    // Instagram's seen format: "itemId_takenAt_userId"
    const seenKey = `${item.id}_${item.timestamp}_${tray.user.id}`;
    apiMarkStoriesSeen(session, { [tray.user.id]: [seenKey] });
  }, [trayIdx, itemIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  const goNext = useCallback(() => {
    if (!tray) return;
    if (itemIdx < tray.items.length - 1) {
      setItemIdx((i) => i + 1);
      setProgress(0);
    } else if (trayIdx < stories.length - 1) {
      setTrayIdx((t) => t + 1);
      setItemIdx(0);
      setProgress(0);
    } else {
      onClose();
    }
  }, [tray, trayIdx, itemIdx, stories.length, onClose]);

  const goPrev = useCallback(() => {
    if (itemIdx > 0) {
      setItemIdx((i) => i - 1);
      setProgress(0);
    } else if (trayIdx > 0) {
      setTrayIdx((t) => t - 1);
      setItemIdx(0);
      setProgress(0);
    }
  }, [trayIdx, itemIdx]);

  // Progress timer — photos only
  useEffect(() => {
    if (!item || item.mediaType === 2) return;
    if (paused) return;

    setProgress(elapsedRef.current / PHOTO_DURATION_MS);
    startRef.current = Date.now() - elapsedRef.current;

    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startRef.current;
      const p = Math.min(elapsed / PHOTO_DURATION_MS, 1);
      setProgress(p);
      elapsedRef.current = elapsed;
      if (p >= 1) {
        clearInterval(timerRef.current!);
        elapsedRef.current = 0;
        goNext();
      }
    }, 50);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [trayIdx, itemIdx, item, goNext, paused]);

  // Reset elapsed on item change
  useEffect(() => {
    elapsedRef.current = 0;
  }, [trayIdx, itemIdx]);

  // Prefetch upcoming story images so they're in the browser/CF cache
  useEffect(() => {
    const preload = (url: string) => {
      const img = new window.Image();
      img.src = proxyImage(url);
    };
    // Next item in this tray
    const nextItem = tray?.items[itemIdx + 1];
    if (nextItem) preload(nextItem.imageUrl);
    // Item after that
    const nextNextItem = tray?.items[itemIdx + 2];
    if (nextNextItem) preload(nextNextItem.imageUrl);
    // First item of the next tray
    const nextTray = stories[trayIdx + 1];
    if (nextTray?.items[0]) preload(nextTray.items[0].imageUrl);
  }, [trayIdx, itemIdx, tray, stories]);

  // Video: play/pause + drive progress bar via timeupdate
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !item || item.mediaType !== 2) return;

    if (paused) {
      video.pause();
    } else {
      video.play().catch(() => {});
    }
  }, [paused, item]);

  // Keyboard navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") goNext();
      if (e.key === "ArrowLeft") goPrev();
      if (e.key === " ") setPaused((p) => !p);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, goNext, goPrev]);

  if (!tray) return null;

  if (!item) {
    return (
      <div className="fixed inset-0 z-50 bg-black flex items-center justify-center">
        <button onClick={onClose} className="absolute top-4 right-4 text-white/70 text-2xl">✕</button>
        <p className="text-white/60 text-sm">No stories available</p>
      </div>
    );
  }

  const isVideo = item.mediaType === 2 && item.videoUrl;

  return (
    <div className="fixed inset-0 z-50 bg-black flex items-center justify-center">
      <div
        className="relative h-full mx-auto"
        style={{ width: "min(100%, calc(100vh * 9 / 16))" }}
      >
        {/* Media */}
        {isVideo ? (
          <video
            ref={videoRef}
            key={`${trayIdx}-${itemIdx}`}
            src={proxyImage(item.videoUrl!)}
            poster={proxyImage(item.imageUrl)}
            autoPlay
            playsInline
            className="w-full h-full object-cover"
            onTimeUpdate={(e) => {
              const v = e.currentTarget;
              if (v.duration) setProgress(v.currentTime / v.duration);
            }}
            onEnded={goNext}
          />
        ) : (
          <img
            key={`${trayIdx}-${itemIdx}`}
            src={proxyImage(item.imageUrl)}
            alt=""
            className="w-full h-full object-cover"
          />
        )}

        {/* Gradients — pointer-events-none so tap zones work through them */}
        <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/70 to-transparent pointer-events-none" />
        <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/40 to-transparent pointer-events-none" />

        {/* Tap zones — rendered before UI so UI sits on top */}
        <TapZone
          className="absolute left-0 top-0 w-1/3 h-full"
          onTap={goPrev}
          onHoldChange={setPaused}
          aria-label="Previous"
        />
        <TapZone
          className="absolute right-0 top-0 w-2/3 h-full"
          onTap={goNext}
          onHoldChange={setPaused}
          aria-label="Next"
        />

        {/* Progress bars — after tap zones so they render on top */}
        <div className="absolute top-3 inset-x-3 flex gap-1 pointer-events-none">
          {tray.items.map((_, i) => (
            <div key={i} className="flex-1 h-0.5 bg-white/30 rounded-full overflow-hidden">
              <div
                className="h-full bg-white rounded-full transition-none"
                style={{
                  width:
                    i < itemIdx
                      ? "100%"
                      : i === itemIdx
                      ? `${progress * 100}%`
                      : "0%",
                }}
              />
            </div>
          ))}
        </div>

        {/* User info */}
        <div className="absolute top-7 inset-x-3 flex items-center gap-2 mt-1 pointer-events-none">
          <img
            src={proxyImage(tray.user.profilePicUrl)}
            alt={tray.user.username}
            className="w-8 h-8 rounded-full object-cover border border-white/50"
          />
          <span className="text-white text-sm font-semibold drop-shadow">
            {tray.user.username}
          </span>
          <span className="text-white/70 text-xs ml-1">
            {relativeTime(item.timestamp)}
          </span>
          {paused && (
            <span className="ml-auto text-white/70 text-xs">Paused</span>
          )}
        </div>

        {/* Close button — after tap zones so it's always tappable */}
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="absolute top-7 right-3 mt-1 text-white/80 hover:text-white text-3xl leading-none w-11 h-11 flex items-center justify-center"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TapZone — distinguishes a quick tap from a long-press hold
// ---------------------------------------------------------------------------
function TapZone({
  className,
  onTap,
  onHoldChange,
  "aria-label": ariaLabel,
}: {
  className: string;
  onTap: () => void;
  onHoldChange: (holding: boolean) => void;
  "aria-label": string;
}) {
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isHolding = useRef(false);
  const HOLD_MS = 250;

  function down() {
    isHolding.current = false;
    holdTimer.current = setTimeout(() => {
      isHolding.current = true;
      onHoldChange(true);
    }, HOLD_MS);
  }

  function up() {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (isHolding.current) {
      onHoldChange(false);
    } else {
      onTap();
    }
    isHolding.current = false;
  }

  function cancel() {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (isHolding.current) onHoldChange(false);
    isHolding.current = false;
  }

  return (
    <button
      className={className}
      onPointerDown={down}
      onPointerUp={up}
      onPointerLeave={cancel}
      aria-label={ariaLabel}
    />
  );
}

function relativeTime(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}
