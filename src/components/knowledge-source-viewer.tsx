import { useQuery } from "@tanstack/react-query";
import {
  Download,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTRPC } from "@/integrations/trpc/react";

interface KnowledgeSourceViewerProps {
  sourceId: string;
  fileName: string;
  mime: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type FileTypeCategory =
  | "image"
  | "pdf"
  | "document"
  | "spreadsheet"
  | "text"
  | "other";

/**
 * Determines the file type category based on MIME type and file extension.
 */
function getFileTypeCategory(
  mime: string | null,
  fileName: string,
): FileTypeCategory {
  const normalizedMime = mime?.split(";")[0]?.trim().toLowerCase() ?? null;
  const normalizedName = fileName.toLowerCase();

  // Images
  if (normalizedMime?.startsWith("image/")) {
    return "image";
  }

  // PDF
  if (normalizedMime === "application/pdf") {
    return "pdf";
  }

  // Word documents
  if (
    normalizedMime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    normalizedMime === "application/msword" ||
    normalizedMime === "application/vnd.oasis.opendocument.text"
  ) {
    return "document";
  }

  // Excel/Spreadsheet files
  if (
    normalizedMime ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    normalizedMime === "application/vnd.ms-excel.sheet.macroenabled.12" ||
    normalizedMime ===
      "application/vnd.ms-excel.sheet.binary.macroenabled.12" ||
    normalizedMime === "application/vnd.ms-excel" ||
    normalizedMime === "application/vnd.oasis.opendocument.spreadsheet" ||
    normalizedMime === "application/vnd.apple.numbers" ||
    normalizedMime === "text/csv" ||
    normalizedName.endsWith(".csv")
  ) {
    return "spreadsheet";
  }

  if (
    normalizedMime?.startsWith("text/") ||
    normalizedMime === "application/json" ||
    normalizedMime === "application/jsonl" ||
    normalizedMime === "application/ndjson" ||
    normalizedMime === "application/x-ndjson" ||
    normalizedName.endsWith(".jsonl") ||
    normalizedName.endsWith(".ndjson") ||
    normalizedName.endsWith(".txt") ||
    normalizedName.endsWith(".md")
  ) {
    return "text";
  }

  return "other";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function KnowledgeSourceViewer({
  sourceId,
  fileName,
  mime,
  open,
  onOpenChange,
}: KnowledgeSourceViewerProps) {
  const trpc = useTRPC();

  // Fetch download URL when modal opens
  const { data, isLoading } = useQuery({
    ...trpc.knowledge.getDownloadUrl.queryOptions({ sourceId }),
    enabled: open,
  });

  const downloadUrl = data?.downloadUrl || null;
  const fileType = getFileTypeCategory(mime, fileName);

  // For text-like files, fetch content to display inline.
  const isCsv =
    mime?.split(";")[0]?.trim().toLowerCase() === "text/csv" ||
    fileName.toLowerCase().endsWith(".csv");
  const canPreviewAsText = fileType === "text" || isCsv;
  const requiresDownloadUrlForPreview = !canPreviewAsText;
  const textPreviewQuery = useQuery({
    ...trpc.knowledge.getTextPreview.queryOptions({ sourceId }),
    enabled: open && canPreviewAsText,
  });

  const handleDownload = () => {
    if (downloadUrl) {
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  const renderTextPreview = (label: string) => {
    if (textPreviewQuery.data) {
      return (
        <div className="w-full h-[70vh] overflow-auto p-4">
          <pre className="text-sm font-mono whitespace-pre-wrap break-words bg-muted p-4 rounded-lg">
            {textPreviewQuery.data.content}
          </pre>
          {textPreviewQuery.data.truncated ? (
            <p className="pt-3 text-xs text-muted-foreground">
              Showing the first{" "}
              {formatBytes(textPreviewQuery.data.previewBytes)}
              {" of "}
              {formatBytes(textPreviewQuery.data.totalBytes)}. Download for the
              full file.
            </p>
          ) : null}
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center h-[70vh] gap-4 p-4">
        <FileText className="w-16 h-16 text-muted-foreground" />
        <div className="text-center">
          <p className="text-muted-foreground mb-4">
            {textPreviewQuery.error
              ? "Preview could not be loaded"
              : `Loading ${label}...`}
          </p>
          {textPreviewQuery.error ? (
            <Button onClick={handleDownload} disabled={!downloadUrl}>
              <Download className="w-4 h-4 mr-2" />
              Download
            </Button>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {fileType === "image" && <ImageIcon className="w-5 h-5" />}
            {fileType === "pdf" && <FileText className="w-5 h-5" />}
            {fileType === "document" && <FileText className="w-5 h-5" />}
            {fileType === "spreadsheet" && (
              <FileSpreadsheet className="w-5 h-5" />
            )}
            {fileType === "text" && <FileText className="w-5 h-5" />}
            {fileName}
          </DialogTitle>
          <DialogDescription>{mime || "Unknown file type"}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto min-h-0">
          {requiresDownloadUrlForPreview && (isLoading || !downloadUrl) ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-muted-foreground">Loading file...</div>
            </div>
          ) : (
            <>
              {fileType === "image" && (
                <div className="flex items-center justify-center p-4">
                  <img
                    src={downloadUrl ?? ""}
                    alt={fileName}
                    className="max-w-full max-h-[70vh] object-contain rounded-lg"
                  />
                </div>
              )}

              {fileType === "pdf" && (
                <div className="w-full h-[70vh]">
                  <iframe
                    src={downloadUrl ?? ""}
                    className="w-full h-full border rounded-lg"
                    title={fileName}
                  />
                </div>
              )}

              {fileType === "document" && (
                <div className="flex flex-col items-center justify-center h-[70vh] gap-4 p-4">
                  <FileText className="w-16 h-16 text-muted-foreground" />
                  <div className="text-center">
                    <p className="text-muted-foreground mb-2">
                      Word document preview is not available in the browser
                    </p>
                    <p className="text-sm text-muted-foreground mb-4">
                      Please download the file to view it
                    </p>
                    <Button onClick={handleDownload}>
                      <Download className="w-4 h-4 mr-2" />
                      Download Document
                    </Button>
                  </div>
                </div>
              )}

              {fileType === "spreadsheet" &&
                (isCsv ? (
                  renderTextPreview("CSV")
                ) : (
                  <div className="flex flex-col items-center justify-center h-[70vh] gap-4 p-4">
                    <FileSpreadsheet className="w-16 h-16 text-muted-foreground" />
                    <div className="text-center">
                      <p className="text-muted-foreground mb-2">
                        Spreadsheet preview is not available in the browser
                      </p>
                      <p className="text-sm text-muted-foreground mb-4">
                        Please download the file to view it
                      </p>
                      <Button onClick={handleDownload}>
                        <Download className="w-4 h-4 mr-2" />
                        Download Spreadsheet
                      </Button>
                    </div>
                  </div>
                ))}

              {fileType === "text" && renderTextPreview("file")}

              {fileType === "other" && (
                <div className="flex flex-col items-center justify-center h-64 gap-4">
                  <FileText className="w-16 h-16 text-muted-foreground" />
                  <div className="text-center">
                    <p className="text-muted-foreground mb-2">
                      Preview not available for this file type
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {mime || "Unknown file type"}
                    </p>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button
            variant="outline"
            onClick={handleDownload}
            disabled={!downloadUrl}
          >
            <Download className="w-4 h-4 mr-2" />
            Download
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
