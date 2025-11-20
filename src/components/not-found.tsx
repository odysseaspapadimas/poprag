import type { NotFoundRouteProps } from "@tanstack/react-router";

export function NotFound(props: NotFoundRouteProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen">
      <h1 className="text-4xl font-bold text-gray-900 dark:text-gray-100 mb-4">
        404 - Page Not Found
      </h1>
      <p className="text-lg text-gray-600 dark:text-gray-400 mb-8">
        The page you're looking for doesn't exist.
      </p>
    </div>
  );
}
