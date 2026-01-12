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
    env_vars: { key: string; value: string; secret: boolean }[];
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

interface CertificateStatus {
    domain: string;
    status: 'none' | 'pending' | 'valid' | 'expiringsoon' | 'expired' | 'failed';
    expires_at: string | null;
    issued_at: string | null;
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
 * fetches certificate status for an app
 */
const fetchCertificate = async (appId: string): Promise<CertificateStatus> => {
    const token = localStorage.getItem('znskr_token');
    const res = await fetch(`/api/apps/${appId}/certificate`, {
        headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
        throw new Error('failed to fetch certificate');
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

    const [certificate, { refetch: refetchCertificate }] = createResource(
        () => params.id,
        fetchCertificate
    );

    const [reissuing, setReissuing] = createSignal(false);

    const reissueCertificate = async () => {
        setReissuing(true);
        try {
            const token = localStorage.getItem('znskr_token');
            const res = await fetch(`/api/apps/${params.id}/certificate/reissue`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
            });

            if (!res.ok) {
                throw new Error('failed to trigger certificate reissue');
            }

            refetchCertificate();
        } catch (err) {
            console.error(err);
        } finally {
            setReissuing(false);
        }
    };

    // Edit form state
    const [editing, setEditing] = createSignal(false);
    const [saving, setSaving] = createSignal(false);
    const [editForm, setEditForm] = createSignal({
        domain: '',
        port: 8080,
        github_url: '',
        branch: 'main',
        env_vars: [] as { key: string; value: string; secret: boolean }[],
    });

    const openEditModal = () => {
        const currentApp = app();
        if (currentApp) {
            setEditForm({
                domain: currentApp.domain || '',
                port: currentApp.port,
                github_url: currentApp.github_url,
                branch: currentApp.branch,
                env_vars: currentApp.env_vars ? currentApp.env_vars.map(e => ({ ...e })) : [],
            });
            setEditing(true);
        }
    };

    const updateApp = async () => {
        setSaving(true);
        try {
            const token = localStorage.getItem('znskr_token');
            const form = editForm();
            const res = await fetch(`/api/apps/${params.id}`, {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    domain: form.domain || null,
                    port: form.port,
                    github_url: form.github_url,
                    branch: form.branch,
                    env_vars: form.env_vars,
                }),
            });

            if (!res.ok) {
                throw new Error('failed to update app');
            }

            setEditing(false);
            refetchApp();
            refetchCertificate();
        } catch (err) {
            console.error(err);
        } finally {
            setSaving(false);
        }
    };

    // Logs state
    const [logs, setLogs] = createSignal<string[]>([]);
    const [logsConnected, setLogsConnected] = createSignal(false);
    const [showLogs, setShowLogs] = createSignal(false);
    let logsSocket: WebSocket | null = null;
    let logsRef: HTMLDivElement | undefined;

    const connectLogs = () => {
        // Check if we're in browser context
        if (typeof window === 'undefined') return;

        try {
            if (logsSocket) {
                logsSocket.close();
            }

            setLogs([]);
            setLogsConnected(false);

            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/api/apps/${params.id}/logs/ws?tail=100`;

            console.log('[WebSocket] Connecting to:', wsUrl);
            setLogs(['Connecting to ' + wsUrl + '...']);

            logsSocket = new WebSocket(wsUrl);

            logsSocket.onopen = () => {
                console.log('[WebSocket] Connected successfully');
                setLogsConnected(true);
                setLogs(prev => [...prev, '[connected]']);
            };

            logsSocket.onmessage = (event) => {
                console.log('[WebSocket] Message:', event.data);
                setLogs(prev => [...prev, event.data]);
                // Auto-scroll to bottom
                if (logsRef) {
                    logsRef.scrollTop = logsRef.scrollHeight;
                }
            };

            logsSocket.onclose = (event) => {
                console.log('[WebSocket] Closed:', event.code, event.reason);
                setLogsConnected(false);
                setLogs(prev => [...prev, `[disconnected: ${event.code} ${event.reason || 'no reason'}]`]);
            };

            logsSocket.onerror = (error) => {
                console.error('[WebSocket] Error:', error);
                setLogsConnected(false);
                setLogs(prev => [...prev, '[error occurred]']);
            };
        } catch (err) {
            console.error('Failed to connect to logs:', err);
            setLogsConnected(false);
            setLogs([`Error: ${err}`]);
        }
    };

    const disconnectLogs = () => {
        if (logsSocket) {
            logsSocket.close();
            logsSocket = null;
        }
        setLogsConnected(false);
    };

    const toggleLogs = () => {
        if (showLogs()) {
            disconnectLogs();
            setShowLogs(false);
        } else {
            setShowLogs(true);
            connectLogs();
        }
    };

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
                            onClick={openEditModal}
                            class="px-4 py-2 bg-gray-700 text-white hover:bg-gray-600 transition-colors"
                        >
                            settings
                        </button>
                        <button
                            onClick={toggleLogs}
                            class={`px-4 py-2 text-white transition-colors ${showLogs() ? 'bg-blue-600 hover:bg-blue-700' : 'bg-gray-700 hover:bg-gray-600'}`}
                        >
                            {showLogs() ? 'hide logs' : 'view logs'}
                        </button>
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
                <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
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

                    {/* certificate status */}
                    <div class="bg-gray-900 border border-gray-800 p-6">
                        <h3 class="text-sm font-medium text-gray-400 mb-2">ssl certificate</h3>
                        <Show when={certificate.loading}>
                            <span class="text-gray-500">loading...</span>
                        </Show>
                        <Show when={!certificate.loading && certificate()}>
                            <div class="flex items-center justify-between">
                                <div class="flex items-center gap-2">
                                    {/* status badge */}
                                    <Show when={certificate()!.status === 'valid'}>
                                        <span class="w-2 h-2 bg-green-500"></span>
                                        <span class="text-green-400">valid</span>
                                    </Show>
                                    <Show when={certificate()!.status === 'expiringsoon'}>
                                        <span class="w-2 h-2 bg-yellow-500"></span>
                                        <span class="text-yellow-400">expiring soon</span>
                                    </Show>
                                    <Show when={certificate()!.status === 'expired'}>
                                        <span class="w-2 h-2 bg-red-500"></span>
                                        <span class="text-red-400">expired</span>
                                    </Show>
                                    <Show when={certificate()!.status === 'pending'}>
                                        <span class="w-2 h-2 bg-blue-500 animate-pulse"></span>
                                        <span class="text-blue-400">pending</span>
                                    </Show>
                                    <Show when={certificate()!.status === 'failed'}>
                                        <span class="w-2 h-2 bg-red-500"></span>
                                        <span class="text-red-400">failed</span>
                                    </Show>
                                    <Show when={certificate()!.status === 'none'}>
                                        <span class="w-2 h-2 bg-gray-500"></span>
                                        <span class="text-gray-400">none</span>
                                    </Show>
                                </div>
                                <Show when={app()!.domain && certificate()!.status !== 'pending'}>
                                    <button
                                        onClick={reissueCertificate}
                                        disabled={reissuing()}
                                        class="text-xs text-primary-400 hover:text-primary-300 disabled:opacity-50"
                                    >
                                        {reissuing() ? '...' : 'reissue'}
                                    </button>
                                </Show>
                            </div>
                            <Show when={certificate()!.expires_at}>
                                <p class="text-xs text-gray-500 mt-1">
                                    expires: {new Date(certificate()!.expires_at!).toLocaleDateString()}
                                </p>
                            </Show>
                        </Show>
                    </div>
                </div>

                {/* Live Logs Panel */}
                <Show when={showLogs()}>
                    <div class="bg-gray-900 border border-gray-800 mb-8">
                        <div class="border-b border-gray-800 px-6 py-4 flex justify-between items-center">
                            <div class="flex items-center gap-3">
                                <h2 class="text-lg font-semibold text-white">container logs</h2>
                                <div class="flex items-center gap-2">
                                    <span class={`w-2 h-2 ${logsConnected() ? 'bg-green-500' : 'bg-red-500'}`}></span>
                                    <span class="text-xs text-gray-400">
                                        {logsConnected() ? 'connected' : 'disconnected'}
                                    </span>
                                </div>
                            </div>
                            <button
                                onClick={() => setLogs([])}
                                class="text-sm text-gray-400 hover:text-white"
                            >
                                clear
                            </button>
                        </div>
                        <div
                            ref={logsRef}
                            class="p-4 h-80 overflow-y-auto font-mono text-sm bg-black"
                        >
                            <Show when={logs().length === 0}>
                                <p class="text-gray-500">
                                    {logsConnected() ? 'waiting for logs...' : 'connecting...'}
                                </p>
                            </Show>
                            <For each={logs()}>
                                {(line) => (
                                    <div class="text-gray-300 leading-relaxed whitespace-pre-wrap break-all">{line}</div>
                                )}
                            </For>
                        </div>
                    </div>
                </Show>

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

            {/* Edit Modal */}
            <Show when={editing()}>
                <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                    <div class="bg-gray-900 border border-gray-700 p-6 w-full max-w-md">
                        <h2 class="text-xl font-bold text-white mb-6">App Settings</h2>

                        <div class="space-y-4">
                            <div>
                                <label class="block text-sm font-medium text-gray-400 mb-1">GitHub URL</label>
                                <input
                                    type="text"
                                    value={editForm().github_url}
                                    onInput={(e) => setEditForm(prev => ({ ...prev, github_url: e.currentTarget.value }))}
                                    class="w-full px-3 py-2 bg-gray-800 border border-gray-700 text-white focus:border-primary-500 focus:outline-none"
                                    placeholder="https://github.com/user/repo"
                                />
                            </div>

                            <div>
                                <label class="block text-sm font-medium text-gray-400 mb-1">Branch</label>
                                <input
                                    type="text"
                                    value={editForm().branch}
                                    onInput={(e) => setEditForm(prev => ({ ...prev, branch: e.currentTarget.value }))}
                                    class="w-full px-3 py-2 bg-gray-800 border border-gray-700 text-white focus:border-primary-500 focus:outline-none"
                                    placeholder="main"
                                />
                            </div>

                            <div>
                                <label class="block text-sm font-medium text-gray-400 mb-1">Domain (optional)</label>
                                <input
                                    type="text"
                                    value={editForm().domain}
                                    onInput={(e) => setEditForm(prev => ({ ...prev, domain: e.currentTarget.value }))}
                                    class="w-full px-3 py-2 bg-gray-800 border border-gray-700 text-white focus:border-primary-500 focus:outline-none"
                                    placeholder="app.example.com"
                                />
                            </div>

                            <div>
                                <label class="block text-sm font-medium text-gray-400 mb-1">Port</label>
                                <input
                                    type="number"
                                    value={editForm().port}
                                    onInput={(e) => setEditForm(prev => ({ ...prev, port: parseInt(e.currentTarget.value) || 8080 }))}
                                    class="w-full px-3 py-2 bg-gray-800 border border-gray-700 text-white focus:border-primary-500 focus:outline-none"
                                    placeholder="8080"
                                />
                            </div>
                        </div>

                        <div>
                            <div class="flex justify-between items-center mb-2">
                                <label class="block text-sm font-medium text-gray-400">Environment Variables</label>
                                <button
                                    onClick={() => setEditForm(prev => ({
                                        ...prev,
                                        env_vars: [...prev.env_vars, { key: '', value: '', secret: false }]
                                    }))}
                                    class="text-xs text-primary-400 hover:text-primary-300"
                                >
                                    + add variable
                                </button>
                            </div>
                            <div class="space-y-3">
                                <For each={editForm().env_vars}>
                                    {(env, i) => (
                                        <div class="flex items-start gap-2 bg-gray-800 p-2 border border-gray-700">
                                            <div class="flex-1 space-y-2">
                                                <input
                                                    type="text"
                                                    placeholder="KEY"
                                                    value={env.key}
                                                    onInput={(e) => {
                                                        const newVars = [...editForm().env_vars];
                                                        newVars[i()] = { ...newVars[i()], key: e.currentTarget.value };
                                                        setEditForm(prev => ({ ...prev, env_vars: newVars }));
                                                    }}
                                                    class="w-full px-2 py-1 bg-black border border-gray-700 text-white text-sm focus:border-primary-500 focus:outline-none"
                                                />
                                                <input
                                                    type="text"
                                                    placeholder="VALUE"
                                                    value={env.value}
                                                    onInput={(e) => {
                                                        const newVars = [...editForm().env_vars];
                                                        newVars[i()] = { ...newVars[i()], value: e.currentTarget.value };
                                                        setEditForm(prev => ({ ...prev, env_vars: newVars }));
                                                    }}
                                                    class="w-full px-2 py-1 bg-black border border-gray-700 text-white text-sm focus:border-primary-500 focus:outline-none"
                                                />
                                                <label class="flex items-center gap-2 cursor-pointer">
                                                    <input
                                                        type="checkbox"
                                                        checked={env.secret}
                                                        onChange={(e) => {
                                                            const newVars = [...editForm().env_vars];
                                                            newVars[i()] = { ...newVars[i()], secret: e.currentTarget.checked };
                                                            setEditForm(prev => ({ ...prev, env_vars: newVars }));
                                                        }}
                                                        class="form-checkbox h-3 w-3 text-primary-600 bg-gray-900 border-gray-700 rounded focus:ring-primary-500"
                                                    />
                                                    <span class="text-xs text-gray-400">secret</span>
                                                </label>
                                            </div>
                                            <button
                                                onClick={() => {
                                                    const newVars = [...editForm().env_vars];
                                                    newVars.splice(i(), 1);
                                                    setEditForm(prev => ({ ...prev, env_vars: newVars }));
                                                }}
                                                class="text-red-500 hover:text-red-400 p-1"
                                                title="remove"
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                                                </svg>
                                            </button>
                                        </div>
                                    )}
                                </For>
                                <Show when={editForm().env_vars.length === 0}>
                                    <p class="text-xs text-gray-500 text-center py-2 border border-dashed border-gray-700">
                                        no environment variables
                                    </p>
                                </Show>
                            </div>
                        </div>

                        <div class="flex gap-3 mt-6">
                            <button
                                onClick={() => setEditing(false)}
                                class="flex-1 px-4 py-2 bg-gray-700 text-white hover:bg-gray-600 transition-colors"
                            >
                                cancel
                            </button>
                            <button
                                onClick={updateApp}
                                disabled={saving()}
                                class="flex-1 px-4 py-2 bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 transition-colors"
                            >
                                {saving() ? 'saving...' : 'save changes'}
                            </button>
                        </div>
                    </div>
                </div>
            </Show >
        </div >
    );
};

export default AppDetail;
