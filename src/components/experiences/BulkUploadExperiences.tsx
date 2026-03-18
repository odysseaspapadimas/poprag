/**
 * BulkUploadExperiences
 *
 * A dialog that lets users drag-and-drop up to 100 PDFs.
 * Each PDF is automatically uploaded as a knowledge source and
 * an experience is created for it — one experience per book.
 *
 * Features:
 * - Greek (and all Unicode) filename support for name/slug generation
 * - Editable preview table before upload begins
 * - 3-concurrent upload pipeline per file (R2 PUT → confirm → index → create experience)
 * - Experience is created as soon as indexing is triggered (doesn't wait for queue completion)
 * - Per-file status tracking with live updates
 * - Retry for failed items
 * - Close-safe: indexing continues server-side after dialog closes
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, BookOpen, CheckCircle, Loader2, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useTRPC } from "@/integrations/trpc/react";
import { MAX_KNOWLEDGE_FILE_SIZE } from "@/lib/ai/constants";
import { generateUnicodeSlug } from "@/lib/slug";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FileStatus =
  | "pending"
  | "uploading" // PUT to R2
  | "confirming" // SHA-256 confirm
  | "indexing" // triggering queue
  | "creating" // creating experience record
  | "done"
  | "failed";

interface FileEntry {
  /** Stable client-side ID */
  id: string;
  file: File;
  /** Editable experience display name */
  name: string;
  /** URL-safe slug (derived from filename, Unicode-aware) */
  slug: string;
  status: FileStatus;
  error?: string;
  sourceId?: string;
}

type Phase = "select" | "uploading" | "done";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a filename to a human-readable experience name.
 * Works with Greek and all Unicode characters via JS native toUpperCase.
 *
 * Examples:
 *   "η-ιλιαδα.pdf"           → "Η Ιλιαδα"
 *   "the-great-gatsby.pdf"   → "The Great Gatsby"
 *   "01_αδελφοί_καραμάζοφ.pdf" → "01 Αδελφοί Καραμάζοφ"
 */
function filenameToName(filename: string): string {
  return filename
    .replace(/\.[^/.]+$/, "") // strip extension
    .replace(/[-_]+/g, " ") // hyphens / underscores → spaces
    .replace(/\s+/g, " ") // normalise consecutive spaces
    .trim()
    .split(" ")
    .map((word) =>
      word.length > 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word,
    )
    .join(" ");
}

function filenameToSlug(filename: string): string {
  return generateUnicodeSlug(filename.replace(/\.[^/.]+$/, ""));
}

const STATUS_LABELS: Record<FileStatus, string> = {
  pending: "Waiting",
  uploading: "Uploading to storage...",
  confirming: "Verifying...",
  indexing: "Queuing for indexing...",
  creating: "Creating experience...",
  done: "Done",
  failed: "Failed",
};

const CONCURRENCY = 3;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface BulkUploadExperiencesProps {
  agentId: string;
  trigger: React.ReactNode;
}

export function BulkUploadExperiences({
  agentId,
  trigger,
}: BulkUploadExperiencesProps) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("select");
  const [entries, setEntries] = useState<FileEntry[]>([]);

  /**
   * Ref used to block dialog closing while uploads are in flight.
   * We use a ref (not state) so the `onInteractOutside` / `onEscapeKeyDown`
   * handlers always see the current value without capturing stale closures.
   */
  const isUploadingRef = useRef(false);

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Mutations — calling mutateAsync concurrently on the same hook is safe;
  // each call produces its own independent network request.
  const uploadStart = useMutation(trpc.knowledge.uploadStart.mutationOptions());
  const uploadConfirm = useMutation(trpc.knowledge.confirm.mutationOptions());
  const uploadIndex = useMutation(trpc.knowledge.index.mutationOptions());
  const markFailed = useMutation(trpc.knowledge.markFailed.mutationOptions());
  const createExperience = useMutation(
    trpc.experience.create.mutationOptions(),
  );

  // ---------------------------------------------------------------------------
  // Derived counts
  // ---------------------------------------------------------------------------
  const total = entries.length;
  const doneCount = entries.filter((e) => e.status === "done").length;
  const failedCount = entries.filter((e) => e.status === "failed").length;
  const activeCount = entries.filter((e) =>
    (
      ["uploading", "confirming", "indexing", "creating"] as FileStatus[]
    ).includes(e.status),
  ).length;

  // ---------------------------------------------------------------------------
  // State helpers
  // ---------------------------------------------------------------------------

  const updateEntry = useCallback((id: string, updates: Partial<FileEntry>) => {
    setEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, ...updates } : e)),
    );
  }, []);

  // ---------------------------------------------------------------------------
  // Per-file upload pipeline
  // ---------------------------------------------------------------------------

  const processFile = useCallback(
    async (entry: FileEntry) => {
      let sourceId: string | undefined;

      try {
        // ── Step 1: Initiate upload ──────────────────────────────────────────
        updateEntry(entry.id, { status: "uploading" });

        const startResult = await uploadStart.mutateAsync({
          agentId,
          fileName: entry.file.name,
          mime: entry.file.type || "application/pdf",
          bytes: entry.file.size,
        });

        sourceId = startResult.sourceId;

        // ── Step 2: PUT file directly to R2 ─────────────────────────────────
        const uploadResp = await fetch(startResult.uploadUrl, {
          method: "PUT",
          body: entry.file,
        });

        if (!uploadResp.ok) {
          const errText = await uploadResp.text().catch(() => "");
          throw new Error(
            `Storage upload failed: ${uploadResp.statusText}${errText ? ` — ${errText}` : ""}`,
          );
        }

        // ── Step 3: SHA-256 checksum + confirm ───────────────────────────────
        updateEntry(entry.id, { status: "confirming" });

        const hashBuffer = await crypto.subtle.digest(
          "SHA-256",
          await entry.file.arrayBuffer(),
        );
        const checksum = Array.from(new Uint8Array(hashBuffer))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");

        await uploadConfirm.mutateAsync({ sourceId, checksum });

        // ── Step 4: Trigger indexing (enqueues to Cloudflare Queue) ──────────
        updateEntry(entry.id, { status: "indexing" });
        await uploadIndex.mutateAsync({ sourceId });

        // ── Step 5: Create the experience ────────────────────────────────────
        // We create the experience immediately after triggering indexing —
        // we don't wait for the queue to finish (that may take minutes).
        // Indexing continues server-side in the background.
        updateEntry(entry.id, { status: "creating" });

        await createExperience.mutateAsync({
          agentId,
          name: entry.name,
          slug: entry.slug,
          knowledgeSourceIds: [sourceId],
        });

        updateEntry(entry.id, { status: "done", sourceId });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        updateEntry(entry.id, { status: "failed", error: message });

        // Best-effort: mark the knowledge source as failed in the DB so the
        // knowledge tab shows the correct status.
        if (sourceId) {
          markFailed.mutateAsync({ sourceId, error: message }).catch(() => {});
        }
      }
    },
    [
      agentId,
      updateEntry,
      uploadStart,
      uploadConfirm,
      uploadIndex,
      createExperience,
      markFailed,
    ],
  );

  // ---------------------------------------------------------------------------
  // Start upload (with bounded concurrency)
  // ---------------------------------------------------------------------------

  const handleStartUpload = useCallback(async () => {
    if (entries.length === 0) return;

    setPhase("uploading");
    isUploadingRef.current = true;

    // Reset any previously-failed entries to "pending" so retries work
    const entriesToProcess = entries.filter(
      (e) => e.status === "pending" || e.status === "failed",
    );

    // Work queue — shift() is safe because only one worker runs shift() at a time
    // within each worker's loop; JS is single-threaded between awaits.
    const queue = [...entriesToProcess];

    const workers = Array.from(
      { length: Math.min(CONCURRENCY, queue.length) },
      async () => {
        while (true) {
          const entry = queue.shift();
          if (!entry) break;
          await processFile(entry);
        }
      },
    );

    await Promise.all(workers);

    isUploadingRef.current = false;
    setPhase("done");

    // Invalidate relevant query caches so the experiences tab refreshes
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.experience.list.queryKey({ agentId }),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.knowledge.list.queryKey({ agentId }),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.agent.getKnowledgeSources.queryKey({ agentId }),
      }),
    ]);
  }, [entries, processFile, queryClient, trpc, agentId]);

  // ---------------------------------------------------------------------------
  // Retry failed entries
  // ---------------------------------------------------------------------------

  const handleRetryFailed = useCallback(async () => {
    // Capture the failed entries NOW (synchronously) before state update
    // so we avoid the stale-closure problem with setEntries + immediate re-run.
    const failedEntries = entries
      .filter((e) => e.status === "failed")
      .map((e) => ({
        ...e,
        status: "pending" as FileStatus,
        error: undefined,
      }));

    if (failedEntries.length === 0) return;

    // Reset their status in the UI
    setEntries((prev) =>
      prev.map((e) =>
        e.status === "failed"
          ? { ...e, status: "pending", error: undefined }
          : e,
      ),
    );

    setPhase("uploading");
    isUploadingRef.current = true;

    const queue = [...failedEntries];
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, queue.length) },
      async () => {
        while (true) {
          const entry = queue.shift();
          if (!entry) break;
          await processFile(entry);
        }
      },
    );

    await Promise.all(workers);

    isUploadingRef.current = false;
    setPhase("done");

    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.experience.list.queryKey({ agentId }),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.knowledge.list.queryKey({ agentId }),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.agent.getKnowledgeSources.queryKey({ agentId }),
      }),
    ]);
  }, [entries, processFile, queryClient, trpc, agentId]);

  // ---------------------------------------------------------------------------
  // Dialog open/close
  // ---------------------------------------------------------------------------

  const handleOpenChange = useCallback((val: boolean) => {
    // Block closing while uploads are actively running
    if (!val && isUploadingRef.current) return;

    if (!val) {
      // Reset state when closing
      setPhase("select");
      setEntries([]);
    }
    setOpen(val);
  }, []);

  // ---------------------------------------------------------------------------
  // Dropzone (phase = "select" only)
  // ---------------------------------------------------------------------------

  const onDrop = useCallback((acceptedFiles: File[]) => {
    setEntries((prev) => {
      const existingFilenames = new Set(prev.map((e) => e.file.name));
      const newFiles = acceptedFiles.filter(
        (f) => !existingFilenames.has(f.name),
      );

      // Slug deduplication: track slugs already used in the current batch
      const usedSlugs = new Set(prev.map((e) => e.slug));

      const newEntries: FileEntry[] = newFiles.map((file) => {
        const baseSlug = filenameToSlug(file.name);
        let slug = baseSlug;
        let counter = 2;
        while (usedSlugs.has(slug)) {
          slug = `${baseSlug}-${counter++}`;
        }
        usedSlugs.add(slug);

        return {
          id: `${Date.now()}-${Math.random()}`,
          file,
          name: filenameToName(file.name),
          slug,
          status: "pending",
        };
      });

      return [...prev, ...newEntries];
    });
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    maxSize: MAX_KNOWLEDGE_FILE_SIZE,
    maxFiles: 100,
    disabled: phase !== "select",
    onDropRejected: (rejections) => {
      const messages = rejections.flatMap((r) =>
        r.errors.map((e) => e.message),
      );
      toast.error(messages[0] ?? "Some files were rejected");
    },
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const dialogTitle =
    phase === "select"
      ? "Bulk Upload Books"
      : phase === "uploading"
        ? `Uploading ${total} book${total !== 1 ? "s" : ""}…`
        : "Upload Complete";

  const dialogDescription =
    phase === "select"
      ? "Drop up to 100 PDFs. Each file becomes a separate knowledge source and experience."
      : phase === "uploading"
        ? `${doneCount + failedCount} of ${total} processed • ${activeCount} active`
        : `${doneCount} succeeded${failedCount > 0 ? `, ${failedCount} failed` : ""}`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>

      <DialogContent
        className="max-w-3xl max-h-[88vh] flex flex-col gap-0"
        // Prevent accidentally closing while uploads are in-flight
        showCloseButton={phase !== "uploading"}
        onInteractOutside={(e) => {
          if (isUploadingRef.current) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (isUploadingRef.current) e.preventDefault();
        }}
      >
        {/* ── Header ── */}
        <DialogHeader className="pb-4">
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>

        {/* ── Body (scrollable) ── */}
        <div className="flex-1 overflow-y-auto min-h-0 space-y-4 pb-4">
          {/* ════════════════════════════════════════════════════════════════
              SELECT PHASE
          ════════════════════════════════════════════════════════════════ */}
          {phase === "select" && (
            <>
              {/* Dropzone */}
              <div
                {...getRootProps()}
                className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                  isDragActive
                    ? "border-primary bg-primary/5"
                    : "border-muted-foreground/25 hover:border-primary/50"
                }`}
              >
                <input {...getInputProps()} />
                <BookOpen className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
                <p className="text-lg font-medium">
                  {isDragActive ? "Drop PDFs here" : "Drop book PDFs here"}
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  or click to select • PDF only • up to 100 files •{" "}
                  {(MAX_KNOWLEDGE_FILE_SIZE / (1024 * 1024)).toFixed(0)}MB each
                </p>
              </div>

              {/* Editable preview table */}
              {entries.length > 0 && (
                <div className="border rounded-lg overflow-hidden">
                  <div className="px-3 py-2 bg-muted/50 flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      {entries.length} file{entries.length !== 1 ? "s" : ""}{" "}
                      selected — edit names if needed
                    </span>
                    <button
                      type="button"
                      onClick={() => setEntries([])}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Clear all
                    </button>
                  </div>
                  <div className="overflow-y-auto max-h-72">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/30 sticky top-0">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground w-2/5">
                            File
                          </th>
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                            Experience Name
                          </th>
                          <th className="w-8 px-2" />
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {entries.map((entry) => (
                          <tr key={entry.id} className="hover:bg-muted/20">
                            <td className="px-3 py-1.5 text-muted-foreground font-mono text-xs truncate max-w-0 w-2/5">
                              <span className="block truncate">
                                {entry.file.name}
                              </span>
                            </td>
                            <td className="px-3 py-1.5">
                              <Input
                                value={entry.name}
                                onChange={(e) =>
                                  setEntries((prev) =>
                                    prev.map((en) =>
                                      en.id === entry.id
                                        ? { ...en, name: e.target.value }
                                        : en,
                                    ),
                                  )
                                }
                                className="h-7 text-sm"
                                placeholder="Experience name"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <button
                                type="button"
                                onClick={() =>
                                  setEntries((prev) =>
                                    prev.filter((e) => e.id !== entry.id),
                                  )
                                }
                                className="text-muted-foreground hover:text-foreground transition-colors"
                                title="Remove"
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ════════════════════════════════════════════════════════════════
              UPLOADING PHASE
          ════════════════════════════════════════════════════════════════ */}
          {phase === "uploading" && (
            <>
              {/* Global progress bar */}
              <div>
                <div className="flex justify-between text-sm mb-1.5">
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Processing books…
                  </span>
                  <span className="text-muted-foreground">
                    {doneCount + failedCount} / {total}
                  </span>
                </div>
                <Progress
                  value={((doneCount + failedCount) / total) * 100}
                  className="h-2"
                />
              </div>

              {/* Per-file status table */}
              <div className="border rounded-lg overflow-hidden">
                <div className="overflow-y-auto max-h-96">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                          Book
                        </th>
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                          Status
                        </th>
                        <th className="w-8 px-3" />
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {entries.map((entry) => (
                        <tr key={entry.id} className="hover:bg-muted/20">
                          <td className="px-3 py-2 font-medium truncate max-w-0 w-1/2">
                            <span className="block truncate">{entry.name}</span>
                          </td>
                          <td className="px-3 py-2 text-muted-foreground text-xs">
                            <span
                              className={
                                entry.status === "done"
                                  ? "text-green-600 dark:text-green-400"
                                  : entry.status === "failed"
                                    ? "text-destructive"
                                    : ""
                              }
                            >
                              {STATUS_LABELS[entry.status]}
                            </span>
                            {entry.error && (
                              <span
                                className="text-destructive ml-1 truncate block max-w-[280px]"
                                title={entry.error}
                              >
                                {entry.error}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {entry.status === "done" && (
                              <CheckCircle className="h-4 w-4 text-green-500 inline" />
                            )}
                            {entry.status === "failed" && (
                              <AlertCircle className="h-4 w-4 text-destructive inline" />
                            )}
                            {(
                              [
                                "uploading",
                                "confirming",
                                "indexing",
                                "creating",
                              ] as FileStatus[]
                            ).includes(entry.status) && (
                              <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent inline-block" />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <p className="text-xs text-muted-foreground text-center">
                Please keep this window open while books are uploading.
              </p>
            </>
          )}

          {/* ════════════════════════════════════════════════════════════════
              DONE PHASE
          ════════════════════════════════════════════════════════════════ */}
          {phase === "done" && (
            <>
              {/* Summary banner */}
              <div
                className={`flex items-start gap-3 p-4 rounded-lg border ${
                  failedCount === 0
                    ? "bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800"
                    : "bg-amber-50 border-amber-200 dark:bg-amber-950 dark:border-amber-800"
                }`}
              >
                {failedCount === 0 ? (
                  <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400 mt-0.5 shrink-0" />
                ) : (
                  <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                )}
                <div>
                  <p className="font-medium text-sm">
                    {doneCount} of {total} book
                    {total !== 1 ? "s" : ""} uploaded successfully
                    {failedCount > 0 && `, ${failedCount} failed`}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Indexing is processing in the background. Large books may
                    take several minutes. Check the Knowledge tab for progress.
                  </p>
                </div>
              </div>

              {/* Failed items list */}
              {failedCount > 0 && (
                <div className="border rounded-lg overflow-hidden">
                  <div className="px-3 py-2 bg-muted/50 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Failed uploads ({failedCount})
                  </div>
                  <div className="divide-y max-h-52 overflow-y-auto">
                    {entries
                      .filter((e) => e.status === "failed")
                      .map((entry) => (
                        <div
                          key={entry.id}
                          className="px-3 py-2.5 flex items-start gap-2"
                        >
                          <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">
                              {entry.name}
                            </p>
                            <p className="text-xs text-muted-foreground truncate">
                              {entry.file.name}
                            </p>
                            {entry.error && (
                              <p className="text-xs text-destructive mt-0.5">
                                {entry.error}
                              </p>
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="flex justify-between items-center pt-4 border-t">
          {phase === "select" && (
            <>
              <p className="text-sm text-muted-foreground">
                {entries.length > 0
                  ? `${entries.length} book${entries.length !== 1 ? "s" : ""} ready to upload`
                  : "No files selected yet"}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleStartUpload}
                  disabled={entries.length === 0}
                >
                  Upload{entries.length > 0 ? ` ${entries.length}` : ""} Book
                  {entries.length !== 1 ? "s" : ""}
                </Button>
              </div>
            </>
          )}

          {phase === "uploading" && (
            <p className="text-sm text-muted-foreground w-full text-center">
              Processing {total} book{total !== 1 ? "s" : ""} — please wait…
            </p>
          )}

          {phase === "done" && (
            <div className="flex justify-end gap-2 w-full">
              {failedCount > 0 && (
                <Button variant="outline" onClick={handleRetryFailed}>
                  Retry {failedCount} Failed
                </Button>
              )}
              <Button onClick={() => handleOpenChange(false)}>Close</Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
