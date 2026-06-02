export interface VideoInfo {
  title: string;
  uploaderName: string;
  platform: "youtube" | "instagram";
  viewCount: number;
  likeCount: number;
  commentCount: number;
  engagementRate: number | null;
  url: string;
}

export interface RAGSource {
  videoLabel: "A" | "B";
  videoId: string;
  title: string;
  uploaderName: string;
  chunkIndex: number;
  excerpt: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type AppStatus =
  | "idle"
  | "scraping"
  | "ingesting"
  | "thinking"
  | "ready"
  | "error";
