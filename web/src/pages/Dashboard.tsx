import { Component, createResource, For, Show } from 'solid-js';
import { A } from '@solidjs/router';

interface App {
    id: string;
    name: string;
    github_url: string;
    branch: string;
    domain: string | null;
    port: number;
    created_at: string;
}

/**
 * fetches apps from the api
 */
const fetchApps = async (): Promise<App[]> => {
    const token = localStorage.getItem('znskr_token');
    const res = await fetch('/api/apps', {
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });

    if (!res.ok) {
        if (res.status === 401) {
            localStorage.removeItem('znskr_token');
            window.location.href = '/login';
        }
        throw new Error('failed to fetch apps');
    }

    return res.json();
};

/**
 * dashboard page showing all apps
 */
const Dashboard: Component = () => {
    const [apps] = createResource(fetchApps);

    return (
        <div>
            {/* header */}
            <div class="flex justify-between items-center mb-8">
                <div>
                    <h1 class="text-2xl font-bold text-white">your apps</h1>
                    <p class="text-gray-400 mt-1">manage your deployed applications</p>
                </div>
                <A
                    href="/apps/new"
                    class="px-4 py-2 bg-primary-600 text-white font-medium hover:bg-primary-700 transition-colors flex items-center gap-2"
                >
                    <svg
                        class="w-5 h-5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M12 4v16m8-8H4"
                        />
                    </svg>
                    new app
                </A>
            </div>

            {/* loading state */}
            <Show when={apps.loading}>
                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    <For each={[1, 2, 3]}>
                        {() => (
                            <div class="bg-gray-900 border border-gray-800 p-6 animate-pulse">
                                <div class="h-6 bg-gray-800 w-3/4 mb-4"></div>
                                <div class="h-4 bg-gray-800 w-1/2 mb-2"></div>
                                <div class="h-4 bg-gray-800 w-2/3"></div>
                            </div>
                        )}
                    </For>
                </div>
            </Show>

            {/* empty state */}
            <Show when={!apps.loading && apps()?.length === 0}>
                <div class="bg-gray-900 border border-gray-800 p-12 text-center">
                    <svg
                        class="w-16 h-16 mx-auto text-gray-600 mb-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="1.5"
                            d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                        />
                    </svg>
                    <h3 class="text-lg font-medium text-white mb-2">no apps yet</h3>
                    <p class="text-gray-400 mb-6">
                        deploy your first app from a github repository
                    </p>
                    <A
                        href="/apps/new"
                        class="inline-flex items-center gap-2 px-4 py-2 bg-primary-600 text-white hover:bg-primary-700 transition-colors"
                    >
                        <svg
                            class="w-5 h-5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M12 4v16m8-8H4"
                            />
                        </svg>
                        deploy new app
                    </A>
                </div>
            </Show>

            {/* apps grid */}
            <Show when={!apps.loading && apps() && apps()!.length > 0}>
                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    <For each={apps()}>
                        {(app) => (
                            <A
                                href={`/apps/${app.id}`}
                                class="bg-gray-900 border border-gray-800 p-6 hover:border-gray-700 transition-colors group"
                            >
                                {/* status indicator */}
                                <div class="flex items-center gap-2 mb-4">
                                    <span class="w-2 h-2 bg-green-500"></span>
                                    <span class="text-sm text-green-400">running</span>
                                </div>

                                {/* app name */}
                                <h3 class="text-lg font-semibold text-white group-hover:text-primary-400 transition-colors">
                                    {app.name}
                                </h3>

                                {/* github url */}
                                <p class="text-gray-400 text-sm mt-2 truncate">{app.github_url}</p>

                                {/* domain */}
                                <Show when={app.domain}>
                                    <div class="mt-4 flex items-center gap-2 text-sm">
                                        <svg
                                            class="w-4 h-4 text-gray-500"
                                            fill="none"
                                            stroke="currentColor"
                                            viewBox="0 0 24 24"
                                        >
                                            <path
                                                stroke-linecap="round"
                                                stroke-linejoin="round"
                                                stroke-width="2"
                                                d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
                                            />
                                        </svg>
                                        <span class="text-primary-400">{app.domain}</span>
                                    </div>
                                </Show>

                                {/* branch */}
                                <div class="mt-4 flex items-center gap-2 text-sm text-gray-500">
                                    <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                                    </svg>
                                    <span>{app.branch}</span>
                                </div>
                            </A>
                        )}
                    </For>
                </div>
            </Show>
        </div>
    );
};

export default Dashboard;
