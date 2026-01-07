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
        <div class="min-h-screen flex items-center justify-center bg-gray-950 px-4">
            <div class="w-full max-w-md">
                {/* logo */}
                <div class="text-center mb-8">
                    <h1 class="text-3xl font-bold text-primary-500">znskr</h1>
                    <p class="text-gray-400 mt-2">deploy containers with ease</p>
                </div>

                {/* form */}
                <div class="bg-gray-900 border border-gray-800 p-8">
                    <h2 class="text-xl font-semibold text-white mb-6">create account</h2>

                    {error() && (
                        <div class="bg-red-900/50 border border-red-800 text-red-200 px-4 py-3 mb-6">
                            {error()}
                        </div>
                    )}

                    <form onSubmit={handleSubmit} class="space-y-6">
                        <div>
                            <label class="block text-gray-300 text-sm font-medium mb-2">
                                email
                            </label>
                            <input
                                type="email"
                                value={email()}
                                onInput={(e) => setEmail(e.currentTarget.value)}
                                class="w-full px-4 py-3 bg-gray-800 border border-gray-700 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500"
                                placeholder="you@example.com"
                                required
                            />
                        </div>

                        <div>
                            <label class="block text-gray-300 text-sm font-medium mb-2">
                                password
                            </label>
                            <input
                                type="password"
                                value={password()}
                                onInput={(e) => setPassword(e.currentTarget.value)}
                                class="w-full px-4 py-3 bg-gray-800 border border-gray-700 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500"
                                placeholder="••••••••"
                                required
                            />
                        </div>

                        <div>
                            <label class="block text-gray-300 text-sm font-medium mb-2">
                                confirm password
                            </label>
                            <input
                                type="password"
                                value={confirmPassword()}
                                onInput={(e) => setConfirmPassword(e.currentTarget.value)}
                                class="w-full px-4 py-3 bg-gray-800 border border-gray-700 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500"
                                placeholder="••••••••"
                                required
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={loading()}
                            class="w-full px-4 py-3 bg-primary-600 text-white font-medium hover:bg-primary-700 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            {loading() ? 'creating account...' : 'create account'}
                        </button>
                    </form>

                    {/* login link */}
                    <p class="mt-6 text-center text-gray-500">
                        already have an account?{' '}
                        <A href="/login" class="text-primary-400 hover:text-primary-300">
                            sign in
                        </A>
                    </p>
                </div>
            </div>
        </div>
    );
};

export default Register;
