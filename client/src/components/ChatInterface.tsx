import { useState, useRef, useEffect } from "react";
import type { ChatMessage, RAGSource } from "../types";

interface ChatInterfaceProps {
  urlA: string;
  urlB: string;
}

function SourceBadge({ source }: { source: RAGSource }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600 border border-gray-200">
      <span
        className={`font-semibold ${source.videoLabel === "A" ? "text-indigo-600" : "text-purple-600"}`}
      >
        Video {source.videoLabel}
      </span>
      <span className="text-gray-400">·</span>
      <span className="truncate max-w-32">
        {source.excerpt.slice(0, 40)}...
      </span>
    </span>
  );
}

interface MessageBubbleProps {
  message: ChatMessage;
  sources?: RAGSource[];
  isStreaming?: boolean;
}

function MessageBubble({ message, sources, isStreaming }: MessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-4`}>
      <div className={`max-w-[85%] ${isUser ? "order-2" : "order-1"}`}>
        {/* Role label */}
        <p
          className={`text-xs font-medium mb-1 ${isUser ? "text-right text-gray-400" : "text-gray-400"}`}
        >
          {isUser ? "You" : "AI Analyst"}
        </p>

        {/* Bubble */}
        <div
          className={`px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
            isUser
              ? "bg-indigo-600 text-white rounded-tr-sm"
              : "bg-white border border-gray-200 text-gray-800 rounded-tl-sm shadow-sm"
          }`}
        >
          {message.content}
          {/* Blinking cursor while streaming */}
          {isStreaming && (
            <span className="inline-block w-0.5 h-4 bg-gray-400 ml-0.5 animate-pulse" />
          )}
        </div>

        {/* Sources */}
        {!isUser && sources && sources.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {sources.map((s, i) => (
              <SourceBadge key={i} source={s} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ChatInterface({ urlA, urlB }: ChatInterfaceProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sourcesMap, setSourcesMap] = useState<Record<number, RAGSource[]>>({});
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom on new content
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage() {
    const query = input.trim();
    if (!query || isStreaming) return;

    setInput("");
    setError(null);

    // Add user message immediately
    const userMessage: ChatMessage = { role: "user", content: query };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);

    // Add empty assistant message — we'll fill it as tokens arrive
    const assistantIndex = updatedMessages.length;
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    setIsStreaming(true);
    let accumulated = "";

    try {
      const response = await fetch("http://localhost:3001/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          // Cap at last 10 messages — matches server-side cap
          history: messages.slice(-10),
          // Only send URLs on first message — server caches after that
          ...(messages.length === 0 ? { urlA, urlB } : {}),
        }),
      });

      if (!response.body) throw new Error("No response body");
      if (!response.ok) throw new Error(`Server error: ${response.status}`);

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

            // Skip status events in chat — they're for the ingest phase
            if (data.status) continue;

            // Token — append to current assistant message
            if (data.token !== undefined && data.token !== "") {
              accumulated += data.token;
              const currentAccumulated = accumulated;
              setMessages((prev) => {
                const updated = [...prev];
                updated[assistantIndex] = {
                  role: "assistant",
                  content: currentAccumulated,
                };
                return updated;
              });
            }

            // Done event — save sources
            if (data.done) {
              if (data.sources) {
                setSourcesMap((prev) => ({
                  ...prev,
                  [assistantIndex]: data.sources,
                }));
              }
              if (data.error) {
                setError(data.error);
              }
            }
          } catch {
            // ignore malformed lines
          }
        }
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Something went wrong";
      setError(message);
      // Remove the empty assistant message on error
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setIsStreaming(false);
      // Re-focus input after streaming completes
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm flex flex-col h-[500px]">
      {/* Chat header */}
      <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">AI Analyst Chat</h2>
        {messages.length > 0 && (
          <span className="text-xs text-gray-400">
            {messages.length} messages
          </span>
        )}
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-gray-400">
            <div className="text-3xl mb-3">💬</div>
            <p className="text-sm font-medium">Ask anything about the videos</p>
            <div className="mt-3 flex flex-col gap-1.5">
              {[
                "Compare the engagement rates",
                "Which video has a better hook?",
                "What growth strategies are mentioned?",
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => {
                    setInput(suggestion);
                    inputRef.current?.focus();
                  }}
                  className="text-xs px-3 py-1.5 rounded-full border border-gray-200 hover:bg-gray-50 text-gray-500 transition-colors"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg, i) => (
              <MessageBubble
                key={i}
                message={msg}
                sources={sourcesMap[i]}
                isStreaming={
                  isStreaming &&
                  i === messages.length - 1 &&
                  msg.role === "assistant"
                }
              />
            ))}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Error */}
      {error && (
        <div className="px-5 py-2 bg-red-50 border-t border-red-100">
          <p className="text-xs text-red-600">{error}</p>
        </div>
      )}

      {/* Input */}
      <div className="px-5 py-3 border-t border-gray-100 flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isStreaming ? "Waiting for response..." : "Ask about the videos..."
          }
          disabled={isStreaming}
          className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300 disabled:bg-gray-50 disabled:text-gray-400"
        />
        <button
          onClick={sendMessage}
          disabled={isStreaming || !input.trim()}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-200 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors flex-shrink-0"
        >
          {isStreaming ? "..." : "Send"}
        </button>
      </div>
    </div>
  );
}
