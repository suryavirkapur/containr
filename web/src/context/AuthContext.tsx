import { createSignal, createContext, useContext, JSX, Accessor } from 'solid-js';

interface User {
    id: string;
    email: string;
    github_username?: string;
}

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
    const [token, setToken] = createSignal<string | null>(
        localStorage.getItem('znskr_token')
    );

    const isAuthenticated = () => !!token();

    const login = async (email: string, password: string) => {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'login failed');
        }

        const data = await res.json();
        setToken(data.token);
        setUser(data.user);
        localStorage.setItem('znskr_token', data.token);
    };

    const register = async (email: string, password: string) => {
        const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'registration failed');
        }

        const data = await res.json();
        setToken(data.token);
        setUser(data.user);
        localStorage.setItem('znskr_token', data.token);
    };

    const logout = () => {
        setToken(null);
        setUser(null);
        localStorage.removeItem('znskr_token');
    };

    return (
        <AuthContext.Provider
            value={{ user, token, login, register, logout, isAuthenticated }}
        >
            {props.children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) {
        throw new Error('useAuth must be used within AuthProvider');
    }
    return ctx;
}
