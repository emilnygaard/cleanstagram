import { useState, useEffect, useCallback, useRef } from "react";
import { apiFeed, apiStories } from "../api";
import type { Session, FeedPost, StoryTray } from "../api";
import { PostCard } from "../components/PostCard";
import { StoriesRow } from "../components/StoriesRow";
import { StoryViewer } from "../components/StoryViewer";
import { LoadingBar } from "../components/LoadingBar";
import { PostSkeleton, StoriesRowSkeleton } from "../components/PostSkeleton";
import {
  loadFeedCache,
  saveFeedCache,
  loadSeenPosts,
  markPostSeen,
  loadSeenStories,
  markStorySeen,
  type SeenStories,
} from "../lib/storage";

interface Props {
  session: Session;
  sessionCode: string;
  onLogout: () => void;
}

function mergePosts(a: FeedPost[], b: FeedPost[]): FeedPost[] {
  const map = new Map<string, FeedPost>();
  for (const p of a) map.set(p.id, p);
  for (const p of b) map.set(p.id, p);
  return Array.from(map.values()).sort((x, y) => y.timestamp - x.timestamp);
}

// Pull-to-refresh threshold in pixels
const PULL_THRESHOLD = 64;

export function FeedPage({ session, sessionCode, onLogout }: Props) {
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [nextMaxId, setNextMaxId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loaderRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);

  const [seenPostIds, setSeenPostIds] = useState<Set<string>>(() => loadSeenPosts());
  // Snapshot of seen IDs at page load — used to split new vs old posts.
  // We don't update this during the session so posts don't vanish while scrolling.
  const seenAtMountRef = useRef<Set<string>>(loadSeenPosts());

  const [stories, setStories] = useState<StoryTray[]>([]);
  const [storiesLoading, setStoriesLoading] = useState(true);
  const [activeStoryIdx, setActiveStoryIdx] = useState<number | null>(null);
  const [seenStories, setSeenStories] = useState<SeenStories>(() => loadSeenStories());
  const [showOlderPosts, setShowOlderPosts] = useState(false);

  // Pull-to-refresh state
  const [pullY, setPullY] = useState(0);
  const [pulling, setPulling] = useState(false);
  const touchStartY = useRef(0);

  // Online/offline
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [showSessionCode, setShowSessionCode] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);

  // -------------------------------------------------------------------------
  // Online/offline tracking
  // -------------------------------------------------------------------------
  useEffect(() => {
    const setOnline = () => setIsOnline(true);
    const setOffline = () => setIsOnline(false);
    window.addEventListener("online", setOnline);
    window.addEventListener("offline", setOffline);
    return () => {
      window.removeEventListener("online", setOnline);
      window.removeEventListener("offline", setOffline);
    };
  }, []);

  // -------------------------------------------------------------------------
  // Seen handlers
  // -------------------------------------------------------------------------
  const handlePostSeen = useCallback((id: string) => {
    setSeenPostIds((prev) => markPostSeen(id, prev));
  }, []);

  const handleTrayViewed = useCallback(
    (userId: string, latestReelMedia: number) => {
      setSeenStories((prev) => markStorySeen(userId, latestReelMedia, prev));
    },
    []
  );

  // -------------------------------------------------------------------------
  // Feed loading
  // -------------------------------------------------------------------------
  const loadFeed = useCallback(
    async (maxId?: string) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      setError(null);
      try {
        const data = await apiFeed(session, maxId);
        setPosts((prev) => {
          const merged = mergePosts(prev, data.posts);
          saveFeedCache(merged);
          return merged;
        });
        setNextMaxId(data.nextMaxId);
      } catch (err) {
        if (err instanceof Error && err.message === "UNAUTHORIZED") {
          setError("SESSION_EXPIRED");
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load feed");
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [session]
  );

  const refreshFeed = useCallback(async () => {
    if (loadingRef.current) return;
    await loadFeed();
  }, [loadFeed]);

  // -------------------------------------------------------------------------
  // On mount: show cache immediately, then bulk-fetch fresh posts
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const MAX_PAGES = 4;

    async function bulkLoad() {
      const cache = loadFeedCache();
      if (cache && cache.posts.length > 0) {
        setPosts(cache.posts);
        setInitialLoading(false);
      }

      setLoading(true);
      loadingRef.current = true;
      setError(null);

      const accumulated: FeedPost[] = [];
      let cursor: string | undefined = undefined;

      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const data = await apiFeed(session, cursor);
          if (cancelled) return;

          accumulated.push(...data.posts);

          setPosts((prev) => {
            const merged = mergePosts(prev, accumulated);
            if (page === MAX_PAGES - 1 || !data.nextMaxId) saveFeedCache(merged);
            return merged;
          });

          if (page === 0) setInitialLoading(false);

          if (!data.nextMaxId) { setNextMaxId(null); break; }
          cursor = data.nextMaxId;
          setNextMaxId(cursor);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof Error && err.message === "UNAUTHORIZED") { setError("SESSION_EXPIRED"); return; }
        setError(err instanceof Error ? err.message : "Failed to load feed");
      } finally {
        if (!cancelled) {
          setInitialLoading(false);
          loadingRef.current = false;
          setLoading(false);
        }
      }
    }

    bulkLoad();
    apiStories(session)
      .then((data) => { if (!cancelled) setStories(data.stories); })
      .catch((err) => console.warn("[stories]", err))
      .finally(() => { if (!cancelled) setStoriesLoading(false); });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Refresh when tab regains focus (if idle for > 5 min)
  // -------------------------------------------------------------------------
  const lastFocusLoad = useRef(Date.now());
  useEffect(() => {
    const onFocus = () => {
      const idleMs = Date.now() - lastFocusLoad.current;
      if (idleMs > 5 * 60 * 1000) {
        lastFocusLoad.current = Date.now();
        void refreshFeed();
        apiStories(session)
          .then((data) => setStories(data.stories))
          .catch(() => {});
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshFeed, session]);

  // -------------------------------------------------------------------------
  // Infinite scroll
  // -------------------------------------------------------------------------
  useEffect(() => {
    const el = loaderRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && nextMaxId && !loading) {
          void loadFeed(nextMaxId);
        }
      },
      { rootMargin: "400px" }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [loadFeed, nextMaxId, loading]);

  // -------------------------------------------------------------------------
  // Pull-to-refresh touch handlers
  // -------------------------------------------------------------------------
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (window.scrollY === 0) {
      touchStartY.current = e.touches[0].clientY;
    }
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (window.scrollY > 0 || loadingRef.current) return;
    const dy = e.touches[0].clientY - touchStartY.current;
    if (dy > 0) {
      setPullY(Math.min(dy * 0.5, PULL_THRESHOLD + 20));
      setPulling(dy > PULL_THRESHOLD * 2);
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (pulling) {
      void refreshFeed();
    }
    setPullY(0);
    setPulling(false);
  }, [pulling, refreshFeed]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  if (initialLoading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <LoadingBar loading />
        {/* Header */}
        <header className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-gray-100 px-4 py-3 flex items-center justify-between safe-top">
          <h1 className="text-base font-semibold tracking-tight text-gray-900">cleanstagram</h1>
        </header>
        <StoriesRowSkeleton />
        <div className="max-w-lg mx-auto">
          <PostSkeleton />
          <PostSkeleton />
          <PostSkeleton />
        </div>
      </div>
    );
  }

  // Split posts into new (not seen at mount) and older (seen before)
  const newPosts = posts.filter((p) => !seenAtMountRef.current.has(p.id));
  const olderPosts = posts.filter((p) => seenAtMountRef.current.has(p.id));
  const nothingNew = !initialLoading && !loading && newPosts.length === 0 && posts.length > 0;
  const trulyEmpty = !initialLoading && !loading && !error && posts.length === 0;

  return (
    <div
      className="min-h-screen bg-gray-50"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Background-refresh loading bar (not shown during initial skeleton load) */}
      <LoadingBar loading={loading && !initialLoading} />

      {/* Offline banner */}
      {!isOnline && (
        <div className="sticky top-0 z-20 bg-yellow-500 text-white text-xs text-center py-1.5 font-medium">
          You're offline — showing cached content
        </div>
      )}

      {/* Pull-to-refresh indicator */}
      {pullY > 0 && (
        <div
          className="flex items-center justify-center overflow-hidden transition-none"
          style={{ height: pullY }}
        >
          <div
            className={`transition-all duration-150 ${pulling ? "opacity-100 scale-100" : "opacity-50 scale-75"}`}
          >
            <svg
              viewBox="0 0 24 24"
              className={`w-6 h-6 text-gray-600 ${pulling ? "animate-spin" : ""}`}
              style={pulling ? {} : { transform: `rotate(${Math.min(pullY * 4, 360)}deg)` }}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <path d="M12 2v4M12 2l-2 2M12 2l2 2" />
              <path d="M20.66 7A10 10 0 1 1 3.34 17" opacity=".4" />
            </svg>
          </div>
        </div>
      )}

      {/* Top bar */}
      <header className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-gray-100 px-4 py-3 flex items-center justify-between">
        <h1 className="text-base font-semibold tracking-tight text-gray-900">
          cleanstagram
        </h1>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowSessionCode((v) => !v)}
            className="text-xs text-gray-400 hover:text-gray-700"
            title="Share session code"
          >
            Share
          </button>
          <button
            onClick={onLogout}
            className="text-xs text-gray-400 hover:text-gray-700"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Session code share panel */}
      {showSessionCode && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-3">
          <p className="text-xs text-amber-800 font-medium mb-1">Session code — share to sign in on another device</p>
          <p className="text-xs text-amber-700 mb-2">
            ⚠️ This gives full access to your Instagram session. Only share with yourself.
          </p>
          <div className="flex gap-2">
            <code className="flex-1 text-xs bg-white border border-amber-200 rounded-lg px-2 py-1.5 font-mono truncate text-gray-600">
              {sessionCode}
            </code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(sessionCode).then(() => {
                  setCodeCopied(true);
                  setTimeout(() => setCodeCopied(false), 2000);
                });
              }}
              className="px-3 py-1.5 bg-amber-700 text-white text-xs rounded-lg hover:bg-amber-800 whitespace-nowrap"
            >
              {codeCopied ? "Copied!" : "Copy"}
            </button>
          </div>
          <button
            onClick={() => setShowSessionCode(false)}
            className="mt-2 text-xs text-amber-600 underline"
          >
            Close
          </button>
        </div>
      )}

      {/* Stories — skeleton while loading, row when ready */}
      {storiesLoading
        ? <StoriesRowSkeleton />
        : <StoriesRow stories={stories} seenStories={seenStories} onOpen={(i) => setActiveStoryIdx(i)} />
      }

      {/* Feed */}
      <main className="max-w-lg mx-auto">
        {error === "SESSION_EXPIRED" ? (
          <div className="p-6 text-center space-y-3">
            <p className="text-sm font-medium text-gray-800">Your session has expired</p>
            <p className="text-xs text-gray-500">Instagram sessions last a few weeks. You'll need to sign in again.</p>
            <button
              onClick={onLogout}
              className="px-4 py-2 bg-gray-900 text-white text-sm rounded-xl"
            >
              Sign in again
            </button>
          </div>
        ) : error ? (
          <div className="p-4 text-center">
            <p className="text-sm text-red-500 mb-2">{error}</p>
            <button onClick={() => loadFeed()} className="text-sm text-gray-900 underline">
              Retry
            </button>
          </div>
        ) : null}

        {/* Empty feed */}
        {trulyEmpty && (
          <div className="p-8 text-center text-sm text-gray-400">Nothing here yet.</div>
        )}

        {/* Nothing new — all posts already seen */}
        {nothingNew && (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <span className="text-3xl">✓</span>
            <p className="text-base font-medium text-gray-700">You're all caught up</p>
            <p className="text-sm text-gray-400">Nothing new since your last visit.</p>
            {olderPosts.length > 0 && (
              <button
                onClick={() => setShowOlderPosts(true)}
                className="mt-2 px-4 py-2 bg-gray-900 text-white text-sm rounded-xl hover:bg-gray-800"
              >
                Show {olderPosts.length} older post{olderPosts.length !== 1 ? "s" : ""}
              </button>
            )}
          </div>
        )}

        {/* New posts */}
        {newPosts.map((post) => (
          <PostCard
            key={post.id}
            post={post}
            seen={seenPostIds.has(post.id)}
            session={session}
            onSeen={handlePostSeen}
          />
        ))}

        {/* Older posts — hidden behind a button until revealed */}
        {newPosts.length > 0 && olderPosts.length > 0 && (
          <>
            {showOlderPosts ? (
              olderPosts.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  seen={seenPostIds.has(post.id)}
                  session={session}
                  onSeen={handlePostSeen}
                />
              ))
            ) : (
              <div className="flex items-center gap-3 px-4 py-4">
                <div className="flex-1 h-px bg-gray-200" />
                <button
                  onClick={() => setShowOlderPosts(true)}
                  className="shrink-0 px-3 py-1.5 border border-gray-300 rounded-full text-xs text-gray-500 hover:border-gray-400 hover:text-gray-700 whitespace-nowrap"
                >
                  {olderPosts.length} older post{olderPosts.length !== 1 ? "s" : ""}
                </button>
                <div className="flex-1 h-px bg-gray-200" />
              </div>
            )}
          </>
        )}

        {/* Infinite scroll sentinel */}
        <div ref={loaderRef} className="py-6 flex items-center justify-center">
          {loading && !initialLoading && (
            <div className="w-5 h-5 border-2 border-gray-300 border-t-gray-700 rounded-full animate-spin" />
          )}
        </div>
      </main>

      {activeStoryIdx !== null && (
        <StoryViewer
          stories={stories}
          initialTrayIndex={activeStoryIdx}
          session={session}
          onClose={() => setActiveStoryIdx(null)}
          onTrayViewed={handleTrayViewed}
        />
      )}
    </div>
  );
}
