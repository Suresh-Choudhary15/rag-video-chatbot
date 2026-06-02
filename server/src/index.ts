import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import {
  scrapeVideo,
  scrapeReel,
  detectPlatform,
  computeEngagementRate,
} from "./services/videoScraper";
import {
  ingestVideo,
  buildCombinedStore,
  queryRAGStream,
  ChatMessage,
} from "./services/ragEngine";

dotenv.config();

// ── Types ─────────────────────────────────────────────────────────────────────

interface HealthCheckResponse {
  status: "ok" | "error";
  timestamp: string;
  uptime: number;
  environment: string;
  version: string;
  chromadb: string;
}

interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}

interface ChatBody {
  query: string;
  history?: ChatMessage[];
  urlA?: string;
  urlB?: string;
}

// ── In-memory ingest state ────────────────────────────────────────────────────

/*
 * keep track of url pairs already ingested
 * avoids re-ingesting the same pair in this server session
 * resets when server restarts
 */
interface IngestedVideoInfo {
  title: string;
  uploaderName: string;
  platform: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  engagementRate: number | null;
  url: string;
}

interface IngestState {
  videoA: IngestedVideoInfo;
  videoB: IngestedVideoInfo;
}

const ingestCache = new Map<string, IngestState>();

function cacheKey(urlA: string, urlB: string): string {
  return `${urlA.trim()}||${urlB.trim()}`;
}

// ── App ───────────────────────────────────────────────────────────────────────

const app = express();
const PORT: number = parseInt(process.env.PORT ?? "3001", 10);
const ENV: string = process.env.NODE_ENV ?? "development";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS for Vite dev server & handle OPTIONS preflight explicitly
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "http://localhost:5173");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (_req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }
  next();
});

// ── Health ────────────────────────────────────────────────────────────────────

app.get(
  "/health",
  async (_req: Request, res: Response<HealthCheckResponse>) => {
    let chromaStatus = "ok";
    try {
      const r = await fetch(
        `${process.env.CHROMA_URL ?? "http://localhost:8000"}/api/v2/heartbeat`,
      );
      if (!r.ok) chromaStatus = "unreachable";
    } catch {
      chromaStatus = "unreachable";
    }

    res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      environment: ENV,
      version: "1.0.0",
      chromadb: chromaStatus,
    });
  },
);

// ── POST /api/chat ────────────────────────────────────────────────────────────

/*
 * main chat endpoint
 *
 * First message: client sends urlA + urlB + query
 *   - scrape both videos
 *   - ingest data into chroma
 *   - run rag query and stream response
 *
 * Follow-up messages: client sends query + history only
 *   - skip ingestion
 *   - use chat history for context
 *   - stream response
 *
 * SSE format:
 *   - sends tokens first, then sources at the end
 */
app.post("/api/chat", async (req: Request<{}, {}, ChatBody>, res: Response) => {
  const { query, history = [], urlA, urlB } = req.body;

  // ── Validation ──────────────────────────────────────────────────────────────

  if (!query?.trim()) {
    res.status(400).json({
      error: "BadRequest",
      message: "query is required.",
      statusCode: 400,
    });
    return;
  }

  // If URLs provided, both must be present
  if ((urlA && !urlB) || (!urlA && urlB)) {
    res.status(400).json({
      error: "BadRequest",
      message: "Both urlA and urlB are required when providing video URLs.",
      statusCode: 400,
    });
    return;
  }

  // If no URLs and no cached state, can't answer
  const key = urlA && urlB ? cacheKey(urlA, urlB) : null;
  const cached = key ? ingestCache.get(key) : ingestCache.values().next().value;

  if (!cached && (!urlA || !urlB)) {
    res.status(400).json({
      error: "BadRequest",
      message: "urlA and urlB are required for the first message.",
      statusCode: 400,
    });
    return;
  }

  // ── SSE headers ─────────────────────────────────────────────────────────────

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Helper to write SSE events
  const send = (data: object) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    let state: IngestState;
    // ── Ingest if needed ──────────────────────────────────────────────────────

    if (key && !ingestCache.has(key) && urlA && urlB) {
      send({ status: "scraping", message: "Scraping videos..." });
      console.log(`[chat] Scraping Video A: ${urlA}`);
      console.log(`[chat] Scraping Video B: ${urlB}`);

      const platformA = detectPlatform(urlA);
      const platformB = detectPlatform(urlB);

      // Scrape both in parallel
      const [dataA, dataB] = await Promise.all([
        platformA === "youtube" ? scrapeVideo(urlA) : scrapeReel(urlA),
        platformB === "youtube" ? scrapeVideo(urlB) : scrapeReel(urlB),
      ]);

      const metaA = {
        videoId: dataA.metadata.id,
        videoLabel: "A" as const,
        platform: platformA,
        title: dataA.metadata.title,
        uploaderName: dataA.metadata.uploaderName,
        viewCount: dataA.metadata.viewCount,
        likeCount: dataA.metadata.likeCount,
        commentCount: dataA.metadata.commentCount,
        engagementRate: computeEngagementRate(dataA.metadata),
        sourceUrl: dataA.metadata.url,
        uploadDate: dataA.metadata.uploadDate,
      };

      const metaB = {
        videoId: dataB.metadata.id,
        videoLabel: "B" as const,
        platform: platformB,
        title: dataB.metadata.title,
        uploaderName: dataB.metadata.uploaderName,
        viewCount: dataB.metadata.viewCount,
        likeCount: dataB.metadata.likeCount,
        commentCount: dataB.metadata.commentCount,
        engagementRate: computeEngagementRate(dataB.metadata),
        sourceUrl: dataB.metadata.url,
        uploadDate: dataB.metadata.uploadDate,
      };

      const textA =
        "fullTranscriptText" in dataA
          ? dataA.fullTranscriptText
          : dataA.transcriptText;

      const textB =
        "fullTranscriptText" in dataB
          ? dataB.fullTranscriptText
          : dataB.transcriptText;

      send({ status: "ingesting", message: "Building vector store..." });

      // Ingest both then build combined
      await Promise.all([
        ingestVideo(textA, metaA, "A"),
        ingestVideo(textB, metaB, "B"),
      ]);
      await buildCombinedStore(textA, metaA, textB, metaB);

      state = {
        videoA: {
          title: metaA.title,
          uploaderName: metaA.uploaderName,
          platform: metaA.platform,
          viewCount: metaA.viewCount,
          likeCount: metaA.likeCount,
          commentCount: metaA.commentCount,
          engagementRate: metaA.engagementRate,
          url: metaA.sourceUrl,
        },
        videoB: {
          title: metaB.title,
          uploaderName: metaB.uploaderName,
          platform: metaB.platform,
          viewCount: metaB.viewCount,
          likeCount: metaB.likeCount,
          commentCount: metaB.commentCount,
          engagementRate: metaB.engagementRate,
          url: metaB.sourceUrl,
        },
      };

      ingestCache.set(key, state);
      console.log(`[chat] Ingest complete — cached under key`);
    } else {
      // Use cached state
      state = cached!;
    }
    // ── RAG stream ────────────────────────────────────────────────────────────

    send({ status: "thinking", message: "Generating answer..." });

    // Cap history at last 10 messages — prevents context window abuse
    const cappedHistory = history.slice(-10);

    const { stream, sources, retrievedChunks } = await queryRAGStream({
      query: query.trim(),
      storeLabel: "combined",
      topK: 4,
      history: cappedHistory,
    });

    // Stream tokens
    for await (const token of stream) {
      send({ token });
    }

    // Final event — sources + video metadata + done signal
    send({
      sources,
      retrievedChunks,
      videoA: state.videoA,
      videoB: state.videoB,
      done: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[chat] Error:", message);
    send({ error: message, done: true });
  } finally {
    res.end();
  }
});

// ── Error handler ─────────────────────────────────────────────────────────────

app.use(
  (err: Error, _req: Request, res: Response<ApiError>, _next: NextFunction) => {
    console.error("[Server Error]", err.message);
    res.status(500).json({
      error: "InternalServerError",
      message: err.message,
      statusCode: 500,
    });
  },
);

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT} [${ENV}]`);
  console.log(`🔍 Health: http://localhost:${PORT}/health`);
});

export default app;
