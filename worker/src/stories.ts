const IG_BASE = "https://www.instagram.com";

const HEADERS_BASE = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "X-IG-App-ID": "936619743392459",
  "X-ASBD-ID": "198387",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: IG_BASE,
  Referer: `${IG_BASE}/`,
};

export interface StoryItem {
  id: string;
  mediaType: number; // 1=photo 2=video
  timestamp: number;
  expiringAt: number;
  imageUrl: string;
  videoUrl?: string;
  width: number;
  height: number;
}

export interface StoryTray {
  user: {
    id: string;
    username: string;
    fullName: string;
    profilePicUrl: string;
  };
  latestReelMedia: number; // unix ts of newest story
  seen: number;            // unix ts when we last viewed (0 = unseen)
  items: StoryItem[];
}

export interface StoriesResponse {
  stories: StoryTray[];
}

// ---------------------------------------------------------------------------
// Mark story items as seen on Instagram.
// reels: { [userId]: ["itemId_takenAt_userId", ...] }
// ---------------------------------------------------------------------------
export async function markStoriesSeen(
  sessionId: string,
  csrfToken: string,
  reels: Record<string, string[]>,
  dsUserId?: string
): Promise<void> {
  const cookieParts = [
    `sessionid=${sessionId}`,
    `csrftoken=${csrfToken}`,
    ...(dsUserId ? [`ds_user_id=${dsUserId}`] : []),
  ];

  // Build form-encoded body: reels[userId][0]=itemId_takenAt_userId&...
  const parts: string[] = [];
  for (const [userId, items] of Object.entries(reels)) {
    items.forEach((item, i) => {
      parts.push(`reels[${userId}][${i}]=${encodeURIComponent(item)}`);
    });
  }

  const res = await fetch(`${IG_BASE}/api/v1/media/seen/?reel=1&live_vod=0`, {
    method: "POST",
    redirect: "manual",
    headers: {
      ...HEADERS_BASE,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRFToken": csrfToken,
      Cookie: cookieParts.join("; "),
    },
    body: parts.join("&"),
  });

  if (res.status === 301 || res.status === 302 || res.status === 303) {
    throw new Error("UNAUTHORIZED");
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error("UNAUTHORIZED");
  }
  // 200 or 400 (already seen) are both acceptable
}

// ---------------------------------------------------------------------------
export async function getStoriesTray(
  sessionId: string,
  csrfToken: string,
  dsUserId?: string
): Promise<StoriesResponse> {
  const cookieParts = [
    `sessionid=${sessionId}`,
    `csrftoken=${csrfToken}`,
    ...(dsUserId ? [`ds_user_id=${dsUserId}`] : []),
  ];

  const headers = {
    ...HEADERS_BASE,
    Accept: "*/*",
    "X-CSRFToken": csrfToken,
    Cookie: cookieParts.join("; "),
  };

  // Step 1: fetch tray (user list + metadata, no story items)
  const trayRes = await fetch(`${IG_BASE}/api/v1/feed/reels_tray/`, {
    redirect: "manual",
    headers,
  });
  if (trayRes.status >= 300 && trayRes.status < 400) throw new Error("UNAUTHORIZED");
  if (trayRes.status === 401 || trayRes.status === 403) throw new Error("UNAUTHORIZED");
  if (!trayRes.ok) throw new Error(`Stories tray failed: ${trayRes.status}`);

  const trayData = (await trayRes.json()) as { tray?: unknown[]; status: string };
  const trays = (trayData.tray ?? []) as Record<string, unknown>[];

  const stories = trays
    .map((t) => normalizeTray(t))
    .filter((t): t is StoryTray => t !== null);

  if (stories.length === 0) return { stories };

  // Step 2: fetch story items for each user in parallel
  await Promise.all(
    stories.map(async (story) => {
      try {
        const res = await fetch(
          `${IG_BASE}/api/v1/feed/user/${story.user.id}/story/`,
          { redirect: "manual", headers }
        );
        if (!res.ok) return;

        const data = (await res.json()) as {
          reel?: { items?: unknown[] };
          status: string;
        };

        const items = (data.reel?.items ?? []) as Record<string, unknown>[];
        story.items = items
          .map(normalizeItem)
          .filter((i): i is StoryItem => i !== null);
      } catch {
        // non-critical — leave items empty for this user
      }
    })
  );

  return { stories };
}

// ---------------------------------------------------------------------------
function normalizeTray(tray: Record<string, unknown>): StoryTray | null {
  const user = tray.user as Record<string, unknown> | undefined;
  if (!user?.username) return null;

  const items = ((tray.items as unknown[]) ?? []) as Record<string, unknown>[];

  return {
    user: {
      id: String(user.pk ?? user.id ?? ""),
      username: String(user.username),
      fullName: String(user.full_name ?? ""),
      profilePicUrl: String(user.profile_pic_url ?? ""),
    },
    latestReelMedia: Number(tray.latest_reel_media ?? 0),
    seen: Number(tray.seen ?? 0),
    items: items.map(normalizeItem).filter((i): i is StoryItem => i !== null),
  };
}

function normalizeItem(item: Record<string, unknown>): StoryItem | null {
  const mediaType = Number(item.media_type ?? 1);

  const candidates = (
    ((item.image_versions2 as Record<string, unknown> | undefined)
      ?.candidates as unknown[]) ?? []
  ) as Record<string, unknown>[];

  // Pick highest resolution (first candidate)
  const best = candidates[0];
  if (!best) return null;

  let videoUrl: string | undefined;
  if (mediaType === 2) {
    const versions = ((item.video_versions as unknown[]) ?? []) as Record<
      string,
      unknown
    >[];
    videoUrl = versions[0] ? String(versions[0].url ?? "") : undefined;
  }

  return {
    id: String(item.pk ?? item.id ?? ""),
    mediaType,
    timestamp: Number(item.taken_at ?? 0),
    expiringAt: Number(item.expiring_at ?? 0),
    imageUrl: String(best.url ?? ""),
    videoUrl,
    width: Number(best.width ?? 0),
    height: Number(best.height ?? 0),
  };
}
