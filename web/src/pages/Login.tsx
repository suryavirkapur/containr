import { Component, createSignal } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { api } from "../api";

/**
 * login page
 */
const Login: Component = () => {
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const { data, error } = await api.POST("/api/auth/login", {
        body: { email: email(), password: password() },
      });
      if (error) throw error;
      localStorage.setItem("containr_token", data.token);
      navigate("/");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="min-h-screen flex items-center justify-center bg-white px-4">
      <div class="w-full max-w-sm">
        {/* logo */}
        <div class="text-center mb-10">
          <h1 class="text-4xl font-serif font-bold text-black tracking-tight">
            containr
          </h1>
          <p class="text-neutral-500 mt-2 text-sm font-light">
            deploy containers with ease
          </p>
        </div>

        {/* form */}
        <div class="border-t border-b border-neutral-100 py-10">
          <h2 class="text-xl font-serif font-medium text-black mb-8 text-center">
            sign in
          </h2>

          {error() && (
            <div class="border border-red-200 bg-red-50 text-red-800 px-4 py-3 mb-6 text-xs font-mono">
              {error()}
            </div>
          )}

          <form onSubmit={handleSubmit} class="space-y-5">
            <Input
              label="email"
              type="email"
              value={email()}
              onInput={(e) => setEmail(e.currentTarget.value)}
              placeholder="you@example.com"
              required
            />

            <Input
              label="password"
              type="password"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
              placeholder="********"
              required
            />

            <Button type="submit" isLoading={loading()} class="w-full">
              {loading() ? "signing in..." : "sign in"}
            </Button>
          </form>

          {/* github oauth */}
          <div class="mt-8">
            <div class="relative">
              <div class="absolute inset-0 flex items-center">
                <div class="w-full border-t border-neutral-100"></div>
              </div>
              <div class="relative flex justify-center text-xs uppercase tracking-widest">
                <span class="px-2 bg-white text-neutral-400">or</span>
              </div>
            </div>

            <a
              href="/api/auth/github"
              class="mt-6 w-full flex items-center justify-center gap-2 px-4 py-2.5 border border-neutral-200 text-neutral-700 hover:text-black hover:border-black transition-colors text-sm font-medium"
            >
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
              continue with github
            </a>
          </div>
        </div>

        {/* register link */}
        <p class="mt-8 text-center text-neutral-400 text-sm">
          don't have an account?{" "}
          <A href="/register" class="text-black hover:underline font-medium">
            sign up
          </A>
        </p>
      </div>
    </div>
  );
};

export default Login;
