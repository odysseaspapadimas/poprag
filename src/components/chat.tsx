import { useTRPC } from "@/integrations/trpc/react";
import { useChat } from "@ai-sdk/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { DefaultChatTransport } from "ai";
import { Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

interface ChatProps {
  agentId: string;
}

function InitialLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 flex items-center justify-center px-4">
      <div className="text-center max-w-3xl mx-auto w-full">
        <h1 className="text-6xl font-bold mb-4 bg-linear-to-r from-orange-500 to-red-600 text-transparent bg-clip-text uppercase">
          Chat
        </h1>
        <p className="text-gray-400 mb-6 w-2/3 mx-auto text-lg">
          Ask me anything about your knowledge base.
        </p>
        {children}
      </div>
    </div>
  );
}

function ChattingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-t border-orange-500/10">
      <div className="max-w-3xl mx-auto w-full px-4 py-3">{children}</div>
    </div>
  );
}

function Messages({ messages }: { messages: Array<UIMessage> }) {
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop =
        messagesContainerRef.current.scrollHeight;
    }
  }, [messages]);

  if (!messages.length) {
    return null;
  }

  return (
    <div ref={messagesContainerRef} className="flex-1 overflow-y-auto pb-4 min-h-0">
      <div className="max-w-3xl mx-auto w-full px-4">
        {messages.map(({ id, role, parts }) => (
          <div
            key={id}
            className={`p-4 ${
              role === "assistant"
                ? "bg-linear-to-r from-orange-500/5 to-red-600/5"
                : "bg-transparent"
            }`}
          >
            <div className="flex items-start gap-4 max-w-3xl mx-auto w-full">
              {role === "assistant" ? (
                <div className="w-8 h-8 rounded-lg bg-linear-to-r from-orange-500 to-red-600 mt-2 flex items-center justify-center text-sm font-medium text-white shrink-0">
                  AI
                </div>
              ) : (
                <div className="w-8 h-8 rounded-lg bg-gray-700 flex items-center justify-center text-sm font-medium text-white shrink-0">
                  Y
                </div>
              )}
              <div className="flex-1">
                {parts.map((part, index) => {
                  if (part.type === "text") {
                    return (
                      <div
                        className="flex-1 min-w-0 prose dark:prose-invert max-w-none prose-sm"
                        key={index}
                      >
                        <ReactMarkdown
                          rehypePlugins={[
                            rehypeRaw,
                            rehypeSanitize,
                            rehypeHighlight,
                            remarkGfm,
                          ]}
                        >
                          {part.text}
                        </ReactMarkdown>
                      </div>
                    );
                  }
                  if (part.type === "tool-getInformation") {
                    const input = part.input as { question?: string };
                    const output = part.output as { matches?: any[] };
                    const state = (part as any).state;
                    return (
                      <div key={index} className="mb-4">
                        <div className="bg-muted/50 rounded-lg p-3 mb-2">
                          <div className="text-xs text-muted-foreground mb-1">Tool Call: getInformation {state && `(${state})`}</div>
                          <div className="text-sm">
                            <strong>Question:</strong> {input?.question}
                          </div>
                        </div>
                        {output && (
                          <div className="bg-muted/30 rounded-lg p-3">
                            <div className="text-xs text-muted-foreground mb-1">Tool Response</div>
                            {output.matches && output.matches.length > 0 ? (
                              <div className="space-y-2">
                                {output.matches.map((match: any, matchIndex: number) => (
                                  <div key={matchIndex} className="text-sm">
                                    <div className="font-medium text-xs text-muted-foreground">
                                      Match {matchIndex + 1} (Score: {match.score?.toFixed(3)})
                                    </div>
                                    <div className="mt-1">{match.content}</div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="text-sm text-muted-foreground">No matches found</div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  }
                  if (part.type === "step-start") {
                    return (
                      <div key={index} className="text-xs text-muted-foreground mb-2">
                        Starting tool execution...
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Chat({ agentId }: ChatProps) {
  const trpc = useTRPC();
  const { data: agent } = useSuspenseQuery(
    trpc.agent.get.queryOptions({ id: agentId })
  );

  if (!agent) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold">Agent not found</h1>
        <p className="text-muted-foreground mt-2">The agent could not be found. Please check the agent id or contact your workspace admin.</p>
      </div>
    );
  }

  const { messages, sendMessage } = useChat({
    transport: new DefaultChatTransport({
      api: `/api/chat/${agent.slug}`,
      body: {
        // Always enable RAG for better results
        rag: {
          topK: 6,
        },
      },
    }),
  });
  const [input, setInput] = useState("");

  const Layout = messages.length ? ChattingLayout : InitialLayout;

  return (
    <div className="relative flex flex-col h-full">
      <div className="flex-1 flex flex-col min-h-0">
        <Messages messages={messages} />

        <Layout>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage({ text: input });
              setInput("");
            }}
          >
            <div className="relative max-w-xl mx-auto">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type something..."
                className="w-full rounded-lg border border-orange-500/20 bg-gray-800/50 pl-4 pr-12 py-3 text-sm text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-500/50 focus:border-transparent resize-none overflow-hidden shadow-lg"
                rows={1}
                style={{ minHeight: "44px", maxHeight: "200px" }}
                onInput={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  target.style.height = "auto";
                  target.style.height =
                    Math.min(target.scrollHeight, 200) + "px";
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage({ text: input });
                    setInput("");
                  }
                }}
              />
              <button
                type="submit"
                disabled={!input.trim()}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-orange-500 hover:text-orange-400 disabled:text-gray-500 transition-colors focus:outline-none"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </form>
        </Layout>
      </div>
    </div>
  );
}
