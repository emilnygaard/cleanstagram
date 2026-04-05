import { useEffect } from "react";
import type { StoryTray } from "../api";
import { proxyImage } from "../api";
import type { SeenStories } from "../lib/storage";

interface Props {
  stories: StoryTray[];
  seenStories: SeenStories;
  onOpen: (index: number) => void;
}

export function StoriesRow({ stories, seenStories, onOpen }: Props) {
  // Preload the first image of every tray as soon as stories arrive.
  // These go through the Worker proxy which sets a 24h CF edge cache,
  // so by the time the user taps a story the image is already warm.
  useEffect(() => {
    stories.slice(0, 6).forEach((tray) => {
      const first = tray.items[0];
      if (first) {
        const img = new window.Image();
        img.src = proxyImage(first.imageUrl);
      }
    });
  }, [stories]);

  // Only show trays that have items AND have unseen content
  const visibleTrays = stories
    .map((tray, originalIdx) => ({ tray, originalIdx }))
    .filter(({ tray }) => {
      if (tray.items.length === 0) return false;
      const effectiveSeen = Math.max(tray.seen, seenStories[tray.user.id] ?? 0);
      return effectiveSeen < tray.latestReelMedia;
    });

  if (visibleTrays.length === 0) return null;

  return (
    <div className="bg-white border-b border-gray-100">
      <div className="flex gap-3 px-3 py-3 overflow-x-auto scrollbar-none">
        {visibleTrays.map(({ tray, originalIdx }) => {
          // Always unseen here (filtered above), but keep the ring logic correct
          const effectiveSeen = Math.max(tray.seen, seenStories[tray.user.id] ?? 0);
          const unseen = effectiveSeen < tray.latestReelMedia;
          return (
            <button
              key={tray.user.id}
              onClick={() => onOpen(originalIdx)}
              className="flex flex-col items-center gap-1 shrink-0 w-16"
            >
              {/* Ring — gradient if unseen, gray if seen */}
              <div
                className={`w-14 h-14 rounded-full p-[2px] ${
                  unseen
                    ? "bg-gradient-to-tr from-yellow-400 via-pink-500 to-purple-600"
                    : "bg-gray-200"
                }`}
              >
                <div className="w-full h-full rounded-full overflow-hidden border-[2.5px] border-white bg-gray-100">
                  <img
                    src={proxyImage(tray.user.profilePicUrl)}
                    alt={tray.user.username}
                    className="w-full h-full object-cover"
                  />
                </div>
              </div>
              <span className="text-[11px] text-gray-600 truncate w-full text-center leading-tight">
                {tray.user.username}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
