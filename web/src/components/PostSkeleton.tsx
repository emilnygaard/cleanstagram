/** Animated placeholder that mirrors the PostCard layout while loading. */
export function PostSkeleton() {
  return (
    <div className="bg-white border-b border-gray-100 animate-pulse">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <div className="w-8 h-8 rounded-full bg-gray-200 shrink-0" />
        <div className="flex-1 space-y-1.5">
          <div className="h-2.5 w-28 bg-gray-200 rounded-full" />
        </div>
        <div className="h-2 w-6 bg-gray-200 rounded-full" />
      </div>
      {/* Image — square ratio */}
      <div className="w-full bg-gray-200" style={{ paddingBottom: "100%" }} />
      {/* Footer */}
      <div className="px-3 py-2.5 space-y-2">
        <div className="h-2.5 w-16 bg-gray-200 rounded-full" />
        <div className="h-2.5 w-full bg-gray-200 rounded-full" />
        <div className="h-2.5 w-3/4 bg-gray-200 rounded-full" />
      </div>
    </div>
  );
}

/** Skeleton row for the stories strip. */
export function StoriesRowSkeleton() {
  return (
    <div className="bg-white border-b border-gray-100">
      <div className="flex gap-3 px-3 py-3 overflow-hidden">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex flex-col items-center gap-1.5 shrink-0 w-16 animate-pulse">
            <div className="w-14 h-14 rounded-full bg-gray-200" />
            <div className="h-2 w-10 bg-gray-200 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
