import ytDlp from "yt-dlp-exec";
import { YoutubeTranscript } from "youtube-transcript";
import path from "path";
import fs from "fs";
import { transcribeAndClean } from "./transcription";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Platform = "youtube" | "instagram";

export interface TranscriptSegment {
  text: string;
  offset: number;
  duration: number;
}

export interface VideoMetadata {
  id: string;
  url: string;
  title: string;
  description: string;
  uploadDate: string;
  uploaderName: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  duration: number;
  hashtags: string[];
  thumbnailUrl: string;
}

export interface VideoData {
  metadata: VideoMetadata;
  transcript: TranscriptSegment[];
  fullTranscriptText: string;
  scrapedAt: string;
}

export interface ReelMetadata {
  id: string;
  url: string;
  platform: Platform;
  title: string;
  description: string;
  uploaderName: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  duration: number;
  hashtags: string[];
  thumbnailUrl: string;
  uploadDate: string;
  audioPath: string | null;
}

export interface ReelData {
  metadata: ReelMetadata;
  audioPath: string | null;
  transcriptText: string;
  scrapedAt: string;
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class VideoScraperError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly videoUrl?: string,
  ) {
    super(message);
    this.name = "VideoScraperError";
  }
}

export class TranscriptUnavailableError extends VideoScraperError {
  constructor(videoUrl: string, cause?: unknown) {
    super(`No transcript available for: ${videoUrl}`, cause, videoUrl);
    this.name = "TranscriptUnavailableError";
  }
}

export class MetadataFetchError extends VideoScraperError {
  constructor(videoUrl: string, cause?: unknown) {
    super(`Failed to fetch metadata for: ${videoUrl}`, cause, videoUrl);
    this.name = "MetadataFetchError";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractVideoId(url: string): string {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }
  throw new VideoScraperError(
    `Cannot extract video ID from URL: ${url}`,
    undefined,
    url,
  );
}

function extractReelId(url: string): string {
  const match = url.match(/instagram\.com\/(?:reel|p|tv)\/([A-Za-z0-9_-]+)/);
  if (!match?.[1]) {
    throw new VideoScraperError(
      `Cannot extract Reel ID from URL: ${url}`,
      undefined,
      url,
    );
  }
  return match[1];
}

function safeInt(value: unknown, fallback = 0): number {
  const parsed = parseInt(String(value ?? ""), 10);
  return isNaN(parsed) ? fallback : parsed;
}

export function detectPlatform(url: string): Platform {
  if (/instagram\.com\/(reel|p|tv)\//i.test(url)) return "instagram";
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  throw new VideoScraperError(
    `Unsupported platform URL: ${url}`,
    undefined,
    url,
  );
}

// ── Audio helpers (Instagram) ─────────────────────────────────────────────────

const TEMP_DIR = path.resolve(process.cwd(), "temp");

function ensureTempDir(): void {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

function findDownloadedFile(dir: string, outputId: string): string {
  // yt-dlp uses %(ext)s so we find whatever extension it chose
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(outputId));
  if (files.length === 0) {
    throw new VideoScraperError(
      `No downloaded file found for ID: ${outputId} in ${dir}`,
    );
  }
  return path.join(dir, files[0]);
}

async function downloadAudio(url: string, outputId: string): Promise<string> {
  ensureTempDir();
  // / Check cache — any file starting with this ID
  const existing = fs.readdirSync(TEMP_DIR).find((f) => f.startsWith(outputId));
  if (existing) {
    console.log(`[scraper] Cache hit: ${path.join(TEMP_DIR, existing)}`);
    return path.join(TEMP_DIR, existing);
  }

  try {
    await ytDlp(url, {
      format: "bestaudio[ext=m4a]/bestaudio/best",
      output: path.join(TEMP_DIR, `${outputId}.%(ext)s`),
      noWarnings: true,
    });
  } catch (err) {
    throw new VideoScraperError(`Audio download failed for ${url}`, err, url);
  }

  return findDownloadedFile(TEMP_DIR, outputId);
}

// ── YouTube ───────────────────────────────────────────────────────────────────

async function fetchMetadata(url: string): Promise<VideoMetadata> {
  let raw: Record<string, unknown>;
  try {
    raw = (await ytDlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      skipDownload: true,
    })) as Record<string, unknown>;
  } catch (err) {
    throw new MetadataFetchError(url, err);
  }

  const tags = Array.isArray(raw.tags) ? (raw.tags as string[]) : [];

  return {
    id: String(raw.id ?? extractVideoId(url)),
    url,
    title: String(raw.title ?? ""),
    description: String(raw.description ?? "").slice(0, 2000),
    uploadDate: String(raw.upload_date ?? ""),
    uploaderName: String(raw.uploader ?? raw.channel ?? ""),
    viewCount: safeInt(raw.view_count),
    likeCount: safeInt(raw.like_count),
    commentCount: safeInt(raw.comment_count),
    duration: safeInt(raw.duration),
    hashtags: tags.filter((t) => t.startsWith("#")),
    thumbnailUrl: String(raw.thumbnail ?? ""),
  };
}

async function fetchTranscript(url: string): Promise<TranscriptSegment[]> {
  const videoId = extractVideoId(url);
  let raw: Array<{ text: string; offset: number; duration: number }>;

  try {
    raw = await YoutubeTranscript.fetchTranscript(videoId);
  } catch (err) {
    const msg = err instanceof Error ? err.message.toLowerCase() : "";
    if (
      msg.includes("disabled") ||
      msg.includes("no transcript") ||
      msg.includes("unavailable") ||
      msg.includes("404")
    ) {
      throw new TranscriptUnavailableError(url, err);
    }
    throw new VideoScraperError(
      `Unexpected error fetching transcript for ${url}`,
      err,
      url,
    );
  }

  if (!raw || raw.length === 0) {
    throw new TranscriptUnavailableError(url);
  }

  return raw.map((seg) => ({
    text: seg.text.trim(),
    offset: seg.offset,
    duration: seg.duration,
  }));
}

export async function scrapeVideo(url: string): Promise<VideoData> {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) throw new VideoScraperError("URL must not be empty");

  const [metadata, transcript] = await Promise.all([
    fetchMetadata(trimmedUrl),
    fetchTranscript(trimmedUrl),
  ]);

  const fullTranscriptText = transcript
    .map((s) => s.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    metadata,
    transcript,
    fullTranscriptText,
    scrapedAt: new Date().toISOString(),
  };
}

// ── Instagram ─────────────────────────────────────────────────────────────────

async function fetchReelMetadata(url: string): Promise<ReelMetadata> {
  const reelId = extractReelId(url);
  let raw: Record<string, unknown>;

  try {
    raw = (await ytDlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      skipDownload: true,
    })) as Record<string, unknown>;
  } catch (err) {
    throw new MetadataFetchError(url, err);
  }

  const desc = String(raw.description ?? raw.title ?? "");
  const hashtags = desc.match(/#[\w]+/g) ?? [];

  return {
    id: reelId,
    url,
    platform: "instagram",
    title: String(raw.title ?? raw.fulltitle ?? ""),
    description: desc.slice(0, 2000),
    uploaderName: String(raw.uploader ?? raw.channel ?? raw.uploader_id ?? ""),
    viewCount: safeInt(raw.view_count),
    likeCount: safeInt(raw.like_count),
    commentCount: safeInt(raw.comment_count),
    duration: safeInt(raw.duration),
    hashtags,
    thumbnailUrl: String(raw.thumbnail ?? ""),
    uploadDate: String(raw.upload_date ?? ""),
    audioPath: null,
  };
}

export async function scrapeReel(url: string): Promise<ReelData> {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) throw new VideoScraperError("Reel URL must not be empty");

  const [metadata, audioPath] = await Promise.all([
    fetchReelMetadata(trimmedUrl),
    downloadAudio(trimmedUrl, extractReelId(trimmedUrl)),
  ]);

  // audioPath handed to transcription.ts — transcription happens there
  metadata.audioPath = audioPath;

  // Transcribe audio and delete file — transcription.ts handles cleanup
  const transcriptText = await transcribeAndClean(audioPath);

  metadata.audioPath = null; // file is gone after transcription

  return {
    metadata,
    audioPath,
    transcriptText,
    scrapedAt: new Date().toISOString(),
  };
}

// ── Engagement ────────────────────────────────────────────────────────────────

export function computeEngagementRate(metadata: {
  viewCount: number;
  likeCount: number;
  commentCount: number;
}): number | null {
  const { viewCount, likeCount, commentCount } = metadata;
  if (viewCount === 0 && likeCount === 0 && commentCount === 0) return null;
  if (viewCount === 0) return null;
  return ((likeCount + commentCount) / viewCount) * 100;
}

export function formatEngagementRate(rate: number | null): string {
  if (rate === null) return "N/A (stats hidden)";
  return `${rate.toFixed(2)}%`;
}
