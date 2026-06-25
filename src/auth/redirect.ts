const AUTH_PATH_PREFIXES = ["/auth/sign-in", "/auth/sign-up"];

export function normalizeAuthRedirect(value: unknown, fallback = "/") {
  if (typeof value !== "string") return fallback;

  const redirect = value.trim();
  if (!redirect) return fallback;

  // Only allow same-origin relative paths. This prevents open redirects such as
  // https://evil.example or protocol-relative URLs like //evil.example.
  if (!redirect.startsWith("/") || redirect.startsWith("//")) {
    return fallback;
  }

  if (redirect.includes("\\")) return fallback;

  // Avoid auth-page redirect loops.
  if (AUTH_PATH_PREFIXES.some((prefix) => redirect.startsWith(prefix))) {
    return fallback;
  }

  return redirect;
}
