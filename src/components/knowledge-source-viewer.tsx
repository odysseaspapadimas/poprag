import { useQuery } from "@tanstack/react-query";
import {
  Download,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
} from "lucide-react";
import * as React from "react";
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

/**
 * Determines the file type category based on MIME type
 */
function getFileTypeCategory(
  mime: string | null,
): "image" | "pdf" | "document" | "spreadsheet" | "other" {
  if (!mime) return "other";

  // Images
  if (mime.startsWith("image/")) {
    return "image";
  }

  // PDF
  if (mime === "application/pdf") {
    return "pdf";
  }

  // Word documents
  if (
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/msword" ||
    mime === "application/vnd.oasis.opendocument.text"
  ) {
    return "document";
  }

  // Excel/Spreadsheet files
  if (
    mime ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel.sheet.macroenabled.12" ||
    mime === "application/vnd.ms-excel.sheet.binary.macroenabled.12" ||
    mime === "application/vnd.ms-excel" ||
    mime === "application/vnd.oasis.opendocument.spreadsheet" ||
    mime === "application/vnd.apple.numbers" ||
    mime === "text/csv"
  ) {
    return "spreadsheet";
  }

  return "other";
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
  const fileType = getFileTypeCategory(mime);

  // For CSV files, fetch content to display as text
  const isCsv = mime === "text/csv";
  const [csvContent, setCsvContent] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (isCsv && downloadUrl && open) {
      fetch(downloadUrl)
        .then((res) => res.text())
        .then((text) => setCsvContent(text))
        .catch((err) => {
          console.error("Failed to load CSV:", err);
          setCsvContent(null);
        });
    } else {
      setCsvContent(null);
    }
  }, [isCsv, downloadUrl, open]);

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
            {fileName}
          </DialogTitle>
          <DialogDescription>{mime || "Unknown file type"}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto min-h-0">
          {isLoading || !downloadUrl ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-muted-foreground">Loading file...</div>
            </div>
          ) : (
            <>
              {fileType === "image" && (
                <div className="flex items-center justify-center p-4">
                  <img
                    src={downloadUrl}
                    alt={fileName}
                    className="max-w-full max-h-[70vh] object-contain rounded-lg"
                  />
                </div>
              )}

              {fileType === "pdf" && (
                <div className="w-full h-[70vh]">
                  <iframe
                    src={downloadUrl}
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

              {fileType === "spreadsheet" && (
                <>
                  {isCsv && csvContent ? (
                    <div className="w-full h-[70vh] overflow-auto p-4">
                      <pre className="text-sm font-mono whitespace-pre-wrap bg-muted p-4 rounded-lg">
                        {csvContent}
                      </pre>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center h-[70vh] gap-4 p-4">
                      <FileSpreadsheet className="w-16 h-16 text-muted-foreground" />
                      <div className="text-center">
                        <p className="text-muted-foreground mb-2">
                          {isCsv && !csvContent
                            ? "Loading CSV..."
                            : "Spreadsheet preview is not available in the browser"}
                        </p>
                        {!isCsv && (
                          <p className="text-sm text-muted-foreground mb-4">
                            Please download the file to view it
                          </p>
                        )}
                        <Button onClick={handleDownload}>
                          <Download className="w-4 h-4 mr-2" />
                          Download {isCsv ? "CSV" : "Spreadsheet"}
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}

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
