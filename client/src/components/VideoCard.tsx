import type { VideoInfo } from "../types";

interface VideoCardProps {
  label: "A" | "B";
  video: VideoInfo | null;
  isLoading: boolean;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function PlatformBadge({ platform }: { platform: "youtube" | "instagram" }) {
  const isYT = platform === "youtube";
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
        isYT ? "bg-red-100 text-red-700" : "bg-pink-100 text-pink-700"
      }`}
    >
      {isYT ? "▶ YouTube" : "◈ Instagram"}
    </span>
  );
}

function StatBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center p-3 bg-gray-50 rounded-lg">
      <span className="text-lg font-bold text-gray-800">{value}</span>
      <span className="text-xs text-gray-500 mt-0.5">{label}</span>
    </div>
  );
}

// Loading skeleton
function CardSkeleton({ label }: { label: "A" | "B" }) {
  return (
    <div className="flex-1 bg-white rounded-2xl border border-gray-200 p-5 shadow-sm animate-pulse">
      <div className="flex items-center justify-between mb-4">
        <div className="h-6 w-16 bg-gray-200 rounded-full" />
        Video {label}
        <div className="h-5 w-20 bg-gray-200 rounded-full" />
      </div>
      <div className="h-5 bg-gray-200 rounded w-3/4 mb-2" />
      <div className="h-4 bg-gray-200 rounded w-1/2 mb-4" />
      <div className="grid grid-cols-2 gap-2">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-14 bg-gray-100 rounded-lg" />
        ))}
      </div>
    </div>
  );
}

export default function VideoCard({ label, video, isLoading }: VideoCardProps) {
  if (isLoading) return <CardSkeleton label={label} />;

  if (!video) {
    return (
      <div className="flex-1 bg-white rounded-2xl border-2 border-dashed border-gray-200 p-5 flex flex-col items-center justify-center min-h-48 text-gray-400">
        <div className="text-4xl mb-2">{label === "A" ? "🎬" : "📱"}</div>
        <p className="text-sm font-medium">Video {label}</p>
        <p className="text-xs mt-1">Enter a URL above to load</p>
      </div>
    );
  }

  const engagementDisplay =
    video.engagementRate !== null
      ? `${video.engagementRate.toFixed(2)}%`
      : "N/A";

  return (
    <div className="flex-1 bg-white rounded-2xl border border-gray-200 p-5 shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 font-bold text-sm">
          {label}
        </span>
        <PlatformBadge platform={video.platform} />
      </div>

      {/* Title + creator */}
      <h3 className="font-semibold text-gray-900 text-sm leading-snug line-clamp-2 mb-1">
        {video.title}
      </h3>
      <p className="text-xs text-gray-500 mb-4">by {video.uploaderName}</p>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-2">
        <StatBlock label="Views" value={formatNumber(video.viewCount)} />
        <StatBlock label="Engagement" value={engagementDisplay} />
        <StatBlock label="Likes" value={formatNumber(video.likeCount)} />
        <StatBlock label="Comments" value={formatNumber(video.commentCount)} />
      </div>

      {/* Link */}
      <a
        href={video.url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-4 flex items-center justify-center w-full text-xs text-indigo-600 hover:text-indigo-800 font-medium py-2 rounded-lg border border-indigo-100 hover:bg-indigo-50 transition-colors"
      >
        Open video ↗
      </a>
    </div>
  );
}
