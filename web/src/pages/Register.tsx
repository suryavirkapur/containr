import { Component, createSignal } from 'solid-js';
import { A, useNavigate } from '@solidjs/router';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';

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
                    <h1 class="text-4xl font-serif font-bold text-black tracking-tight">znskr</h1>
                    <p class="text-neutral-500 mt-2 text-sm font-light">deploy containers with ease</p>
                </div>

                {/* form */}
                <div class="border-t border-b border-neutral-100 py-10">
                    <h2 class="text-xl font-serif font-medium text-black mb-8 text-center">create account</h2>

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
                            placeholder="at least 8 characters"
                            required
                        />

                        <Input
                            label="confirm password"
                            type="password"
                            value={confirmPassword()}
                            onInput={(e) => setConfirmPassword(e.currentTarget.value)}
                            placeholder="confirm your password"
                            required
                        />

                        <Button
                            type="submit"
                            isLoading={loading()}
                            class="w-full"
                        >
                            {loading() ? 'creating account...' : 'create account'}
                        </Button>
                    </form>

                    {/* login link */}
                    <p class="mt-8 text-center text-neutral-400 text-sm">
                        already have an account?{' '}
                        <A href="/login" class="text-black hover:underline font-medium">
                            sign in
                        </A>
                    </p>
                </div>
            </div>
        </div>
    );
};

export default Register;
