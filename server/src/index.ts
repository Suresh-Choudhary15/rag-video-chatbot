import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";

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

// ── App ───────────────────────────────────────────────────────────────────────

const app = express();
const PORT: number = parseInt(process.env.PORT ?? "3001", 10);
const ENV: string = process.env.NODE_ENV ?? "development";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS for Vite dev server
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "http://localhost:5173");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────

app.get(
  "/health",
  async (_req: Request, res: Response<HealthCheckResponse>) => {
    let chromaStatus = "ok";
    try {
      const r = await fetch(
        `${process.env.CHROMA_URL ?? "http://localhost:8000"}/api/v1/heartbeat`,
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

// Placeholder — wired to RAG chain on Day 3
app.post("/api/chat", (_req: Request, res: Response) => {
  res.status(200).json({
    message: "Chat endpoint — RAG pipeline coming Day 3",
  });
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
