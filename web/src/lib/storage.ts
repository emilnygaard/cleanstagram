import type { FeedPost } from "../api";

// ---------------------------------------------------------------------------
// Feed cache — stale-while-revalidate
// ---------------------------------------------------------------------------
const FEED_CACHE_KEY = "csg_feed_v1";
const MAX_CACHED_POSTS = 200;

export interface FeedCache {
  posts: FeedPost[];
  savedAt: number; // unix ms
}

export function loadFeedCache(): FeedCache | null {
  try {
    const raw = localStorage.getItem(FEED_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as FeedCache;
  } catch {
    return null;
  }
}

export function saveFeedCache(posts: FeedPost[]): void {
  try {
    const sorted = posts
      .slice()
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_CACHED_POSTS);
    const cache: FeedCache = { posts: sorted, savedAt: Date.now() };
    localStorage.setItem(FEED_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // localStorage quota exceeded — silently ignore
  }
}

// ---------------------------------------------------------------------------
// Seen posts — track which post IDs the user has scrolled past
// ---------------------------------------------------------------------------
const SEEN_POSTS_KEY = "csg_seen_posts_v1";
const MAX_SEEN_POSTS = 1000;

export function loadSeenPosts(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_POSTS_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

export function saveSeenPosts(ids: Set<string>): void {
  try {
    // Keep only the most-recently-added ones by slicing from the end
    const arr = Array.from(ids).slice(-MAX_SEEN_POSTS);
    localStorage.setItem(SEEN_POSTS_KEY, JSON.stringify(arr));
  } catch {
    // ignore
  }
}

export function markPostSeen(id: string, current: Set<string>): Set<string> {
  if (current.has(id)) return current;
  const next = new Set(current);
  next.add(id);
  saveSeenPosts(next);
  return next;
}

// ---------------------------------------------------------------------------
// Seen stories — track per-user last-seen timestamp
// ---------------------------------------------------------------------------
const SEEN_STORIES_KEY = "csg_seen_stories_v1";

export type SeenStories = Record<string, number>; // userId → unix ts

export function loadSeenStories(): SeenStories {
  try {
    const raw = localStorage.getItem(SEEN_STORIES_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as SeenStories;
  } catch {
    return {};
  }
}

export function markStorySeen(
  userId: string,
  latestReelMedia: number,
  current: SeenStories
): SeenStories {
  const next = { ...current, [userId]: latestReelMedia };
  try {
    localStorage.setItem(SEEN_STORIES_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

export function isStorySeen(
  userId: string,
  latestReelMedia: number,
  seen: SeenStories
): boolean {
  return (seen[userId] ?? 0) >= latestReelMedia;
}
