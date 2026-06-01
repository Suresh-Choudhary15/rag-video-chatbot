import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { pipeline } from "@huggingface/transformers";
import { Document } from "@langchain/core/documents";
import { ChromaClient, Collection } from "chromadb";
import { ChatGroq } from "@langchain/groq";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";
import { HumanMessage, AIMessage, BaseMessage } from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";
import {
  RunnableSequence,
  RunnablePassthrough,
} from "@langchain/core/runnables";
import dotenv from "dotenv";

dotenv.config();

// ── Types ─────────────────────────────────────────────────────────────────────

export type VideoLabel = "A" | "B";
export type StoreLabel = VideoLabel | "combined";

export interface ChunkMetadata {
  videoId: string;
  videoLabel: VideoLabel;
  platform: "youtube" | "instagram";
  title: string;
  uploaderName: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  engagementRate: number | null;
  chunkIndex: number;
  totalChunks: number;
  sourceUrl: string;
  uploadDate: string;
}

export interface EmbeddedChunk {
  document: Document<ChunkMetadata>;
  embedding: number[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface RAGQueryOptions {
  query: string;
  storeLabel: StoreLabel;
  topK?: number;
  history?: ChatMessage[];
}

export interface RAGSource {
  videoLabel: VideoLabel;
  videoId: string;
  title: string;
  uploaderName: string;
  chunkIndex: number;
  excerpt: string;
}

export interface RAGResponse {
  answer: string;
  sources: RAGSource[];
  query: string;
  retrievedChunks: number;
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class ChunkingError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ChunkingError";
  }
}

export class EmbeddingError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EmbeddingError";
  }
}

// ── Chunking ──────────────────────────────────────────────────────────────────

/*
 * 500 chars / 50 overlap ≈ 25–35s of speech = one "thought unit"
 * in short-form social media content.
 * Separators tried in order — respects natural speech boundaries first.
 */
const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 500,
  chunkOverlap: 50,
  separators: ["\n\n", "\n", ". ", "! ", "? ", ", ", " ", ""],
});

// ── Embedding model singleton ─────────────────────────────────────────────────

/*
 * @huggingface/transformers v4 — renamed from @xenova/transformers Feb 2026.
 * all-MiniLM-L6-v2: 384d vectors, ~23MB quantized, ~20ms/chunk on CPU.
 * dtype: "q8" is the v4 equivalent of quantized: true.
 * Fully local — transcript text never leaves the server during embedding.
 */
let embedderPipeline: Awaited<ReturnType<typeof pipeline>> | null = null;

async function getEmbedder(): Promise<Awaited<ReturnType<typeof pipeline>>> {
  if (!embedderPipeline) {
    console.log("[ragEngine] Loading embedding model (~25MB first run)...");
    embedderPipeline = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
      { dtype: "q8" },
    );
    console.log("[ragEngine] Embedding model ready.");
  }
  return embedderPipeline;
}

export async function embedText(text: string): Promise<number[]> {
  const model = await getEmbedder();
  try {
    const output = await (model as any)(text, {
      pooling: "mean",
      normalize: true,
    });
    return Array.from(output.data as Float32Array);
  } catch (err) {
    throw new EmbeddingError("Failed to embed text", err);
  }
}

export function getEmbeddingDimension(): number {
  return 384;
}

// ── Chunking pipeline ─────────────────────────────────────────────────────────

export async function chunkTranscript(
  text: string,
  metadata: Omit<ChunkMetadata, "chunkIndex" | "totalChunks">,
): Promise<Document<ChunkMetadata>[]> {
  if (!text.trim()) throw new ChunkingError("Cannot chunk empty transcript.");

  const rawChunks = await splitter.splitText(text);

  if (rawChunks.length === 0) {
    throw new ChunkingError(
      `Splitter produced zero chunks for: ${metadata.videoId}`,
    );
  }

  return rawChunks.map(
    (chunk, index) =>
      new Document<ChunkMetadata>({
        pageContent: chunk,
        metadata: {
          ...metadata,
          chunkIndex: index,
          totalChunks: rawChunks.length,
        },
      }),
  );
}

export async function embedChunks(
  documents: Document<ChunkMetadata>[],
): Promise<EmbeddedChunk[]> {
  if (!documents.length) throw new EmbeddingError("No documents to embed.");

  const results: EmbeddedChunk[] = [];

  // Sequential — NOT Promise.all. ONNX uses internal thread pool.
  // Concurrent calls cause memory contention and slower throughput.
  for (const doc of documents) {
    results.push({
      document: doc,
      embedding: await embedText(doc.pageContent),
    });
  }

  console.log(
    `[ragEngine] Embedded ${results.length} chunks for: ${documents[0].metadata.videoId}`,
  );
  return results;
}

export async function chunkAndEmbed(
  text: string,
  metadata: Omit<ChunkMetadata, "chunkIndex" | "totalChunks">,
): Promise<EmbeddedChunk[]> {
  const documents = await chunkTranscript(text, metadata);
  return embedChunks(documents);
}

// ── ChromaDB client ───────────────────────────────────────────────────────────

/*
 * Direct chromadb JS client — @langchain/community was sunset May 27 2026.
 * One client per process, lazy init.
 */
const CHROMA_URL = process.env.CHROMA_URL ?? "http://localhost:8000";
let chromaClient: ChromaClient | null = null;

// NEW — use host/port instead of path, suppress default embedding warning
function getChromaClient(): ChromaClient {
  if (!chromaClient) {
    chromaClient = new ChromaClient({
      host: "localhost",
      port: 8000,
      ssl: false,
    });
  }
  return chromaClient;
}

function collectionName(label: StoreLabel): string {
  return `video_${label.toLowerCase()}`;
}

// ── Ingestion ─────────────────────────────────────────────────────────────────

export async function ingestVideo(
  text: string,
  metadata: Omit<ChunkMetadata, "chunkIndex" | "totalChunks">,
  label: VideoLabel,
): Promise<number> {
  const documents = await chunkTranscript(text, {
    ...metadata,
    videoLabel: label,
  });

  const embedded = await embedChunks(documents);
  const client = getChromaClient();
  const name = collectionName(label);

  // Delete existing collection — clean re-ingest
  try {
    await client.deleteCollection({ name });
  } catch {
    /* ok if not exists */
  }

  // NEW
  const collection = await client.createCollection({
    name,
    metadata: { "hnsw:space": "cosine" },
    embeddingFunction: null as any,
  });

  await collection.add({
    ids: embedded.map((_, i) => `${metadata.videoId}_chunk_${i}`),
    embeddings: embedded.map((e) => e.embedding),
    documents: embedded.map((e) => e.document.pageContent),
    metadatas: embedded.map((e) => ({
      ...e.document.metadata,
      // Chroma only stores primitives — null becomes -1, restored on read
      engagementRate: e.document.metadata.engagementRate ?? -1,
    })),
  });

  console.log(`[ragEngine] Ingested ${documents.length} chunks → ${name}`);
  return documents.length;
}

export async function buildCombinedStore(
  textA: string,
  metadataA: Omit<ChunkMetadata, "chunkIndex" | "totalChunks">,
  textB: string,
  metadataB: Omit<ChunkMetadata, "chunkIndex" | "totalChunks">,
): Promise<void> {
  const [docsA, docsB] = await Promise.all([
    chunkTranscript(textA, { ...metadataA, videoLabel: "A" }),
    chunkTranscript(textB, { ...metadataB, videoLabel: "B" }),
  ]);

  const allDocs = [...docsA, ...docsB];
  const allEmbedded = await embedChunks(allDocs);

  const client = getChromaClient();
  const name = collectionName("combined");

  try {
    await client.deleteCollection({ name });
  } catch {
    /* ok */
  }

  const collection = await client.createCollection({
    name,
    metadata: { "hnsw:space": "cosine" },
    embeddingFunction: null as any,
  });

  await collection.add({
    ids: allEmbedded.map((_, i) => `combined_chunk_${i}`),
    embeddings: allEmbedded.map((e) => e.embedding),
    documents: allEmbedded.map((e) => e.document.pageContent),
    metadatas: allEmbedded.map((e) => ({
      ...e.document.metadata,
      engagementRate: e.document.metadata.engagementRate ?? -1,
    })),
  });

  console.log(`[buildCombinedStore] ${allDocs.length} chunks → ${name}`);
}

async function loadCollection(label: StoreLabel): Promise<Collection> {
  const client = getChromaClient();
  const name = collectionName(label);
  try {
    return await client.getCollection({ name, embeddingFunction: null as any });
  } catch {
    throw new Error(
      `Chroma collection "${name}" not found. ` +
        `Run ingestVideo() first. Docker running? docker compose up -d`,
    );
  }
}

// ── Similarity search ─────────────────────────────────────────────────────────

export async function similaritySearch(
  label: StoreLabel,
  queryEmbedding: number[],
  topK: number,
): Promise<Document<ChunkMetadata>[]> {
  const collection = await loadCollection(label);

  const results = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: topK,
    include: ["documents", "metadatas"] as any,
  });

  const docs: Document<ChunkMetadata>[] = [];
  const documents = results.documents?.[0] ?? [];
  const metadatas = results.metadatas?.[0] ?? [];

  for (let i = 0; i < documents.length; i++) {
    const raw = metadatas[i] as Record<string, unknown>;
    docs.push(
      new Document<ChunkMetadata>({
        pageContent: documents[i] ?? "",
        metadata: {
          videoId: String(raw.videoId ?? ""),
          videoLabel: String(raw.videoLabel ?? "A") as VideoLabel,
          platform: String(raw.platform ?? "youtube") as
            | "youtube"
            | "instagram",
          title: String(raw.title ?? ""),
          uploaderName: String(raw.uploaderName ?? ""),
          viewCount: Number(raw.viewCount ?? 0),
          likeCount: Number(raw.likeCount ?? 0),
          commentCount: Number(raw.commentCount ?? 0),
          engagementRate:
            Number(raw.engagementRate) === -1
              ? null
              : Number(raw.engagementRate ?? 0),
          chunkIndex: Number(raw.chunkIndex ?? 0),
          totalChunks: Number(raw.totalChunks ?? 1),
          sourceUrl: String(raw.sourceUrl ?? ""),
          uploadDate: String(raw.uploadDate ?? ""),
        },
      }),
    );
  }

  return docs;
}

// ── LLM singleton ─────────────────────────────────────────────────────────────

let llmInstance: ChatGroq | null = null;

function getLLM(): ChatGroq {
  if (!llmInstance) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY not set in server/.env");
    llmInstance = new ChatGroq({
      apiKey,
      model: "llama-3.3-70b-versatile",
      temperature: 0.2,
      maxTokens: 1024,
    });
  }
  return llmInstance;
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a social media analyst AI helping creators compare video performance.

Answer using ONLY the provided context — no outside knowledge.

CITATION RULES (mandatory):
- Always attribute with "Based on Video A..." or "Based on Video B..."
- Compare both videos explicitly when both are relevant
- Include engagement metrics when relevant to the question

ENGAGEMENT RATE = (likes + comments) / views × 100
Use pre-computed values from metadata — never estimate.

HONESTY: If context is insufficient say "The provided videos don't contain enough information about [topic]."

FORMAT: Clear prose, under 300 words, end with one actionable insight.`;

const HUMAN_PROMPT = `Context:\n{context}\n\nQuestion: {query}`;

function formatContext(docs: Document<ChunkMetadata>[]): string {
  return docs
    .map((doc, i) => {
      const m = doc.metadata;
      const rate =
        m.engagementRate !== null ? `${m.engagementRate.toFixed(2)}%` : "N/A";
      return `--- Source ${i + 1}: Video ${m.videoLabel} ---
Title: ${m.title} | Creator: ${m.uploaderName} | Platform: ${m.platform}
Views: ${m.viewCount.toLocaleString()} | Likes: ${m.likeCount.toLocaleString()} | Comments: ${m.commentCount.toLocaleString()} | Engagement: ${rate}
Chunk ${m.chunkIndex + 1}/${m.totalChunks}: "${doc.pageContent}"`;
    })
    .join("\n\n");
}

function extractSources(docs: Document<ChunkMetadata>[]): RAGSource[] {
  const seen = new Set<string>();
  return docs
    .filter((doc) => {
      const key = `${doc.metadata.videoId}_${doc.metadata.chunkIndex}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((doc) => ({
      videoLabel: doc.metadata.videoLabel,
      videoId: doc.metadata.videoId,
      title: doc.metadata.title,
      uploaderName: doc.metadata.uploaderName,
      chunkIndex: doc.metadata.chunkIndex,
      excerpt: doc.pageContent.slice(0, 120),
    }))
    .sort((a, b) => a.videoLabel.localeCompare(b.videoLabel));
}

// ── RAG query ─────────────────────────────────────────────────────────────────

// Converts frontend {role, content} array to LangChain BaseMessage[]
function toBaseMessages(history: ChatMessage[]): BaseMessage[] {
  return history.map((msg) =>
    msg.role === "user"
      ? new HumanMessage(msg.content)
      : new AIMessage(msg.content),
  );
}

export async function queryRAG(options: RAGQueryOptions): Promise<RAGResponse> {
  const { query, storeLabel, topK = 4, history = [] } = options;
  if (!query.trim()) throw new Error("Query must not be empty.");

  const queryEmbedding = await embedText(query);
  const retrievedDocs = await similaritySearch(
    storeLabel,
    queryEmbedding,
    topK,
  );
  const context = formatContext(retrievedDocs);

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", SYSTEM_PROMPT],
    new MessagesPlaceholder("history"), // ← history injected here
    ["human", HUMAN_PROMPT],
  ]);

  const chain = RunnableSequence.from([
    RunnablePassthrough.assign({
      context: () => context,
      query: () => query,
      history: () => toBaseMessages(history),
    }),
    prompt,
    getLLM(),
    new StringOutputParser(),
  ]);

  const answer = await chain.invoke({
    context,
    query,
    history: toBaseMessages(history),
  });

  return {
    answer,
    sources: extractSources(retrievedDocs),
    query,
    retrievedChunks: retrievedDocs.length,
  };
}

export async function queryRAGStream(options: RAGQueryOptions): Promise<{
  stream: AsyncIterable<string>;
  sources: RAGSource[];
  retrievedChunks: number;
}> {
  const { query, storeLabel, topK = 4, history = [] } = options;
  if (!query.trim()) throw new Error("Query must not be empty.");

  const queryEmbedding = await embedText(query);
  const retrievedDocs = await similaritySearch(
    storeLabel,
    queryEmbedding,
    topK,
  );
  const context = formatContext(retrievedDocs);

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", SYSTEM_PROMPT],
    new MessagesPlaceholder("history"), // same pattern
    ["human", HUMAN_PROMPT],
  ]);

  const chain = RunnableSequence.from([
    RunnablePassthrough.assign({
      context: () => context,
      query: () => query,
      history: () => toBaseMessages(history),
    }),
    prompt,
    getLLM(),
    new StringOutputParser(),
  ]);

  const stream = await chain.stream({
    context,
    query,
    history: toBaseMessages(history),
  });

  return {
    stream,
    sources: extractSources(retrievedDocs),
    retrievedChunks: retrievedDocs.length,
  };
}
