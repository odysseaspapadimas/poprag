import { useTRPC } from "@/integrations/trpc/react";
import {
  firebaseTimestampToDate,
  formatFirebaseTimestamp,
} from "@/lib/firebase/types";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  MessageSquare,
  User,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "./ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Separator } from "./ui/separator";

interface UserDetailsModalProps {
  uid: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function UserDetailsModal({
  uid,
  open,
  onOpenChange,
}: UserDetailsModalProps) {
  const trpc = useTRPC();
  const [expandedExperiences, setExpandedExperiences] = useState<Set<string>>(
    new Set(),
  );
  const [expandedChats, setExpandedChats] = useState<Set<string>>(new Set());
  const [selectedImage, setSelectedImage] = useState<string | null>(null);

  const {
    data: user,
    isLoading,
    error,
  } = useQuery(
    trpc.user.getById.queryOptions({
      uid,
      includeExperiences: true,
      includeChats: true,
      includeMessages: true,
    }),
  );

  // Sort experiences by lastUsed (most recent first)
  const sortedExperiences = user?.experiences?.slice().sort((a, b) => {
    const dateA = firebaseTimestampToDate(a.lastUsed).getTime();
    const dateB = firebaseTimestampToDate(b.lastUsed).getTime();
    return dateB - dateA;
  });

  const toggleExperience = (experienceId: string) => {
    setExpandedExperiences((prev) => {
      const next = new Set(prev);
      if (next.has(experienceId)) {
        next.delete(experienceId);
      } else {
        next.add(experienceId);
      }
      return next;
    });
  };

  const toggleChat = (chatId: string) => {
    setExpandedChats((prev) => {
      const next = new Set(prev);
      if (next.has(chatId)) {
        next.delete(chatId);
      } else {
        next.add(chatId);
      }
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl w-full max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            {user?.photo_url && (
              <img
                src={user.photo_url}
                alt={user.display_name}
                className="w-10 h-10 rounded-full"
              />
            )}
            <div>
              <div>{user?.display_name || "Loading..."}</div>
              <div className="text-sm font-normal text-muted-foreground">
                {user?.email || ""}
              </div>
            </div>
          </DialogTitle>
          <DialogDescription>
            User details and nested collections
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="text-center py-8 text-destructive">
            Error loading user data: {error.message}
          </div>
        )}

        {user && (
          <div className="h-[calc(90vh-8rem)] overflow-y-auto pr-4">
            <div className="space-y-6">
              {/* User Details Section */}
              <section>
                <h3 className="font-semibold text-lg mb-3 flex items-center gap-2">
                  <User className="h-5 w-5" />
                  User Details
                </h3>
                <div className="grid grid-cols-2 gap-4 p-4 bg-muted/30 rounded-lg">
                  <DetailField label="UID" value={user.uid} />
                  <DetailField label="Email" value={user.email} />
                  <DetailField label="Display Name" value={user.display_name} />
                  <DetailField
                    label="API Calls"
                    value={`${user.ApiCalls} / ${user.ApiCallsLimit}`}
                  />
                  <DetailField
                    label="Preference"
                    value={
                      user.responsePreference.charAt(0).toUpperCase() +
                      user.responsePreference.slice(1)
                    }
                  />
                  <DetailField
                    label="Logged In"
                    value={user.Logged_id ? "Yes" : "No"}
                  />
                  <DetailField
                    label="Created"
                    value={formatFirebaseTimestamp(user.created_time)}
                  />
                  <DetailField
                    label="Image Recognition"
                    value={
                      user.isFirstTimeImageRecognition ? "First Time" : "Used"
                    }
                  />
                </div>
              </section>

              <Separator />

              {/* Experiences Section */}
              {sortedExperiences && sortedExperiences.length > 0 && (
                <section>
                  <h3 className="font-semibold text-lg mb-3">
                    Experiences ({sortedExperiences.length})
                  </h3>
                  <div className="space-y-2">
                    {sortedExperiences.map((experience) => (
                      <div
                        key={experience.id}
                        className="border rounded-lg overflow-hidden"
                      >
                        <button
                          type="button"
                          onClick={() => toggleExperience(experience.id)}
                          className="w-full flex items-center justify-between p-4 hover:bg-muted/50 transition-colors"
                        >
                          <div className="flex items-center gap-2">
                            {expandedExperiences.has(experience.id) ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                            <span className="font-medium">{experience.id}</span>
                            {experience.chats && (
                              <Badge variant="secondary">
                                {experience.chats.length} chats
                              </Badge>
                            )}
                          </div>
                          <span className="text-sm text-muted-foreground">
                            Last used:{" "}
                            {formatFirebaseTimestamp(experience.lastUsed)}
                          </span>
                        </button>

                        {expandedExperiences.has(experience.id) &&
                          experience.chats &&
                          experience.chats.length > 0 && (
                            <div className="pl-6 pr-4 pb-4 space-y-2">
                              {experience.chats
                                .slice()
                                .sort((a, b) => {
                                  const dateA = firebaseTimestampToDate(
                                    a.createdAt,
                                  ).getTime();
                                  const dateB = firebaseTimestampToDate(
                                    b.createdAt,
                                  ).getTime();
                                  return dateB - dateA;
                                })
                                .map((chat) => (
                                  <div
                                    key={chat.id}
                                    className="border rounded-md overflow-hidden bg-muted/20"
                                  >
                                    <button
                                      type="button"
                                      onClick={() => toggleChat(chat.id)}
                                      className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
                                    >
                                      <div className="flex items-center gap-2">
                                        {expandedChats.has(chat.id) ? (
                                          <ChevronDown className="h-4 w-4" />
                                        ) : (
                                          <ChevronRight className="h-4 w-4" />
                                        )}
                                        <MessageSquare className="h-4 w-4 text-muted-foreground" />
                                        <span className="font-medium text-sm">
                                          {chat.title}
                                        </span>
                                        {chat.messages && (
                                          <Badge
                                            variant="outline"
                                            className="text-xs"
                                          >
                                            {chat.messages.length} messages
                                          </Badge>
                                        )}
                                      </div>
                                      <span className="text-xs text-muted-foreground">
                                        {formatFirebaseTimestamp(
                                          chat.createdAt,
                                        )}
                                      </span>
                                    </button>

                                    {expandedChats.has(chat.id) &&
                                      chat.messages &&
                                      chat.messages.length > 0 && (
                                        <div className="pl-6 pr-3 pb-3 space-y-2 max-h-96 overflow-y-auto">
                                          {chat.messages
                                            .slice()
                                            .sort((a, b) => {
                                              const dateA =
                                                firebaseTimestampToDate(
                                                  a.timestamp,
                                                ).getTime();
                                              const dateB =
                                                firebaseTimestampToDate(
                                                  b.timestamp,
                                                ).getTime();
                                              return dateA - dateB;
                                            })
                                            .map((message) => {
                                              console.log("Rendering message:", message);
                                              return <div
                                                key={message.id}
                                                className={`p-3 rounded-md text-sm ${message.role === "user"
                                                  ? "bg-primary/10 border-l-2 border-primary"
                                                  : "bg-muted/50 border-l-2 border-muted-foreground"
                                                  }`}
                                              >
                                                <div className="flex items-center justify-between mb-1">
                                                  <Badge
                                                    variant={
                                                      message.role === "user"
                                                        ? "default"
                                                        : "secondary"
                                                    }
                                                    className="text-xs"
                                                  >
                                                    {message.role}
                                                  </Badge>
                                                  <span className="text-xs text-muted-foreground">
                                                    {formatFirebaseTimestamp(
                                                      message.timestamp,
                                                      {
                                                        hour: "2-digit",
                                                        minute: "2-digit",
                                                        month: "short",
                                                        day: "numeric",
                                                      },
                                                    )}
                                                  </span>
                                                </div>
                                                <p className="whitespace-pre-wrap break-words">
                                                  {message.content}
                                                </p>
                                                {message.imageUrl && (
                                                  <img
                                                    src={message.imageUrl}
                                                    alt="Message attachment"
                                                    className="mt-2 rounded max-w-xs max-h-48 object-contain cursor-pointer hover:opacity-80 transition-opacity"
                                                    onClick={() =>
                                                      message.imageUrl &&
                                                      setSelectedImage(
                                                        message.imageUrl,
                                                      )
                                                    }
                                                  />
                                                )}
                                              </div>
                                            })}
                                        </div>
                                      )}
                                  </div>
                                ))}
                            </div>
                          )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {sortedExperiences && sortedExperiences.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  No experiences found for this user
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>

      {/* Image Modal */}
      <Dialog
        open={!!selectedImage}
        onOpenChange={(open) => !open && setSelectedImage(null)}
      >
        <DialogContent className="max-w-4xl max-h-[90vh] flex items-center justify-center bg-black/80">
          {selectedImage && (
            <img
              src={selectedImage}
              alt="Full size"
              className="max-w-full max-h-[80vh] object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="text-sm font-medium">{value}</div>
    </div>
  );
}
