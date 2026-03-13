import {
  type Accessor,
  createContext,
  createEffect,
  createSignal,
  type JSX,
  useContext,
} from 'solid-js';
import {
  type AuthUser,
  getCurrentUser,
  login as loginRequest,
  register as registerRequest,
} from '../api/auth';

interface AuthContextValue {
  user: Accessor<AuthUser | null>;
  token: Accessor<string | null>;
  ready: Accessor<boolean>;
  isAuthenticated: Accessor<boolean>;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const TOKEN_KEY = 'containr_token';
const USER_KEY = 'containr_user';
const AuthContext = createContext<AuthContextValue>();

const readStoredUser = (): AuthUser | null => {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    localStorage.removeItem(USER_KEY);
    return null;
  }
};

export const AuthProvider = (props: { children: JSX.Element }) => {
  const initialToken = localStorage.getItem(TOKEN_KEY);
  const initialUser = initialToken ? readStoredUser() : null;

  const [token, setToken] = createSignal<string | null>(initialToken);
  const [user, setUser] = createSignal<AuthUser | null>(initialUser);
  const [ready, setReady] = createSignal(!initialToken || Boolean(initialUser));

  const isAuthenticated = () => Boolean(token() && user());

  const clearSession = () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
  };

  const storeUser = (value: AuthUser | null) => {
    if (!value) {
      localStorage.removeItem(USER_KEY);
      setUser(null);
      return;
    }

    localStorage.setItem(USER_KEY, JSON.stringify(value));
    setUser(value);
  };

  const refreshUser = async () => {
    if (!token()) {
      storeUser(null);
      setReady(true);
      return;
    }

    try {
      const currentUser = await getCurrentUser();
      storeUser(currentUser);
    } catch {
      clearSession();
    } finally {
      setReady(true);
    }
  };

  createEffect(() => {
    const currentToken = token();
    if (!currentToken) {
      setReady(true);
      return;
    }

    if (user()) {
      setReady(true);
      return;
    }

    setReady(false);
    void refreshUser();
  });

  const login = async (email: string, password: string) => {
    const response = await loginRequest({ email, password });
    localStorage.setItem(TOKEN_KEY, response.token);
    setToken(response.token);
    storeUser(response.user);
    setReady(true);
  };

  const register = async (email: string, password: string) => {
    const response = await registerRequest({ email, password });
    localStorage.setItem(TOKEN_KEY, response.token);
    setToken(response.token);
    storeUser(response.user);
    setReady(true);
  };

  const logout = () => {
    clearSession();
    setReady(true);
  };

  return (
    <AuthContext.Provider value={{ user, token, ready, isAuthenticated, login, register, logout, refreshUser }}>
      {props.children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};
