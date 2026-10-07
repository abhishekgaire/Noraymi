/** The Console's fetch wrapper: same-origin, cookie session, JSON errors. */
export class ConsoleApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  method: "GET" | "POST" | "PATCH" | "PUT",
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...extraHeaders,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return undefined as T;
  const parsed = (await response.json().catch(() => null)) as
    ({ error?: { code?: string; message?: string } } & Record<string, unknown>) | null;
  if (!response.ok) {
    throw new ConsoleApiError(
      response.status,
      parsed?.error?.code ?? "unknown",
      parsed?.error?.message ?? response.statusText,
    );
  }
  return parsed as T;
}
