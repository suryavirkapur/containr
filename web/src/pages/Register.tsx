import { Component, createSignal } from 'solid-js';
import { A, useNavigate } from '@solidjs/router';

/**
 * registration page
 */
const Register: Component = () => {
    const [email, setEmail] = createSignal('');
    const [password, setPassword] = createSignal('');
    const [confirmPassword, setConfirmPassword] = createSignal('');
    const [error, setError] = createSignal('');
    const [loading, setLoading] = createSignal(false);
    const navigate = useNavigate();

    const handleSubmit = async (e: Event) => {
        e.preventDefault();
        setError('');

        if (password() !== confirmPassword()) {
            setError('passwords do not match');
            return;
        }

        if (password().length < 8) {
            setError('password must be at least 8 characters');
            return;
        }

        setLoading(true);

        try {
            const res = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email(), password: password() }),
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'registration failed');
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
                    <h2 class="text-lg font-serif text-black mb-6">create account</h2>

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

                        <div>
                            <label class="block text-neutral-600 text-sm mb-2">
                                confirm password
                            </label>
                            <input
                                type="password"
                                value={confirmPassword()}
                                onInput={(e) => setConfirmPassword(e.currentTarget.value)}
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
                            {loading() ? 'creating account...' : 'create account'}
                        </button>
                    </form>

                    {/* login link */}
                    <p class="mt-6 text-center text-neutral-500 text-sm">
                        already have an account?{' '}
                        <A href="/login" class="text-black hover:underline">
                            sign in
                        </A>
                    </p>
                </div>
            </div>
        </div>
    );
};

export default Register;
