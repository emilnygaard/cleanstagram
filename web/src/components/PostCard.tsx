import { useState, useEffect, useRef, useCallback } from "react";
import type { FeedPost, Session } from "../api";
import { proxyImage, apiLike } from "../api";
import { CommentsSection } from "./CommentsSection";

interface Props {
  post: FeedPost;
  seen: boolean;
  session: Session;
  onSeen: (id: string) => void;
  priority?: boolean; // true for first ~2 posts — loads eagerly at high priority
}

type CarouselSlide = {
  mediaType: number;
  images: { url: string; width: number; height: number }[];
  videoUrl?: string;
};

function bestImage(images: { url: string; width: number; height: number }[]) {
  return images.slice().sort((a, b) => b.width - a.width)[0];
}

/** Image that fades in from the gray placeholder when loaded. */
function FadeImg({ src, alt, className, priority }: { src: string; alt: string; className?: string; priority?: boolean }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <img
      src={src}
      alt={alt}
      className={`${className ?? ""} transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
      loading={priority ? "eager" : "lazy"}
      // @ts-expect-error — fetchpriority is valid but not yet in all TS DOM libs
      fetchpriority={priority ? "high" : "auto"}
      onLoad={() => setLoaded(true)}
    />
  );
}

function RelativeTime({ timestamp }: { timestamp: number }) {
  const diff = Math.floor(Date.now() / 1000) - timestamp;
  if (diff < 60) return <span>{diff}s</span>;
  if (diff < 3600) return <span>{Math.floor(diff / 60)}m</span>;
  if (diff < 86400) return <span>{Math.floor(diff / 3600)}h</span>;
  return <span>{Math.floor(diff / 86400)}d</span>;
}

// ---------------------------------------------------------------------------
// VideoPlayer — autoplay when in viewport, pause when out
// ---------------------------------------------------------------------------
function VideoPlayer({
  src,
  poster,
  aspectPaddingBottom,
}: {
  src: string;
  poster?: string;
  aspectPaddingBottom: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  const [playing, setPlaying] = useState(false);

  // Autoplay / pause based on visibility
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry.isIntersecting) {
          video.play().catch(() => {});
        } else {
          video.pause();
        }
      },
      { threshold: 0.5 }
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, []);

  return (
    <div className="relative w-full bg-black" style={{ paddingBottom: aspectPaddingBottom }}>
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        muted={muted}
        playsInline
        loop
        className="absolute inset-0 w-full h-full object-contain"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onClick={togglePlay}
      />
      {/* Controls overlay */}
      <div className="absolute bottom-2 right-2 flex gap-2">
        {/* Mute toggle */}
        <button
          onClick={(e) => { e.stopPropagation(); setMuted((m) => !m); }}
          className="bg-black/50 text-white rounded-full w-8 h-8 flex items-center justify-center text-sm"
          aria-label={muted ? "Unmute" : "Mute"}
        >
          {muted ? "🔇" : "🔊"}
        </button>
      </div>
      {/* Play/pause indicator */}
      {!playing && (
        <button
          onClick={togglePlay}
          className="absolute inset-0 flex items-center justify-center"
          aria-label="Play"
        >
          <div className="bg-black/40 rounded-full w-14 h-14 flex items-center justify-center">
            <span className="text-white text-2xl ml-1">▶</span>
          </div>
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PostCard
// ---------------------------------------------------------------------------
export function PostCard({ post, seen, session, onSeen, priority = false }: Props) {
  const [carouselIdx, setCarouselIdx] = useState(0);
  const [liked, setLiked] = useState(post.hasLiked);
  const [likeCount, setLikeCount] = useState(post.likeCount);
  const cardRef = useRef<HTMLElement>(null);
  const swipeTouchStart = useRef<{ x: number; y: number } | null>(null);
  const likeInFlight = useRef(false);

  // Preload all carousel images immediately so switching is instant
  useEffect(() => {
    if (!post.carouselMedia) return;
    post.carouselMedia.forEach((slide) => {
      const img = bestImage(slide.images);
      if (img) new window.Image().src = proxyImage(img.url);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Mark seen when card scrolls out of view
  useEffect(() => {
    if (seen) return;
    const el = cardRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) onSeen(post.id);
      },
      { threshold: 0 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [post.id, seen, onSeen]);

  const toggleLike = useCallback(async () => {
    if (likeInFlight.current) return;
    likeInFlight.current = true;
    const nowLiked = !liked;
    setLiked(nowLiked);
    setLikeCount((c) => c + (nowLiked ? 1 : -1));
    try {
      await apiLike(session, post.id, !nowLiked);
    } catch {
      // Revert on failure
      setLiked(!nowLiked);
      setLikeCount((c) => c + (nowLiked ? -1 : 1));
    } finally {
      likeInFlight.current = false;
    }
  }, [liked, post.id, session]);

  // Build current slide
  const isCarousel = post.mediaType === 8 && post.carouselMedia && post.carouselMedia.length > 0;
  const currentSlide: CarouselSlide = isCarousel
    ? post.carouselMedia![carouselIdx] ?? { mediaType: 1, images: post.images }
    : { mediaType: post.mediaType, images: post.images, videoUrl: post.videoUrl };

  const img = bestImage(currentSlide.images);
  const aspectRatio = img && img.width && img.height ? img.height / img.width : 1;
  const paddingBottom = `${Math.min(Math.max(aspectRatio, 0.5), 1.25) * 100}%`;

  const isVideo = currentSlide.mediaType === 2 && currentSlide.videoUrl;

  return (
    <article
      ref={cardRef}
      className="bg-white border-b border-gray-100"
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <img
          src={proxyImage(post.user.profilePicUrl)}
          alt={post.user.username}
          className="w-8 h-8 rounded-full object-cover bg-gray-100"
          loading="lazy"
        />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-semibold text-gray-900 truncate block">
            {post.user.username}
            {post.user.isVerified && (
              <span className="ml-1 text-blue-500 text-xs">✓</span>
            )}
          </span>
        </div>
        <span className="text-xs text-gray-400 shrink-0 mr-2">
          <RelativeTime timestamp={post.timestamp} />
        </span>
        {post.shortcode && (
          <a
            href={`https://www.instagram.com/p/${post.shortcode}/`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-300 hover:text-gray-500 text-sm"
            aria-label="Open in Instagram"
            onClick={(e) => e.stopPropagation()}
          >
            ↗
          </a>
        )}
      </div>

      {/* Media + carousel overlays in one container */}
      <div
        className="relative"
        onTouchStart={(e) => {
          if (!isCarousel) return;
          swipeTouchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }}
        onTouchEnd={(e) => {
          if (!isCarousel || !swipeTouchStart.current) return;
          const dx = e.changedTouches[0].clientX - swipeTouchStart.current.x;
          const dy = e.changedTouches[0].clientY - swipeTouchStart.current.y;
          swipeTouchStart.current = null;
          // Only trigger if horizontal swipe dominates and exceeds threshold
          if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
          if (dx < 0) setCarouselIdx((i) => Math.min(i + 1, post.carouselMedia!.length - 1));
          else setCarouselIdx((i) => Math.max(i - 1, 0));
        }}
      >
        {isVideo ? (
          <VideoPlayer
            src={proxyImage(currentSlide.videoUrl!)}
            poster={img ? proxyImage(img.url) : undefined}
            aspectPaddingBottom={paddingBottom}
          />
        ) : img ? (
          <div className="relative w-full bg-gray-200" style={{ paddingBottom }}>
            <FadeImg
              src={proxyImage(img.url)}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
              priority={priority}
            />
          </div>
        ) : null}

        {/* Carousel controls — overlaid on media */}
        {isCarousel && post.carouselMedia!.length > 1 && (
          <>
            {/* Dot indicators */}
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1">
              {post.carouselMedia!.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setCarouselIdx(i)}
                  className={`w-1.5 h-1.5 rounded-full transition-colors ${
                    i === carouselIdx ? "bg-white" : "bg-white/50"
                  }`}
                />
              ))}
            </div>
            {/* Prev arrow */}
            {carouselIdx > 0 && (
              <button
                onClick={() => setCarouselIdx((i) => i - 1)}
                className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/30 hover:bg-black/50 text-white rounded-full w-8 h-8 flex items-center justify-center text-lg"
              >
                ‹
              </button>
            )}
            {/* Next arrow */}
            {carouselIdx < post.carouselMedia!.length - 1 && (
              <button
                onClick={() => setCarouselIdx((i) => i + 1)}
                className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/30 hover:bg-black/50 text-white rounded-full w-8 h-8 flex items-center justify-center text-lg"
              >
                ›
              </button>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="px-3 pt-2 pb-1">
        {/* Action row */}
        <div className="flex items-center gap-1 mb-1.5 -ml-1.5">
          <button
            onClick={toggleLike}
            className="p-1.5 rounded-full active:scale-90 transition-transform"
            aria-label={liked ? "Unlike" : "Like"}
          >
            <HeartIcon filled={liked} />
          </button>
          {likeCount > 0 && (
            <span className="text-sm font-semibold text-gray-900">
              {likeCount.toLocaleString()}
            </span>
          )}
        </div>
        {post.caption && (
          <p className="text-sm text-gray-800 leading-snug">
            <span className="font-semibold mr-1">{post.user.username}</span>
            <Caption text={post.caption} />
          </p>
        )}
      </div>

      {/* Comments */}
      <CommentsSection
        session={session}
        mediaId={post.id}
        commentCount={post.commentCount}
      />
    </article>
  );
}

function Caption({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const LIMIT = 120;

  if (text.length <= LIMIT || expanded) {
    return <span>{text}</span>;
  }

  return (
    <>
      <span>{text.slice(0, LIMIT)}… </span>
      <button
        onClick={() => setExpanded(true)}
        className="text-gray-500 font-normal"
      >
        more
      </button>
    </>
  );
}

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`w-6 h-6 transition-colors ${filled ? "fill-red-500 stroke-red-500" : "fill-none stroke-gray-800"}`}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}
