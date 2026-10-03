// minimal json client for endpoints that are not (yet) in the generated
// openapi schema. shares auth handling with the typed client.

const TOKEN_KEY = "containr_token";
const USER_KEY = "containr_user";

export class ApiError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export const authHeaders = (): Record<string, string> => {
	const token = localStorage.getItem(TOKEN_KEY);
	return token ? { Authorization: `Bearer ${token}` } : {};
};

const readError = async (response: Response): Promise<string> => {
	try {
		const data = await response.json();
		if (data && typeof data.error === "string") return data.error;
		if (data && typeof data.message === "string") return data.message;
	} catch {
		// non-json error body
	}
	return response.statusText || `request failed (${response.status})`;
};

const handleUnauthorized = (response: Response) => {
	if (response.status !== 401) return;
	localStorage.removeItem(TOKEN_KEY);
	localStorage.removeItem(USER_KEY);
	if (window.location.pathname !== "/login") window.location.assign("/login");
};

export const request = async <T>(
	method: string,
	path: string,
	body?: unknown,
	init?: RequestInit,
): Promise<T> => {
	const isForm = body instanceof FormData;
	const response = await fetch(path, {
		method,
		...init,
		headers: {
			Accept: "application/json",
			...(body !== undefined && !isForm ? { "Content-Type": "application/json" } : {}),
			...authHeaders(),
			...(init?.headers ?? {}),
		},
		body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
	});
	handleUnauthorized(response);
	if (!response.ok) throw new ApiError(response.status, await readError(response));
	if (response.status === 204) return undefined as T;
	const text = await response.text();
	return (text ? JSON.parse(text) : undefined) as T;
};

/** downloads a binary response and hands it to the browser as a file */
export const download = async (path: string, fallbackName: string): Promise<void> => {
	const response = await fetch(path, { headers: authHeaders() });
	handleUnauthorized(response);
	if (!response.ok) throw new ApiError(response.status, await readError(response));
	const disposition = response.headers.get("content-disposition") ?? "";
	const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
	const name = match ? decodeURIComponent(match[1]) : fallbackName;
	const blob = await response.blob();
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = name;
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** turns any thrown value (openapi-fetch error bodies included) into text */
export const errorMessage = (error: unknown, fallback = "Something went wrong"): string => {
	if (!error) return fallback;
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message || fallback;
	if (typeof error === "object") {
		const record = error as Record<string, unknown>;
		if (typeof record.error === "string") return record.error;
		if (typeof record.message === "string") return record.message;
	}
	return fallback;
};
