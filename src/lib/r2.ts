export interface R2UrlEnv {
  CLOUDFLARE_ACCOUNT_ID: string;
  R2_BUCKET_NAME?: unknown;
}

export function getR2BucketName(env: unknown): string {
  const value = (env as { R2_BUCKET_NAME?: unknown } | null)?.R2_BUCKET_NAME;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "poprag";
}

export function createR2ObjectUrl(env: R2UrlEnv, r2Key: string): URL {
  return new URL(
    `https://${getR2BucketName(env)}.${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${r2Key}`,
  );
}
