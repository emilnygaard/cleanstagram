import { useState, useCallback } from "react";
import type { Session, Comment } from "../api";
import { apiComments } from "../api";
import { proxyImage } from "../api";

interface Props {
  session: Session;
  mediaId: string;
  commentCount: number;
}

function RelativeTime({ timestamp }: { timestamp: number }) {
  const diff = Math.floor(Date.now() / 1000) - timestamp;
  if (diff < 60) return <span>{diff}s</span>;
  if (diff < 3600) return <span>{Math.floor(diff / 60)}m</span>;
  if (diff < 86400) return <span>{Math.floor(diff / 3600)}h</span>;
  return <span>{Math.floor(diff / 86400)}d</span>;
}

export function CommentsSection({ session, mediaId, commentCount }: Props) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextMinId, setNextMinId] = useState<string | null>(null);

  const load = useCallback(
    async (minId?: string) => {
      setLoading(true);
      setError(null);
      try {
        const data = await apiComments(session, mediaId, minId);
        setComments((prev) => {
          const merged = minId ? [...prev, ...data.comments] : data.comments;
          // deduplicate by id
          const seen = new Set<string>();
          return merged.filter((c) => {
            if (seen.has(c.id)) return false;
            seen.add(c.id);
            return true;
          });
        });
        setNextMinId(data.nextMinId);
        setLoaded(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load comments");
      } finally {
        setLoading(false);
      }
    },
    [session, mediaId]
  );

  if (!loaded) {
    if (commentCount === 0) return null;
    return (
      <button
        onClick={() => load()}
        className="text-sm text-gray-500 hover:text-gray-700 px-3 pb-3 block"
      >
        View all {commentCount.toLocaleString()} comment{commentCount !== 1 ? "s" : ""}
      </button>
    );
  }

  return (
    <div className="px-3 pb-3">
      {comments.length === 0 && !loading && (
        <p className="text-xs text-gray-400">No comments yet.</p>
      )}

      <ul className="space-y-2">
        {comments.map((c) => (
          <li key={c.id} className="flex items-start gap-2">
            <img
              src={proxyImage(c.user.profilePicUrl)}
              alt={c.user.username}
              className="w-6 h-6 rounded-full object-cover bg-gray-100 shrink-0 mt-0.5"
              loading="lazy"
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-gray-800 leading-snug">
                <span className="font-semibold mr-1">{c.user.username}</span>
                {c.text}
              </p>
              <span className="text-xs text-gray-400">
                <RelativeTime timestamp={c.timestamp} />
              </span>
            </div>
          </li>
        ))}
      </ul>

      {loading && (
        <div className="flex justify-center py-2">
          <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
        </div>
      )}

      {error && (
        <p className="text-xs text-red-500 mt-1">{error}</p>
      )}

      {nextMinId && !loading && (
        <button
          onClick={() => load(nextMinId)}
          className="text-xs text-gray-500 hover:text-gray-700 mt-2"
        >
          Load more comments
        </button>
      )}
    </div>
  );
}
