import { Component, createSignal } from 'solid-js';
import { useNavigate } from '@solidjs/router';

/**
 * new app creation page
 */
const NewApp: Component = () => {
    const [name, setName] = createSignal('');
    const [githubUrl, setGithubUrl] = createSignal('');
    const [branch, setBranch] = createSignal('main');
    const [domain, setDomain] = createSignal('');
    const [port, setPort] = createSignal('8080');
    const [error, setError] = createSignal('');
    const [loading, setLoading] = createSignal(false);
    const navigate = useNavigate();

    const handleSubmit = async (e: Event) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            const token = localStorage.getItem('znskr_token');
            const res = await fetch('/api/apps', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                    name: name(),
                    github_url: githubUrl(),
                    branch: branch() || 'main',
                    domain: domain() || null,
                    port: parseInt(port()) || 8080,
                }),
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'failed to create app');
            }

            const app = await res.json();
            navigate(`/apps/${app.id}`);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div class="max-w-lg mx-auto">
            {/* header */}
            <div class="mb-10">
                <h1 class="text-2xl font-serif text-black">deploy new app</h1>
                <p class="text-neutral-500 mt-1 text-sm">
                    connect a github repository to deploy automatically
                </p>
            </div>

            {/* form */}
            <div class="border border-neutral-200 p-8">
                {error() && (
                    <div class="border border-neutral-300 bg-neutral-50 text-neutral-700 px-4 py-3 mb-6 text-sm">
                        {error()}
                    </div>
                )}

                <form onSubmit={handleSubmit} class="space-y-6">
                    {/* app name */}
                    <div>
                        <label class="block text-neutral-600 text-sm mb-2">
                            app name
                        </label>
                        <input
                            type="text"
                            value={name()}
                            onInput={(e) => setName(e.currentTarget.value)}
                            class="w-full px-3 py-2.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
                            placeholder="my-awesome-app"
                            required
                        />
                        <p class="mt-1.5 text-xs text-neutral-400">
                            lowercase letters, numbers, and hyphens only
                        </p>
                    </div>

                    {/* github url */}
                    <div>
                        <label class="block text-neutral-600 text-sm mb-2">
                            github repository url
                        </label>
                        <input
                            type="url"
                            value={githubUrl()}
                            onInput={(e) => setGithubUrl(e.currentTarget.value)}
                            class="w-full px-3 py-2.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
                            placeholder="https://github.com/username/repo"
                            required
                        />
                    </div>

                    {/* branch */}
                    <div>
                        <label class="block text-neutral-600 text-sm mb-2">
                            branch
                        </label>
                        <input
                            type="text"
                            value={branch()}
                            onInput={(e) => setBranch(e.currentTarget.value)}
                            class="w-full px-3 py-2.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
                            placeholder="main"
                        />
                        <p class="mt-1.5 text-xs text-neutral-400">
                            pushes to this branch will trigger deployments
                        </p>
                    </div>

                    {/* domain */}
                    <div>
                        <label class="block text-neutral-600 text-sm mb-2">
                            custom domain <span class="text-neutral-400">(optional)</span>
                        </label>
                        <input
                            type="text"
                            value={domain()}
                            onInput={(e) => setDomain(e.currentTarget.value)}
                            class="w-full px-3 py-2.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
                            placeholder="app.example.com"
                        />
                        <p class="mt-1.5 text-xs text-neutral-400">
                            ssl will be automatically provisioned
                        </p>
                    </div>

                    {/* port */}
                    <div>
                        <label class="block text-neutral-600 text-sm mb-2">
                            application port
                        </label>
                        <input
                            type="number"
                            value={port()}
                            onInput={(e) => setPort(e.currentTarget.value)}
                            class="w-full px-3 py-2.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
                            placeholder="8080"
                        />
                        <p class="mt-1.5 text-xs text-neutral-400">
                            the port your app listens on inside the container
                        </p>
                    </div>

                    {/* submit */}
                    <div class="flex gap-3 pt-2">
                        <button
                            type="submit"
                            disabled={loading()}
                            class="flex-1 px-4 py-2.5 bg-black text-white hover:bg-neutral-800 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
                        >
                            {loading() ? 'creating...' : 'create app'}
                        </button>
                        <button
                            type="button"
                            onClick={() => navigate('/')}
                            class="px-4 py-2.5 border border-neutral-300 text-neutral-700 hover:text-black hover:border-neutral-400 transition-colors text-sm"
                        >
                            cancel
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default NewApp;
