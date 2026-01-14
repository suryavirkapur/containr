import { Component, createSignal, For, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import ServiceForm, { Service, createEmptyService } from '../components/ServiceForm';

/**
 * new app creation page with multi-container support
 */
const NewApp: Component = () => {
    const [name, setName] = createSignal('');
    const [githubUrl, setGithubUrl] = createSignal('');
    const [branch, setBranch] = createSignal('main');
    const [domain, setDomain] = createSignal('');
    const [useMultiService, setUseMultiService] = createSignal(false);
    const [port, setPort] = createSignal('8080');
    const [services, setServices] = createSignal<Service[]>([]);
    const [error, setError] = createSignal('');
    const [loading, setLoading] = createSignal(false);
    const navigate = useNavigate();

    const addService = () => {
        setServices([...services(), createEmptyService()]);
    };

    const updateService = (index: number, service: Service) => {
        const updated = [...services()];
        updated[index] = service;
        setServices(updated);
    };

    const removeService = (index: number) => {
        setServices(services().filter((_, i) => i !== index));
    };

    const handleSubmit = async (e: Event) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            const token = localStorage.getItem('znskr_token');

            // build request body
            const body: any = {
                name: name(),
                github_url: githubUrl(),
                branch: branch() || 'main',
                domain: domain() || null,
            };

            if (useMultiService() && services().length > 0) {
                // multi-container mode
                body.services = services().map((s) => ({
                    name: s.name,
                    image: s.image || null,
                    port: s.port,
                    replicas: s.replicas,
                    memory_limit_mb: s.memory_limit_mb,
                    cpu_limit: s.cpu_limit,
                    depends_on: s.depends_on.length > 0 ? s.depends_on : null,
                    health_check: s.health_check_path
                        ? { path: s.health_check_path }
                        : null,
                    restart_policy: s.restart_policy,
                }));
            } else {
                // single-container mode (backward compat)
                body.port = parseInt(port()) || 8080;
            }

            const res = await fetch('/api/apps', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(body),
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
                        <label class="block text-neutral-600 text-sm mb-2">app name</label>
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
                        <label class="block text-neutral-600 text-sm mb-2">branch</label>
                        <input
                            type="text"
                            value={branch()}
                            onInput={(e) => setBranch(e.currentTarget.value)}
                            class="w-full px-3 py-2.5 bg-white border border-neutral-300 text-black placeholder-neutral-400 focus:outline-none focus:border-black text-sm"
                            placeholder="main"
                        />
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
                    </div>

                    {/* multi-service toggle */}
                    <div class="border-t border-neutral-100 pt-6">
                        <label class="flex items-center gap-3 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={useMultiService()}
                                onChange={(e) => {
                                    setUseMultiService(e.currentTarget.checked);
                                    if (e.currentTarget.checked && services().length === 0) {
                                        addService();
                                    }
                                }}
                                class="w-4 h-4"
                            />
                            <div>
                                <span class="text-sm text-black">multi-container app</span>
                                <p class="text-xs text-neutral-400">
                                    deploy multiple services with dependencies
                                </p>
                            </div>
                        </label>
                    </div>

                    {/* single container mode */}
                    <Show when={!useMultiService()}>
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
                    </Show>

                    {/* multi-service mode */}
                    <Show when={useMultiService()}>
                        <div>
                            <div class="flex justify-between items-center mb-4">
                                <label class="text-sm text-neutral-600">services</label>
                                <button
                                    type="button"
                                    onClick={addService}
                                    class="px-3 py-1 text-xs border border-neutral-300 text-neutral-700 hover:border-neutral-400"
                                >
                                    + add service
                                </button>
                            </div>

                            <For each={services()}>
                                {(service, index) => (
                                    <ServiceForm
                                        service={service}
                                        index={index()}
                                        allServices={services()}
                                        onUpdate={updateService}
                                        onRemove={removeService}
                                    />
                                )}
                            </For>

                            <Show when={services().length === 0}>
                                <div class="text-center py-8 text-neutral-400 text-sm border border-dashed border-neutral-200">
                                    no services added. click "add service" to start.
                                </div>
                            </Show>
                        </div>
                    </Show>

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
