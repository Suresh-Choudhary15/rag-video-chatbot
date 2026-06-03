import { useState } from "react";
import VideoCard from "./components/VideoCard";
import type { VideoInfo, AppStatus } from "./types";
import ChatInterface from "./components/ChatInterface";

export default function App() {
  const [urlA, setUrlA] = useState("");
  const [urlB, setUrlB] = useState("");
  const [videoA, setVideoA] = useState<VideoInfo | null>(null);
  const [videoB, setVideoB] = useState<VideoInfo | null>(null);
  const [status, setStatus] = useState<AppStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("");

  const isLoading = status === "scraping" || status === "ingesting";
  const hasVideos = videoA !== null && videoB !== null;

  function handleStatusEvent(data: Record<string, unknown>) {
    if (data.status === "scraping") {
      setStatus("scraping");
      setStatusMessage("Scraping videos...");
    } else if (data.status === "ingesting") {
      setStatus("ingesting");
      setStatusMessage("Building vector store...");
    } else if (data.status === "thinking") {
      setStatus("thinking");
      setStatusMessage("Generating answer...");
    }
  }

  async function handleSubmit() {
    if (!urlA.trim() || !urlB.trim()) return;
    setStatus("scraping");
    setStatusMessage("Scraping videos...");
    setVideoA(null);
    setVideoB(null);

    try {
      const response = await fetch("http://localhost:3001/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "Give me a brief overview of both videos.",
          urlA: urlA.trim(),
          urlB: urlB.trim(),
        }),
      });

      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6));
            handleStatusEvent(data);
            if (data.done) {
              if (data.videoA) setVideoA(data.videoA);
              if (data.videoB) setVideoB(data.videoB);
              setStatus("ready");
              setStatusMessage("");
            }
          } catch {
            // ignore malformed lines
          }
        }
      }
    } catch (err) {
      setStatus("error");
      setStatusMessage(
        err instanceof Error ? err.message : "Something went wrong",
      );
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-xl font-bold text-gray-900">
            Video Comparison RAG
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Compare two social media videos with AI
          </p>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        {/* URL inputs */}
        <div className="bg-white rounded-2xl border border-gray-200 p-5 shadow-sm mb-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">
            Enter video URLs
          </h2>
          <div className="flex flex-col gap-3">
            <div className="flex gap-2">
              <span className="flex items-center justify-center w-8 h-10 rounded-lg bg-indigo-100 text-indigo-700 font-bold text-sm flex-shrink-0">
                A
              </span>
              <input
                type="url"
                placeholder="YouTube or Instagram URL"
                value={urlA}
                onChange={(e) => setUrlA(e.target.value)}
                className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300"
                disabled={isLoading}
              />
            </div>
            <div className="flex gap-2">
              <span className="flex items-center justify-center w-8 h-10 rounded-lg bg-purple-100 text-purple-700 font-bold text-sm flex-shrink-0">
                B
              </span>
              <input
                type="url"
                placeholder="YouTube or Instagram URL"
                value={urlB}
                onChange={(e) => setUrlB(e.target.value)}
                className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300"
                disabled={isLoading}
              />
            </div>
          </div>

          <button
            onClick={handleSubmit}
            disabled={isLoading || !urlA.trim() || !urlB.trim()}
            className="mt-4 w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
          >
            {isLoading ? statusMessage : "Load & Compare Videos"}
          </button>

          {/* Status indicator */}
          {isLoading && (
            <div className="mt-3 flex items-center gap-2 text-xs text-gray-500">
              <div className="w-3 h-3 rounded-full bg-indigo-400 animate-pulse" />
              {statusMessage} — this may take 30–60 seconds on first load
            </div>
          )}

          {status === "error" && (
            <p className="mt-3 text-xs text-red-600">{statusMessage}</p>
          )}
        </div>

        {/* Video cards */}
        <div className="flex gap-4">
          <VideoCard label="A" video={videoA} isLoading={isLoading} />
          <VideoCard label="B" video={videoB} isLoading={isLoading} />
        </div>

        {/* Chat interface - shows after videos are loaded */}
        {hasVideos && status === "ready" && (
          <div className="mt-6">
            <ChatInterface urlA={urlA} urlB={urlB} />
          </div>
        )}
      </main>
    </div>
  );
}
