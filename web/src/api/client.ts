type ApiResponseType = "json" | "text";

export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  headers?: HeadersInit;
  auth?: boolean;
  responseType?: ApiResponseType;
  signal?: AbortSignal;
}

const isJsonBody = (body: unknown) =>
  body !== null &&
  body !== undefined &&
  typeof body === "object" &&
  !(body instanceof FormData) &&
  !(body instanceof URLSearchParams) &&
  !(body instanceof Blob);

const readErrorMessage = async (res: Response) => {
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const data = await res.json();
    if (typeof data?.error === "string") {
      return data.error;
    }
    if (typeof data?.message === "string") {
      return data.message;
    }
    return "request failed";
  }

  const text = await res.text();
  return text || "request failed";
};

export const apiRequest = async <T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> => {
  const headers = new Headers(options.headers);
  const auth = options.auth !== false;
  const method = options.method || (options.body ? "POST" : "GET");
  let body: BodyInit | undefined;

  if (auth) {
    const token = localStorage.getItem("znskr_token");
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }

  if (isJsonBody(options.body)) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.body);
  } else if (options.body !== undefined) {
    body = options.body as BodyInit;
  }

  const res = await fetch(path, {
    method,
    headers,
    body,
    signal: options.signal,
  });

  if (res.status === 401 && auth) {
    localStorage.removeItem("znskr_token");
    window.location.href = "/login";
  }

  if (!res.ok) {
    const message = await readErrorMessage(res);
    throw new Error(message);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const responseType = options.responseType || "json";
  if (responseType === "text") {
    return (await res.text()) as T;
  }

  return res.json();
};

export const apiGet = <T>(path: string, options: ApiRequestOptions = {}) =>
  apiRequest<T>(path, { ...options, method: "GET" });

export const apiPost = <T>(
  path: string,
  body?: unknown,
  options: ApiRequestOptions = {},
) => apiRequest<T>(path, { ...options, method: "POST", body });

export const apiPut = <T>(
  path: string,
  body?: unknown,
  options: ApiRequestOptions = {},
) => apiRequest<T>(path, { ...options, method: "PUT", body });

export const apiDelete = <T>(
  path: string,
  body?: unknown,
  options: ApiRequestOptions = {},
) => apiRequest<T>(path, { ...options, method: "DELETE", body });
