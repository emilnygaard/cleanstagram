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

// Minimal types for what we actually use from Instagram's feed response
export interface FeedPost {
  id: string;
  mediaType: number; // 1=photo, 2=video, 8=carousel
  timestamp: number;
  likeCount: number;
  hasLiked: boolean;
  commentCount: number;
  caption: string | null;
  shortcode: string;
  videoUrl?: string;
  user: {
    id: string;
    username: string;
    fullName: string;
    profilePicUrl: string;
    isVerified: boolean;
  };
  images: { url: string; width: number; height: number }[];
  // For carousels
  carouselMedia?: {
    mediaType: number;
    images: { url: string; width: number; height: number }[];
    videoUrl?: string;
  }[];
}

export interface FeedResponse {
  posts: FeedPost[];
  nextMaxId: string | null;
}

export async function getFeed(
  sessionId: string,
  csrfToken: string,
  maxId?: string,
  dsUserId?: string
): Promise<FeedResponse> {
  const url = new URL(`${IG_BASE}/api/v1/feed/timeline/`);
  if (maxId) url.searchParams.set("max_id", maxId);

  const cookieParts = [
    `sessionid=${sessionId}`,
    `csrftoken=${csrfToken}`,
    ...(dsUserId ? [`ds_user_id=${dsUserId}`] : []),
  ];

  const res = await fetch(url.toString(), {
    redirect: "manual", // treat redirects as auth failures — don't loop
    headers: {
      ...HEADERS_BASE,
      Accept: "*/*",
      "X-CSRFToken": csrfToken,
      Cookie: cookieParts.join("; "),
    },
  });

  // Instagram redirects to login when the session is invalid/missing
  if (res.status === 301 || res.status === 302 || res.status === 303) {
    throw new Error("UNAUTHORIZED");
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error("UNAUTHORIZED");
  }

  if (!res.ok) {
    throw new Error(`Feed request failed: ${res.status}`);
  }

  const data = (await res.json()) as {
    items?: unknown[];
    feed_items?: unknown[];
    next_max_id?: string;
    status: string;
  };

  const rawItems: unknown[] = data.items ?? data.feed_items ?? [];

  const posts: FeedPost[] = rawItems
    .map((item) => normalizeItem(item as Record<string, unknown>))
    .filter((p): p is FeedPost => p !== null)
    .sort((a, b) => b.timestamp - a.timestamp); // newest first

  // Temporary debug — visible in `wrangler dev` output
  return {
    posts,
    nextMaxId: data.next_max_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Normalize a raw Instagram feed item into our clean FeedPost shape.
// Returns null for ads, suggested posts, or anything we don't want to show.
// ---------------------------------------------------------------------------
function normalizeItem(item: Record<string, unknown>): FeedPost | null {
  // Unwrap — Instagram timeline uses `media_or_ad`, some other endpoints use `media`
  const media = (
    item.media_or_ad ?? item.media ?? item
  ) as Record<string, unknown>;

  // Filter out ads
  if (media.ad_id || media.is_ad) return null;

  const user = media.user as Record<string, unknown> | undefined;
  if (!user) return null;

  // Filter out posts from accounts the viewer doesn't follow.
  // Instagram injects suggested posts without always setting is_suggested_for_you,
  // but friendship_status.following is reliably false on those posts.
  const fs = user.friendship_status as Record<string, unknown> | undefined;
  if (fs && fs.following === false) return null;

  // Belt-and-suspenders: explicit suggestion flag
  if (media.is_suggested_for_you) return null;

  const caption = media.caption as Record<string, unknown> | null | undefined;

  return {
    id: String(media.pk ?? media.id ?? ""),
    mediaType: Number(media.media_type ?? 1),
    timestamp: Number(media.taken_at ?? 0),
    likeCount: Number(media.like_count ?? 0),
    hasLiked: Boolean(media.has_liked),
    commentCount: Number(media.comment_count ?? 0),
    caption: caption ? String(caption.text ?? "") : null,
    shortcode: String(media.code ?? ""),
    videoUrl: extractVideoUrl(media),
    user: {
      id: String(user.pk ?? user.id ?? ""),
      username: String(user.username ?? ""),
      fullName: String(user.full_name ?? ""),
      profilePicUrl: String(user.profile_pic_url ?? ""),
      isVerified: Boolean(user.is_verified),
    },
    images: extractImages(media),
    carouselMedia:
      media.media_type === 8
        ? extractCarousel(media)
        : undefined,
  };
}

function extractVideoUrl(media: Record<string, unknown>): string | undefined {
  if (Number(media.media_type) !== 2) return undefined;
  const versions = ((media.video_versions as unknown[]) ?? []) as Record<string, unknown>[];
  return versions[0] ? String(versions[0].url ?? "") : undefined;
}

function extractImages(
  media: Record<string, unknown>
): { url: string; width: number; height: number }[] {
  const candidates = (
    (media.image_versions2 as Record<string, unknown> | undefined)
      ?.candidates as unknown[]
  ) ?? [];

  return (candidates as Record<string, unknown>[]).map((c) => ({
    url: String(c.url ?? ""),
    width: Number(c.width ?? 0),
    height: Number(c.height ?? 0),
  }));
}

function extractCarousel(media: Record<string, unknown>) {
  const items = (media.carousel_media as unknown[]) ?? [];
  return (items as Record<string, unknown>[]).map((c) => ({
    mediaType: Number(c.media_type ?? 1),
    images: extractImages(c),
    videoUrl: extractVideoUrl(c),
  }));
}
