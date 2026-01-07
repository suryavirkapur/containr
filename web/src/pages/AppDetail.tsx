import { Component, createResource, createSignal, For, Show } from 'solid-js';
import { useParams, useNavigate } from '@solidjs/router';

interface App {
    id: string;
    name: string;
    github_url: string;
    branch: string;
    domain: string | null;
    port: number;
    created_at: string;
}

interface Deployment {
    id: string;
    app_id: string;
    commit_sha: string;
    commit_message: string | null;
    status: string;
    container_id: string | null;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
}

/**
 * fetches app details
 */
const fetchApp = async (id: string): Promise<App> => {
    const token = localStorage.getItem('znskr_token');
    const res = await fetch(`/api/apps/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
        if (res.status === 401) {
            localStorage.removeItem('znskr_token');
            window.location.href = '/login';
        }
        throw new Error('failed to fetch app');
    }

    return res.json();
};

/**
 * fetches deployments for an app
 */
const fetchDeployments = async (appId: string): Promise<Deployment[]> => {
    const token = localStorage.getItem('znskr_token');
    const res = await fetch(`/api/apps/${appId}/deployments`, {
        headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
        throw new Error('failed to fetch deployments');
    }

    return res.json();
};

/**
 * app detail page
 */
const AppDetail: Component = () => {
    const params = useParams();
    const navigate = useNavigate();
    const [deploying, setDeploying] = createSignal(false);
    const [deleting, setDeleting] = createSignal(false);

    const [app, { refetch: refetchApp }] = createResource(
        () => params.id,
        fetchApp
    );

    const [deployments, { refetch: refetchDeployments }] = createResource(
        () => params.id,
        fetchDeployments
    );

    const triggerDeploy = async () => {
        setDeploying(true);
        try {
            const token = localStorage.getItem('znskr_token');
            const res = await fetch(`/api/apps/${params.id}/deployments`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
            });

            if (!res.ok) {
                throw new Error('failed to trigger deployment');
            }

            refetchDeployments();
        } catch (err) {
            console.error(err);
        } finally {
            setDeploying(false);
        }
    };

    const deleteApp = async () => {
        if (!confirm('are you sure you want to delete this app?')) {
            return;
        }

        setDeleting(true);
        try {
            const token = localStorage.getItem('znskr_token');
            const res = await fetch(`/api/apps/${params.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });

            if (!res.ok) {
                throw new Error('failed to delete app');
            }

            navigate('/');
        } catch (err) {
            console.error(err);
            setDeleting(false);
        }
    };

    const statusColor = (status: string) => {
        switch (status) {
            case 'running':
                return 'bg-green-500';
            case 'pending':
            case 'cloning':
            case 'building':
            case 'starting':
                return 'bg-yellow-500';
            case 'failed':
                return 'bg-red-500';
            case 'stopped':
                return 'bg-gray-500';
            default:
                return 'bg-gray-500';
        }
    };

    return (
        <div>
            {/* loading */}
            <Show when={app.loading}>
                <div class="animate-pulse">
                    <div class="h-8 bg-gray-800 w-1/4 mb-4"></div>
                    <div class="h-4 bg-gray-800 w-1/2 mb-8"></div>
                    <div class="bg-gray-900 border border-gray-800 p-8">
                        <div class="h-6 bg-gray-800 w-full mb-4"></div>
                        <div class="h-6 bg-gray-800 w-3/4"></div>
                    </div>
                </div>
            </Show>

            {/* content */}
            <Show when={!app.loading && app()}>
                {/* header */}
                <div class="flex justify-between items-start mb-8">
                    <div>
                        <h1 class="text-2xl font-bold text-white">{app()!.name}</h1>
                        <p class="text-gray-400 mt-1">{app()!.github_url}</p>
                    </div>
                    <div class="flex gap-3">
                        <button
                            onClick={triggerDeploy}
                            disabled={deploying()}
                            class="px-4 py-2 bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 transition-colors"
                        >
                            {deploying() ? 'deploying...' : 'deploy now'}
                        </button>
                        <button
                            onClick={deleteApp}
                            disabled={deleting()}
                            class="px-4 py-2 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
                        >
                            {deleting() ? 'deleting...' : 'delete'}
                        </button>
                    </div>
                </div>

                {/* info cards */}
                <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                    {/* status */}
                    <div class="bg-gray-900 border border-gray-800 p-6">
                        <h3 class="text-sm font-medium text-gray-400 mb-2">status</h3>
                        <div class="flex items-center gap-2">
                            <span class="w-2 h-2 bg-green-500"></span>
                            <span class="text-white">running</span>
                        </div>
                    </div>

                    {/* domain */}
                    <div class="bg-gray-900 border border-gray-800 p-6">
                        <h3 class="text-sm font-medium text-gray-400 mb-2">domain</h3>
                        <Show
                            when={app()!.domain}
                            fallback={<span class="text-gray-500">not configured</span>}
                        >
                            <a
                                href={`https://${app()!.domain}`}
                                target="_blank"
                                class="text-primary-400 hover:text-primary-300"
                            >
                                {app()!.domain}
                            </a>
                        </Show>
                    </div>

                    {/* branch */}
                    <div class="bg-gray-900 border border-gray-800 p-6">
                        <h3 class="text-sm font-medium text-gray-400 mb-2">branch</h3>
                        <span class="text-white">{app()!.branch}</span>
                    </div>
                </div>

                {/* deployments */}
                <div class="bg-gray-900 border border-gray-800">
                    <div class="border-b border-gray-800 px-6 py-4">
                        <h2 class="text-lg font-semibold text-white">deployments</h2>
                    </div>

                    <Show when={deployments.loading}>
                        <div class="p-6 animate-pulse">
                            <div class="h-12 bg-gray-800 mb-4"></div>
                            <div class="h-12 bg-gray-800 mb-4"></div>
                            <div class="h-12 bg-gray-800"></div>
                        </div>
                    </Show>

                    <Show when={!deployments.loading && deployments()?.length === 0}>
                        <div class="p-6 text-center text-gray-500">
                            no deployments yet. click "deploy now" to start.
                        </div>
                    </Show>

                    <Show when={!deployments.loading && deployments() && deployments()!.length > 0}>
                        <div class="divide-y divide-gray-800">
                            <For each={deployments()}>
                                {(deployment) => (
                                    <div class="px-6 py-4 flex items-center justify-between">
                                        <div class="flex items-center gap-4">
                                            {/* status */}
                                            <span
                                                class={`w-2 h-2 ${statusColor(deployment.status)}`}
                                            ></span>

                                            {/* commit */}
                                            <div>
                                                <p class="text-white font-mono text-sm">
                                                    {deployment.commit_sha.substring(0, 8)}
                                                </p>
                                                <p class="text-gray-400 text-sm truncate max-w-md">
                                                    {deployment.commit_message || 'no message'}
                                                </p>
                                            </div>
                                        </div>

                                        <div class="flex items-center gap-4">
                                            {/* status text */}
                                            <span class="text-sm text-gray-400">
                                                {deployment.status}
                                            </span>

                                            {/* time */}
                                            <span class="text-sm text-gray-500">
                                                {new Date(deployment.created_at).toLocaleString()}
                                            </span>
                                        </div>
                                    </div>
                                )}
                            </For>
                        </div>
                    </Show>
                </div>
            </Show>
        </div>
    );
};

export default AppDetail;
