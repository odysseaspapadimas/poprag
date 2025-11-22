import { Textarea } from "@/components/ui/textarea";
import { useTRPC } from "@/integrations/trpc/react";
import { useChat } from "@ai-sdk/react";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { DefaultChatTransport } from "ai";
import { ImageIcon, Send, X } from "lucide-react";
import { nanoid } from "nanoid";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

interface ChatProps {
  agentId: string;
  onMessageComplete?: () => void;
}

interface AttachedImage {
  id: string;
  url: string;
  fileName: string;
  mime: string;
  bytes: number;
}

function InitialLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 flex items-center justify-center px-4">
      <div className="text-center max-w-3xl mx-auto w-full">
        <h1 className="text-6xl font-bold mb-4 bg-linear-to-r from-primary to-accent text-transparent bg-clip-text uppercase">
          Chat
        </h1>
        <p className="text-muted-foreground mb-6 w-2/3 mx-auto text-lg">
          Ask me anything about your knowledge base.
        </p>
        {children}
      </div>
    </div>
  );
}

function ChattingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-t border-primary/10">
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
    <div
      ref={messagesContainerRef}
      className="flex-1 overflow-y-auto pb-4 min-h-0"
    >
      <div className="max-w-3xl mx-auto w-full px-4">
        {messages.map(({ id, role, parts }) => (
          <div
            key={id}
            className={`p-4 ${
              role === "assistant"
                ? "bg-linear-to-r from-primary/5 to-accent/5"
                : "bg-transparent"
            }`}
          >
            <div className="flex items-start gap-4 max-w-3xl mx-auto w-full">
              {role === "assistant" ? (
                <div className="w-8 h-8 rounded-lg bg-linear-to-r from-primary to-accent mt-2 flex items-center justify-center text-sm font-medium text-white shrink-0">
                  AI
                </div>
              ) : (
                <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center text-sm font-medium text-white shrink-0">
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
                  if ((part as any).type === "image") {
                    const image = (part as any).image;
                    return (
                      <div key={index} className="mb-4">
                        <img
                          src={image.url}
                          alt={image.alt || image.fileName || "Uploaded image"}
                          className="max-w-full h-auto rounded-lg border border-border"
                          style={{ maxHeight: "400px" }}
                        />
                        {image.fileName && (
                          <div className="text-xs text-muted-foreground mt-1">
                            {image.fileName}
                          </div>
                        )}
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
                          <div className="text-xs text-muted-foreground mb-1">
                            Tool Call: getInformation {state && `(${state})`}
                          </div>
                          <div className="text-sm">
                            <strong>Question:</strong> {input?.question}
                          </div>
                        </div>
                        {output && (
                          <div className="bg-muted/30 rounded-lg p-3">
                            <div className="text-xs text-muted-foreground mb-1">
                              Tool Response
                            </div>
                            {output.matches && output.matches.length > 0 ? (
                              <div className="space-y-2">
                                {output.matches.map(
                                  (match: any, matchIndex: number) => (
                                    <div key={matchIndex} className="text-sm">
                                      <div className="font-medium text-xs text-muted-foreground">
                                        Match {matchIndex + 1} (Score:{" "}
                                        {match.score?.toFixed(3)})
                                      </div>
                                      <div className="mt-1">
                                        {match.content}
                                      </div>
                                    </div>
                                  ),
                                )}
                              </div>
                            ) : (
                              <div className="text-sm text-muted-foreground">
                                No matches found
                              </div>
                            )}
                          </div>
                        )}
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

export function Chat({ agentId, onMessageComplete }: ChatProps) {
  const trpc = useTRPC();
  const { data: agent } = useSuspenseQuery(
    trpc.agent.get.queryOptions({ id: agentId }),
  );

  const { data: setupStatus } = useSuspenseQuery(
    trpc.agent.getSetupStatus.queryOptions({ agentId }),
  );

  const isFullySetUp =
    setupStatus?.hasModelAlias &&
    setupStatus?.hasProdPrompt &&
    setupStatus?.isActive;

  // Mutations for image upload
  const uploadImageStart = useMutation(
    trpc.chat.uploadImageStart.mutationOptions(),
  );
  const confirmImageUpload = useMutation(
    trpc.chat.confirmImageUpload.mutationOptions(),
  );

  const { messages, sendMessage } = useChat({
    transport: new DefaultChatTransport({
      api: `/api/chat/${agent?.slug}`,
      body: {
        // Always enable RAG for better results
        rag: {
          topK: 6,
        },
      },
    }),
    onFinish: () => {
      onMessageComplete?.();
    },
  });
  const [input, setInput] = useState("");
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImageUpload = async (file: File) => {
    try {
      // Generate a conversation ID if we don't have messages yet
      const conversationId = messages.length > 0 ? "default" : nanoid();

      const uploadResult = await uploadImageStart.mutateAsync({
        agentId,
        conversationId,
        fileName: file.name,
        mime: file.type,
        bytes: file.size,
      });

      // Upload the file to R2
      const response = await fetch(uploadResult.uploadUrl, {
        method: "PUT",
        body: file,
        headers: {
          "Content-Type": file.type,
        },
      });

      if (!response.ok) {
        throw new Error("Failed to upload image");
      }

      // Confirm upload
      await confirmImageUpload.mutateAsync({
        imageId: uploadResult.imageId,
      });

      // Add to attached images
      const newImage: AttachedImage = {
        id: uploadResult.imageId,
        url: uploadResult.downloadUrl,
        fileName: file.name,
        mime: file.type,
        bytes: file.size,
      };

      setAttachedImages((prev) => [...prev, newImage]);
    } catch (error) {
      console.error("Image upload failed:", error);
      // TODO: Show error toast
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleImageUpload(file);
    }
    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const removeImage = (imageId: string) => {
    setAttachedImages((prev) => prev.filter((img) => img.id !== imageId));
  };

  if (!agent) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold">Agent not found</h1>
        <p className="text-muted-foreground mt-2">
          The agent could not be found. Please check the agent id or contact
          your workspace admin.
        </p>
      </div>
    );
  }

  const Layout = messages.length ? ChattingLayout : InitialLayout;

  return (
    <div className="relative flex flex-col h-full">
      <div className="flex-1 flex flex-col min-h-0">
        <Messages messages={messages} />

        <Layout>
          {isFullySetUp ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const parts: any[] = [];

                // Add attached images
                attachedImages.forEach((img) => {
                  parts.push({
                    type: "image",
                    image: {
                      id: img.id,
                      url: img.url,
                      fileName: img.fileName,
                      mime: img.mime,
                      bytes: img.bytes,
                    },
                  });
                });

                // Add text if present
                if (input.trim()) {
                  parts.push({ type: "text", text: input });
                }

                if (parts.length > 0) {
                  sendMessage({ parts });
                  setInput("");
                  setAttachedImages([]);
                }
              }}
            >
              {/* Display attached images */}
              {attachedImages.length > 0 && (
                <div className="mb-4 flex flex-wrap gap-2">
                  {attachedImages.map((img) => (
                    <div key={img.id} className="relative">
                      <img
                        src={img.url}
                        alt={img.fileName}
                        className="w-16 h-16 object-cover rounded border"
                      />
                      <button
                        type="button"
                        onClick={() => removeImage(img.id)}
                        className="absolute -top-2 -right-2 bg-destructive text-destructive-foreground rounded-full w-5 h-5 flex items-center justify-center text-xs"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="relative max-w-xl mx-auto">
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Type something..."
                  className="pl-12 pr-20 py-3 resize-none overflow-hidden shadow-lg min-h-[44px] max-h-[200px]"
                  onInput={(e) => {
                    const target = e.target as HTMLTextAreaElement;
                    target.style.height = "auto";
                    target.style.height = `${Math.min(target.scrollHeight, 200)}px`;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      const parts: any[] = [];

                      // Add attached images
                      attachedImages.forEach((img) => {
                        parts.push({
                          type: "image",
                          image: {
                            id: img.id,
                            url: img.url,
                            fileName: img.fileName,
                            mime: img.mime,
                            bytes: img.bytes,
                          },
                        });
                      });

                      // Add text if present
                      if (input.trim()) {
                        parts.push({ type: "text", text: input });
                      }

                      if (parts.length > 0) {
                        sendMessage({ parts });
                        setInput("");
                        setAttachedImages([]);
                      }
                    }
                  }}
                />

                {/* Image upload button */}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="absolute inset-y-0 left-2 flex items-center p-2 text-muted-foreground hover:text-primary transition-colors"
                  disabled={uploadImageStart.isPending}
                >
                  <ImageIcon className="w-4 h-4" />
                </button>

                <button
                  type="submit"
                  disabled={!input.trim() && attachedImages.length === 0}
                  className="absolute inset-y-0 right-2 flex items-center p-2 text-primary hover:text-primary/80 disabled:text-muted-foreground transition-colors focus:outline-none"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>

              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileSelect}
                className="hidden"
              />
            </form>
          ) : (
            <div className="text-center">
              <p className="text-muted-foreground mb-4">
                This agent is not fully configured yet. Please complete the
                setup to start chatting.
              </p>
              <div className="text-sm text-muted-foreground">
                {!setupStatus?.isActive && <div>Agent must be active</div>}
                {!setupStatus?.hasModelAlias && <div>Model alias required</div>}
                {!setupStatus?.hasProdPrompt && (
                  <div>Production prompt required</div>
                )}
              </div>
            </div>
          )}
        </Layout>
      </div>
    </div>
  );
}
