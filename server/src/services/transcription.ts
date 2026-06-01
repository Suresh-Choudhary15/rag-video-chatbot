import Groq from "groq-sdk";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TranscriptionResult {
  text: string;
  language: string | null;
  durationSeconds: number | null;
  filePath: string;
  transcribedAt: string;
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class TranscriptionError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly filePath?: string,
  ) {
    super(message);
    this.name = "TranscriptionError";
  }
}

export class AudioFileNotFoundError extends TranscriptionError {
  constructor(filePath: string) {
    super(
      `Audio file not found: ${filePath}. Was it deleted or never downloaded?`,
      undefined,
      filePath,
    );
    this.name = "AudioFileNotFoundError";
  }
}

export class FileTooLargeError extends TranscriptionError {
  constructor(filePath: string, sizeMb: number) {
    super(
      `Audio file too large: ${sizeMb.toFixed(1)}MB at ${filePath}. ` +
        `Groq Whisper limit is 25MB.`,
      undefined,
      filePath,
    );
    this.name = "FileTooLargeError";
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const WHISPER_MODEL = "whisper-large-v3";
const WHISPER_MAX_FILE_MB = 25;
const SUPPORTED_EXTENSIONS = new Set([".mp3", ".mp4", ".wav", ".m4a", ".webm"]);

// ── Groq client singleton ─────────────────────────────────────────────────────

let groqClient: Groq | null = null;

function getGroqClient(): Groq {
  if (!groqClient) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new TranscriptionError(
        "GROQ_API_KEY not set. Add it to server/.env",
      );
    }
    groqClient = new Groq({ apiKey });
  }
  return groqClient;
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateAudioFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    throw new AudioFileNotFoundError(filePath);
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new TranscriptionError(
      `Unsupported format: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}`,
      undefined,
      filePath,
    );
  }

  const stats = fs.statSync(filePath);
  const sizeMb = stats.size / (1024 * 1024);
  if (sizeMb > WHISPER_MAX_FILE_MB) {
    throw new FileTooLargeError(filePath, sizeMb);
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function safeDeleteFile(filePath: string): Promise<void> {
  try {
    await fsp.unlink(filePath);
    console.log(`[transcription] Deleted: ${filePath}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(`[transcription] Could not delete ${filePath}:`, err);
    }
  }
}

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Transcribes a local audio file using Groq Whisper large-v3.
 * Deletes the local file after transcription — both success and error paths.
 * Caller does not need to manage cleanup.
 */
export async function transcribeAudio(
  filePath: string,
): Promise<TranscriptionResult> {
  const absolutePath = path.resolve(filePath);

  validateAudioFile(absolutePath);

  const client = getGroqClient();
  let responseText = "";
  let language: string | null = null;
  let durationSeconds: number | null = null;

  try {
    const response = await client.audio.transcriptions.create({
      file: fs.createReadStream(absolutePath),
      model: WHISPER_MODEL,
      response_format: "verbose_json",
      temperature: 0,
    });

    responseText = response.text?.trim() ?? "";
    language =
      ((response as unknown as Record<string, unknown>).language as string) ??
      null;
    durationSeconds =
      ((response as unknown as Record<string, unknown>).duration as number) ??
      null;
  } catch (err) {
    // Clean up even on API failure — never leave orphaned files
    await safeDeleteFile(absolutePath);
    throw new TranscriptionError(
      `Groq Whisper API failed for ${absolutePath}`,
      err,
      absolutePath,
    );
  }

  // Delete after successful transcription
  await safeDeleteFile(absolutePath);

  return {
    text: responseText,
    language,
    durationSeconds,
    filePath: absolutePath,
    transcribedAt: new Date().toISOString(),
  };
}

/**
 * Convenience wrapper — returns just the transcript text.
 * Used by scrapeReel() pipeline. Throws if transcript is empty.
 */
export async function transcribeAndClean(filePath: string): Promise<string> {
  const result = await transcribeAudio(filePath);

  if (!result.text) {
    throw new TranscriptionError(
      `Whisper returned empty transcript for ${filePath}. ` +
        `Audio may be silent, music-only, or in an unsupported language.`,
      undefined,
      filePath,
    );
  }

  return result.text;
}
