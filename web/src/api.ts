// ---------------------------------------------------------------------------
// In dev, point at the local Wrangler dev server.
// In production, this will be the same origin (Cloudflare Pages + Worker).
// ---------------------------------------------------------------------------
const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8787";

// Proxy Instagram CDN URLs through the Worker so they don't expire in the browser.
export function proxyImage(url: string): string {
  if (!url) return url;
  return `${API_BASE}/api/proxy/image?url=${encodeURIComponent(url)}`;
}

export interface Session {
  sessionId: string;
  csrfToken: string;
  dsUserId?: string;
  mid?: string;
}

export interface FeedPost {
  id: string;
  mediaType: number;
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
  carouselMedia?: {
    mediaType: number;
    images: { url: string; width: number; height: number }[];
    videoUrl?: string;
  }[];
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------
export interface Comment {
  id: string;
  text: string;
  timestamp: number;
  user: {
    id: string;
    username: string;
    profilePicUrl: string;
  };
}

export interface CommentsResponse {
  comments: Comment[];
  nextMinId: string | null;
}

export async function apiComments(
  session: Session,
  mediaId: string,
  minId?: string
): Promise<CommentsResponse> {
  const url = new URL(`${API_BASE}/api/comments/${mediaId}`);
  if (minId) url.searchParams.set("minId", minId);

  const res = await fetch(url.toString(), {
    headers: {
      "X-Session-Id": session.sessionId,
      "X-CSRF-Token": session.csrfToken,
      ...(session.dsUserId ? { "X-DS-User-Id": session.dsUserId } : {}),
      ...(session.mid ? { "X-Mid": session.mid } : {}),
    },
  });

  if (res.status === 401) throw new Error("UNAUTHORIZED");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to load comments");
  return data as CommentsResponse;
}

export interface FeedResponse {
  posts: FeedPost[];
  nextMaxId: string | null;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
export type LoginResult =
  | { status: "ok"; sessionId: string; csrfToken: string; dsUserId?: string; mid?: string }
  | {
      status: "2fa_required";
      twoFactorIdentifier: string;
      csrfToken: string;
      username: string;
      mid?: string;
    };

export async function apiLogin(
  username: string,
  password: string
): Promise<LoginResult> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Forward the real browser UA so Instagram recognises the device correctly
      "X-Browser-UA": navigator.userAgent,
    },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Login failed");
  return data as LoginResult;
}

export async function apiVerify2FA(
  username: string,
  code: string,
  twoFactorIdentifier: string,
  csrfToken: string,
  mid?: string
): Promise<Session> {
  const res = await fetch(`${API_BASE}/api/auth/2fa`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, code, twoFactorIdentifier, csrfToken, mid }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "2FA failed");
  return data as Session;
}

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------
export interface StoryItem {
  id: string;
  mediaType: number;
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
  latestReelMedia: number;
  seen: number;
  items: StoryItem[];
}

export interface StoriesResponse {
  stories: StoryTray[];
}

// reels: { [userId]: ["itemId_takenAt_userId", ...] }
export async function apiMarkStoriesSeen(
  session: Session,
  reels: Record<string, string[]>
): Promise<void> {
  // Fire-and-forget — failure is non-fatal
  fetch(`${API_BASE}/api/stories/seen`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Id": session.sessionId,
      "X-CSRF-Token": session.csrfToken,
      ...(session.dsUserId ? { "X-DS-User-Id": session.dsUserId } : {}),
      ...(session.mid ? { "X-Mid": session.mid } : {}),
    },
    body: JSON.stringify({ reels }),
  }).catch(() => {});
}

export async function apiStories(session: Session): Promise<StoriesResponse> {
  const res = await fetch(`${API_BASE}/api/stories`, {
    headers: {
      "X-Session-Id": session.sessionId,
      "X-CSRF-Token": session.csrfToken,
      ...(session.dsUserId ? { "X-DS-User-Id": session.dsUserId } : {}),
      ...(session.mid ? { "X-Mid": session.mid } : {}),
    },
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to load stories");
  return data as StoriesResponse;
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------
export async function apiLike(
  session: Session,
  mediaId: string,
  unlike: boolean
): Promise<void> {
  const action = unlike ? "unlike" : "like";
  const res = await fetch(`${API_BASE}/api/${action}/${mediaId}`, {
    method: "POST",
    headers: {
      "X-Session-Id": session.sessionId,
      "X-CSRF-Token": session.csrfToken,
      ...(session.dsUserId ? { "X-DS-User-Id": session.dsUserId } : {}),
      ...(session.mid ? { "X-Mid": session.mid } : {}),
    },
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error(`Failed to ${action}`);
}

export async function apiFeed(
  session: Session,
  maxId?: string
): Promise<FeedResponse> {
  const url = new URL(`${API_BASE}/api/feed`);
  if (maxId) url.searchParams.set("maxId", maxId);

  const res = await fetch(url.toString(), {
    headers: {
      "X-Session-Id": session.sessionId,
      "X-CSRF-Token": session.csrfToken,
      ...(session.dsUserId ? { "X-DS-User-Id": session.dsUserId } : {}),
      ...(session.mid ? { "X-Mid": session.mid } : {}),
    },
  });

  if (res.status === 401) throw new Error("UNAUTHORIZED");

  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to load feed");
  return data as FeedResponse;
}
