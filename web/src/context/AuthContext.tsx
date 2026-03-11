import { type Accessor, createContext, createSignal, type JSX, useContext } from "solid-js";
import { api, type components } from "../api";

type User = components["schemas"]["UserResponse"];

interface AuthContextType {
	user: Accessor<User | null>;
	token: Accessor<string | null>;
	login: (email: string, password: string) => Promise<void>;
	register: (email: string, password: string) => Promise<void>;
	logout: () => void;
	isAuthenticated: Accessor<boolean>;
}

const AuthContext = createContext<AuthContextType>();

/**
 * provides authentication state and methods
 */
export function AuthProvider(props: { children: JSX.Element }) {
	const [user, setUser] = createSignal<User | null>(null);
	const [token, setToken] = createSignal<string | null>(localStorage.getItem("containr_token"));

	const isAuthenticated = () => !!token();

	const login = async (email: string, password: string) => {
		const { data, error } = await api.POST("/api/auth/login", {
			body: { email, password },
		});
		if (error) throw error;
		setToken(data.token);
		setUser(data.user);
		localStorage.setItem("containr_token", data.token);
	};

	const register = async (email: string, password: string) => {
		const { data, error } = await api.POST("/api/auth/register", {
			body: { email, password },
		});
		if (error) throw error;
		setToken(data.token);
		setUser(data.user);
		localStorage.setItem("containr_token", data.token);
	};

	const logout = () => {
		setToken(null);
		setUser(null);
		localStorage.removeItem("containr_token");
	};

	return (
		<AuthContext.Provider value={{ user, token, login, register, logout, isAuthenticated }}>
			{props.children}
		</AuthContext.Provider>
	);
}

export function useAuth() {
	const ctx = useContext(AuthContext);
	if (!ctx) {
		throw new Error("useAuth must be used within AuthProvider");
	}
	return ctx;
}
