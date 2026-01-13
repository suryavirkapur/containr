import { Component, createSignal } from 'solid-js';
import { A, useNavigate } from '@solidjs/router';

/**
 * login page
 */
const Login: Component = () => {
    const [email, setEmail] = createSignal('');
    const [password, setPassword] = createSignal('');
    const [error, setError] = createSignal('');
    const [loading, setLoading] = createSignal(false);
    const navigate = useNavigate();

    const handleSubmit = async (e: Event) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email(), password: password() }),
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'login failed');
            }

            const data = await res.json();
            localStorage.setItem('znskr_token', data.token);
            navigate('/');
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
                    <h1 class="text-3xl font-serif font-semibold text-black tracking-tight">znskr</h1>
                    <p class="text-neutral-500 mt-2 text-sm">deploy containers with ease</p>
                </div>

                {/* form */}
                <div class="border border-neutral-200 p-8">
                    <h2 class="text-lg font-serif text-black mb-6">sign in</h2>

                    {error() && (
                        <div class="border border-neutral-300 bg-neutral-50 text-neutral-700 px-4 py-3 mb-6 text-sm">
                            {error()}
                        </div>
                    )}

                    <form onSubmit={handleSubmit} class="space-y-5">
                        <div>
                            <label class="block text-neutral-600 text-sm mb-2">
                                email
                            </label>
                            <input
                                type="email"
                                value={email()}
                                onInput={(e) => setEmail(e.currentTarget.value)}
                                class="w-full px-3 py-2.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
                                placeholder="you@example.com"
                                required
                            />
                        </div>

                        <div>
                            <label class="block text-neutral-600 text-sm mb-2">
                                password
                            </label>
                            <input
                                type="password"
                                value={password()}
                                onInput={(e) => setPassword(e.currentTarget.value)}
                                class="w-full px-3 py-2.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
                                placeholder="********"
                                required
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={loading()}
                            class="w-full px-4 py-2.5 bg-black text-white hover:bg-neutral-800 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
                        >
                            {loading() ? 'signing in...' : 'sign in'}
                        </button>
                    </form>

                    {/* github oauth */}
                    <div class="mt-6">
                        <div class="relative">
                            <div class="absolute inset-0 flex items-center">
                                <div class="w-full border-t border-neutral-200"></div>
                            </div>
                            <div class="relative flex justify-center text-sm">
                                <span class="px-2 bg-white text-neutral-400">or</span>
                            </div>
                        </div>

                        <a
                            href="/api/auth/github"
                            class="mt-5 w-full flex items-center justify-center gap-2 px-4 py-2.5 border border-neutral-300 text-neutral-700 hover:text-black hover:border-neutral-400 transition-colors text-sm"
                        >
                            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                            </svg>
                            continue with github
                        </a>
                    </div>

                    {/* register link */}
                    <p class="mt-6 text-center text-neutral-500 text-sm">
                        don't have an account?{' '}
                        <A href="/register" class="text-black hover:underline">
                            sign up
                        </A>
                    </p>
                </div>
            </div>
        </div>
    );
};

export default Login;
