import { api, type components } from "./index";

export type AuthResponse = components["schemas"]["AuthResponse"];
export type AuthUser = components["schemas"]["UserResponse"];
export type RegistrationStatus = components["schemas"]["RegistrationStatusResponse"];

type LoginBody = components["schemas"]["LoginRequest"];
type RegisterBody = components["schemas"]["RegisterRequest"];
type CreateUserBody = components["schemas"]["CreateUserRequest"];

const readError = async (response: Response) => {
	try {
		const data = await response.json();
		if (data && typeof data.error === "string") {
			return data.error;
		}
	} catch {
		// ignore parse failures and fall back to the status text
	}
	return response.statusText || "request failed";
};

export const getRegistrationStatus = async (): Promise<RegistrationStatus> => {
	const { data, error } = await api.GET("/api/auth/status");
	if (error) throw error;
	if (!data) throw new Error("missing registration status");
	return data;
};

export const login = async (body: LoginBody): Promise<AuthResponse> => {
	const { data, error } = await api.POST("/api/auth/login", { body });
	if (error) throw error;
	if (!data) throw new Error("missing auth response");
	return data;
};

export const register = async (body: RegisterBody): Promise<AuthResponse> => {
	const { data, error } = await api.POST("/api/auth/register", { body });
	if (error) throw error;
	if (!data) throw new Error("missing auth response");
	return data;
};

/**
 * finishes a github round trip: signs in, or links github to the signed-in
 * account (`linked` in the response) when the link was started there
 */
export const finishGithubLogin = async (
	code: string,
	state: string,
	token?: string | null,
): Promise<AuthResponse> => {
	const response = await fetch(
		`/api/auth/github/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
		{
			method: "GET",
			headers: {
				Accept: "application/json",
				// a link has to finish in the session that started it
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
		},
	);

	if (!response.ok) {
		throw new Error(await readError(response));
	}

	return response.json() as Promise<AuthResponse>;
};

/** github authorization url for linking github to the signed-in account */
export const startGithubLink = async (): Promise<string> => {
	const { data, error } = await api.POST("/api/auth/github/link");
	if (error) throw error;
	if (!data) throw new Error("missing github link response");
	return data.url;
};

export const unlinkGithub = async (): Promise<AuthUser> => {
	const { data, error } = await api.DELETE("/api/auth/github/link");
	if (error) throw error;
	if (!data) throw new Error("missing user response");
	return data;
};

export const getCurrentUser = async (): Promise<AuthUser> => {
	const { data, error } = await api.GET("/api/auth/me");
	if (error) throw error;
	if (!data) throw new Error("missing current user response");
	return data;
};

export const listUsers = async (): Promise<AuthUser[]> => {
	const { data, error } = await api.GET("/api/admin/users");
	if (error) throw error;
	return data ?? [];
};

export const createUser = async (body: CreateUserBody): Promise<AuthUser> => {
	const { data, error } = await api.POST("/api/admin/users", { body });
	if (error) throw error;
	if (!data) throw new Error("missing created user response");
	return data;
};
