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
        <div class="max-w-2xl mx-auto">
            {/* header */}
            <div class="mb-8">
                <h1 class="text-2xl font-bold text-white">deploy new app</h1>
                <p class="text-gray-400 mt-1">
                    connect a github repository to deploy automatically
                </p>
            </div>

            {/* form */}
            <div class="bg-gray-900 border border-gray-800 p-8">
                {error() && (
                    <div class="bg-red-900/50 border border-red-800 text-red-200 px-4 py-3 mb-6">
                        {error()}
                    </div>
                )}

                <form onSubmit={handleSubmit} class="space-y-6">
                    {/* app name */}
                    <div>
                        <label class="block text-gray-300 text-sm font-medium mb-2">
                            app name
                        </label>
                        <input
                            type="text"
                            value={name()}
                            onInput={(e) => setName(e.currentTarget.value)}
                            class="w-full px-4 py-3 bg-gray-800 border border-gray-700 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500"
                            placeholder="my-awesome-app"
                            required
                        />
                        <p class="mt-1 text-sm text-gray-500">
                            lowercase letters, numbers, and hyphens only
                        </p>
                    </div>

                    {/* github url */}
                    <div>
                        <label class="block text-gray-300 text-sm font-medium mb-2">
                            github repository url
                        </label>
                        <input
                            type="url"
                            value={githubUrl()}
                            onInput={(e) => setGithubUrl(e.currentTarget.value)}
                            class="w-full px-4 py-3 bg-gray-800 border border-gray-700 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500"
                            placeholder="https://github.com/username/repo"
                            required
                        />
                    </div>

                    {/* branch */}
                    <div>
                        <label class="block text-gray-300 text-sm font-medium mb-2">
                            branch
                        </label>
                        <input
                            type="text"
                            value={branch()}
                            onInput={(e) => setBranch(e.currentTarget.value)}
                            class="w-full px-4 py-3 bg-gray-800 border border-gray-700 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500"
                            placeholder="main"
                        />
                        <p class="mt-1 text-sm text-gray-500">
                            pushes to this branch will trigger deployments
                        </p>
                    </div>

                    {/* domain */}
                    <div>
                        <label class="block text-gray-300 text-sm font-medium mb-2">
                            custom domain (optional)
                        </label>
                        <input
                            type="text"
                            value={domain()}
                            onInput={(e) => setDomain(e.currentTarget.value)}
                            class="w-full px-4 py-3 bg-gray-800 border border-gray-700 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500"
                            placeholder="app.svk77.com"
                        />
                        <p class="mt-1 text-sm text-gray-500">
                            ssl will be automatically provisioned
                        </p>
                    </div>

                    {/* port */}
                    <div>
                        <label class="block text-gray-300 text-sm font-medium mb-2">
                            application port
                        </label>
                        <input
                            type="number"
                            value={port()}
                            onInput={(e) => setPort(e.currentTarget.value)}
                            class="w-full px-4 py-3 bg-gray-800 border border-gray-700 text-white placeholder-gray-500 focus:outline-none focus:border-primary-500"
                            placeholder="8080"
                        />
                        <p class="mt-1 text-sm text-gray-500">
                            the port your app listens on inside the container
                        </p>
                    </div>

                    {/* submit */}
                    <div class="flex gap-4 pt-4">
                        <button
                            type="submit"
                            disabled={loading()}
                            class="flex-1 px-4 py-3 bg-primary-600 text-white font-medium hover:bg-primary-700 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            {loading() ? 'creating...' : 'create app'}
                        </button>
                        <button
                            type="button"
                            onClick={() => navigate('/')}
                            class="px-4 py-3 bg-gray-800 text-gray-300 hover:bg-gray-700 border border-gray-700 transition-colors"
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
