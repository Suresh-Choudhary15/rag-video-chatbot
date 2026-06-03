# RAG Video Chatbot

A full-stack AI tool that lets you paste two social media video URLs — one YouTube, one Instagram Reel — and have a conversation about them. The AI compares engagement rates, breaks down content strategy, and cites exactly which video it's pulling from.

Built in 5 days as part of a technical challenge.

The goal was to compare content from a YouTube video and an Instagram Reel using a RAG pipeline while keeping the setup simple enough to run locally.

---

## What it actually does

1. You paste two video URLs
2. The backend scrapes metadata and transcripts from both
3. Transcripts get chunked, embedded locally, and stored in ChromaDB
4. You ask questions in the chat
5. The AI retrieves relevant chunks from both videos, formats them with engagement metrics, and streams a cited answer back token by token

The whole thing runs locally. No managed vector DB, no paid embedding API, no external services beyond Groq for the LLM and Whisper calls.

---

## Tech stack

### Backend

- **Node.js + Express + TypeScript** — API server, SSE streaming
- **yt-dlp-exec** — scrapes YouTube and Instagram metadata without needing the official APIs (YouTube removed public like counts from their API in 2021, yt-dlp still gets them)
- **youtube-transcript** — pulls caption tracks from YouTube directly, much faster than running Whisper on every video
- **groq-sdk** — Whisper large-v3 for Instagram audio transcription, llama-3.3-70b-versatile for the RAG answers
- **@huggingface/transformers v4** — all-MiniLM-L6-v2 running locally via ONNX, produces 384-dimensional embeddings with no API calls
- **chromadb** — vector store, runs in Docker, persists collections to disk
- **LangChain (core, groq, textsplitters)** — RAG chain, prompt templates, text splitting

### Frontend

- **React + Vite + TypeScript** — fast dev server, no build config overhead
- **Tailwind CSS v4** — utility classes via the new Vite plugin, no PostCSS config needed

### Infrastructure

- **Docker** — single container for ChromaDB, volume-mounted to `server/data/chromadb/`

---

## Setup

### Prerequisites

- Node.js v18 or higher (tested on v22.14.0)
- Docker Desktop running
- A Groq API key (free at console.groq.com)

### 1. Clone and install

```bash
git clone https://github.com/Suresh-Choudhary15/rag-video-chatbot.git
cd rag-video-chatbot

# Install server dependencies
cd server && npm install && cd ..

# Install client dependencies
cd client && npm install && cd ..
```

### 2. Environment variables

Create `server/.env`:

```env
PORT=3001
NODE_ENV=development
GROQ_API_KEY=your_groq_api_key_here
CHROMA_URL=http://localhost:8000
```

### 3. Start ChromaDB

```bash
docker compose up -d
```

Verify it's running:

```bash
curl http://localhost:8000/api/v2/heartbeat
```

### 4. Start the backend

```bash
cd server
npm run dev
```

Health check at `http://localhost:3001/health` should show `"chromadb": "ok"`.

### 5. Start the frontend

```bash
cd client
npm run dev
```

Open `http://localhost:5173`.

---

## How to use it

1. Paste a YouTube URL in field A
2. Paste an Instagram Reel URL in field B
3. Click **Load & Compare Videos** — this takes 30–60 seconds the first time
4. Once the video cards populate, the chat interface appears below
5. Ask anything — the AI cites "Based on Video A..." and "Based on Video B..." in every answer

The first request scrapes both videos, runs Whisper transcription on the Instagram audio, chunks both transcripts, embeds them, and stores them in ChromaDB. Follow-up messages skip all of that and go straight to the RAG query.

---

## Architecture decisions and trade-offs

### Why ChromaDB over Pinecone or Weaviate

ChromaDB runs in a Docker container on localhost. Pinecone and Weaviate both require account signup, API keys, and network round-trips on every vector operation. For a two-video comparison tool the latency difference between a local query (sub-millisecond) and a cloud query (100–200ms) is actually noticeable when you're retrieving 4 chunks per message. ChromaDB also persists collections to disk via the volume mount, so re-ingesting after a server restart is optional not mandatory. It is also explicitly on the approved list for this challenge which made the decision straightforward.

### Why local HuggingFace embeddings over OpenAI

all-MiniLM-L6-v2 via @huggingface/transformers v4 runs entirely in-process using ONNX Runtime. The quantized int8 model is about 23MB and embeds a chunk in roughly 20ms on CPU. OpenAI text-embedding-3-small would be more accurate on MTEB benchmarks by a few percentage points but adds a third API key to manage, sends transcript content to an external server, and introduces 100–200ms network latency per embedding call. For 60 chunks across two videos the total embedding time is about 1.2 seconds locally versus 10–15 seconds waiting on OpenAI. The accuracy delta at this scale is invisible.

### Why M4A instead of MP3 for Instagram audio

The original plan used FFmpeg to convert yt-dlp's audio output to MP3 before sending to Whisper. During testing this immediately failed because FFmpeg is not installed by default on most machines. Groq's Whisper API accepts M4A directly, yt-dlp downloads M4A natively without any post-processing, so the conversion step was removed entirely. Fewer dependencies, fewer failure points, same output. The pipeline went from four steps to three.

### Why a single /api/chat endpoint instead of separate ingest and chat endpoints

The challenge spec asked for a demo-able product, not a microservices architecture. A single endpoint that handles ingest-on-first-request keeps the frontend logic simple — one SSE connection, one set of status events, no orchestration between two separate requests. The in-memory cache prevents re-scraping on follow-up messages. A recruiter watching the Loom demo sees the status events go from scraping to ingesting to thinking to streaming tokens. Everything is visible in one flow.

### What breaks at scale

**Single-threaded embedding** — ONNX Runtime uses an internal thread pool but Node.js is single-threaded for JavaScript execution. Embedding is the CPU bottleneck. At 10 concurrent users each ingesting 30-chunk videos you would see significant queueing. Fix: move embedding to a worker thread pool or use a dedicated embedding service.

**yt-dlp rate limiting** — Instagram and YouTube both rate-limit automated scrapers. For a demo with 2 videos this never triggers. At 100 requests per day you would start seeing 429 errors from Instagram especially. Fix: add request throttling with random delays, use proxy rotation for production workloads.

**In-memory ingest cache** — the cache that prevents re-scraping resets on every server restart. A crash mid-session loses the cached state and the next message re-triggers a 60-second scrape. Fix: persist the cache to Redis with a TTL, or check whether ChromaDB collections already exist before deciding to re-ingest.

**ChromaDB single instance** — the Docker container is not clustered. One instance, one machine, no replication. For a personal tool or demo this is fine. For multi-user production: Qdrant or Weaviate with proper clustering.

---

## Project structure

```
rag-video-chatbot/
├── client/                    React + Vite frontend
│   └── src/
│       ├── components/
│       │   ├── VideoCard.tsx  Side-by-side video metadata cards
│       │   └── ChatInterface.tsx  SSE streaming chat
│       ├── types.ts           Shared TypeScript interfaces
│       └── App.tsx            URL inputs, state management
├── server/
│   └── src/
│       ├── index.ts           Express server, /api/chat SSE endpoint
│       └── services/
│           ├── videoScraper.ts    YouTube + Instagram metadata/transcript
│           ├── transcription.ts   Groq Whisper audio transcription
│           └── ragEngine.ts       Chunking, embeddings, ChromaDB, RAG chain
├── docker-compose.yml         ChromaDB container
└── README.md
```

---

## Known limitations

- Instagram Reels with no spoken dialogue (music-only, silent) will produce empty transcripts and the AI will rely on metadata only
- The first message always takes 30–60 seconds due to scraping and transcription
- The in-memory cache resets on server restart
- No authentication — anyone who can reach localhost:3001 can use the API
