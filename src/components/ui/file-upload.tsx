import { AlertCircle, CheckCircle, File, Upload, X } from "lucide-react";
import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

interface FileUploadProps {
  onUpload: (files: File[]) => Promise<void>;
  accept?: Record<string, string[]>;
  maxSize?: number;
  maxFiles?: number;
  disabled?: boolean;
}

interface UploadProgress {
  file: File;
  progress: number;
  status: "uploading" | "success" | "error";
  error?: string;
}

export function FileUpload({
  onUpload,
  accept = {
    "application/pdf": [".pdf"],
    "text/plain": [".txt"],
    "text/markdown": [".md"],
    "application/msword": [".doc"],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
      ".docx",
    ],
    "text/csv": [".csv"],
    "application/json": [".json"],
  },
  maxSize = 10 * 1024 * 1024, // 10MB
  maxFiles = 5,
  disabled = false,
}: FileUploadProps) {
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (disabled || isUploading) return;

      setIsUploading(true);

      // Initialize upload progress
      const initialUploads: UploadProgress[] = acceptedFiles.map((file) => ({
        file,
        progress: 0,
        status: "uploading",
      }));

      setUploads(initialUploads);

      try {
        await onUpload(acceptedFiles);

        // Mark all as successful
        setUploads((prev) =>
          prev.map((upload) => ({
            ...upload,
            progress: 100,
            status: "success",
          })),
        );
      } catch (error) {
        // Mark all as failed
        setUploads((prev) =>
          prev.map((upload) => ({
            ...upload,
            progress: 0,
            status: "error",
            error: error instanceof Error ? error.message : "Upload failed",
          })),
        );
      } finally {
        setIsUploading(false);
      }
    },
    [onUpload, disabled, isUploading],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept,
    maxSize,
    maxFiles,
    disabled: disabled || isUploading,
  });

  const clearUploads = () => {
    setUploads([]);
  };

  return (
    <div className="space-y-4">
      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
          isDragActive
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/25 hover:border-primary/50"
        } ${disabled || isUploading ? "opacity-50 cursor-not-allowed" : ""}`}
      >
        <input {...getInputProps()} />
        <Upload className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
        <div className="space-y-2">
          <p className="text-lg font-medium">
            {isDragActive ? "Drop files here" : "Upload knowledge files"}
          </p>
          <p className="text-sm text-muted-foreground">
            Drag & drop files here, or click to select files
          </p>
          <p className="text-xs text-muted-foreground">
            Supports PDF, TXT, MD, DOC, DOCX, CSV, JSON • Max {maxFiles} files •{" "}
            {(maxSize / (1024 * 1024)).toFixed(0)}MB each
          </p>
        </div>
      </div>

      {uploads.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">Upload Progress</h4>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearUploads}
              disabled={isUploading}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {uploads.map((upload, index) => (
            <div key={index} className="space-y-2">
              <div className="flex items-center gap-2">
                <File className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium truncate">
                  {upload.file.name}
                </span>
                <span className="text-xs text-muted-foreground ml-auto">
                  {upload.status === "success" && (
                    <CheckCircle className="h-4 w-4 text-green-500" />
                  )}
                  {upload.status === "error" && (
                    <AlertCircle className="h-4 w-4 text-red-500" />
                  )}
                  {upload.status === "uploading" && (
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  )}
                </span>
              </div>

              <Progress value={upload.progress} className="h-2" />

              {upload.error && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    {upload.error}
                  </AlertDescription>
                </Alert>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
