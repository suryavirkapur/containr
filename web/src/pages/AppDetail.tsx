import { Component, createEffect, createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { useParams, useNavigate } from '@solidjs/router';
import { parseAnsi } from '../utils/ansi';
import ContainerMonitor from '../components/ContainerMonitor';

interface AppService {
    id: string;
    name: string;
    image: string;
    port: number;
    replicas: number;
    memory_limit_mb: number | null;
    cpu_limit: number | null;
    depends_on: string[];
    restart_policy: string;
}

interface App {
    id: string;
    name: string;
    github_url: string;
    branch: string;
    domain: string | null;
    port: number;
    created_at: string;
    env_vars: { key: string; value: string; secret: boolean }[];
    services: AppService[];
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

interface ContainerListItem {
    id: string;
    resource_type: string;
    resource_id: string;
    name: string;
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
 * fetches containers for the user
 */
const fetchContainers = async (): Promise<ContainerListItem[]> => {
    const token = localStorage.getItem('znskr_token');
    const res = await fetch('/api/containers', {
        headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
        throw new Error('failed to fetch containers');
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

    const [containers] = createResource(fetchContainers);
    const [selectedContainer, setSelectedContainer] = createSignal('');

    const appContainers = createMemo(() =>
        (containers() || []).filter(
            (item) => item.resource_type === 'app' && item.resource_id === params.id
        )
    );

    createEffect(() => {
        if (!selectedContainer() && appContainers().length > 0) {
            setSelectedContainer(appContainers()[0].id);
        }
    });

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
        if (typeof window === 'undefined') return;

        try {
            if (logsSocket) {
                logsSocket.close();
            }

            setLogs([]);
            setLogsConnected(false);

            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/api/apps/${params.id}/logs/ws?tail=100`;

            setLogs(['connecting...']);

            logsSocket = new WebSocket(wsUrl);

            logsSocket.onopen = () => {
                setLogsConnected(true);
                setLogs(prev => [...prev, '[connected]']);
            };

            logsSocket.onmessage = (event) => {
                setLogs(prev => [...prev, event.data]);
                if (logsRef) {
                    logsRef.scrollTop = logsRef.scrollHeight;
                }
            };

            logsSocket.onclose = (event) => {
                setLogsConnected(false);
                setLogs(prev => [...prev, `[disconnected: ${event.code}]`]);
            };

            logsSocket.onerror = () => {
                setLogsConnected(false);
                setLogs(prev => [...prev, '[error]']);
            };
        } catch (err) {
            setLogsConnected(false);
            setLogs([`error: ${err}`]);
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

    const statusIndicator = (status: string) => {
        switch (status) {
            case 'running':
                return 'bg-black';
            case 'pending':
            case 'cloning':
            case 'building':
            case 'starting':
                return 'bg-neutral-400 animate-pulse';
            case 'failed':
                return 'bg-neutral-300';
            case 'stopped':
                return 'bg-neutral-200';
            default:
                return 'bg-neutral-200';
        }
    };

    return (
        <div>
            {/* loading */}
            <Show when={app.loading}>
                <div class="animate-pulse">
                    <div class="h-7 bg-neutral-100 w-1/4 mb-3"></div>
                    <div class="h-4 bg-neutral-50 w-1/2 mb-10"></div>
                    <div class="border border-neutral-200 p-8">
                        <div class="h-5 bg-neutral-100 w-full mb-4"></div>
                        <div class="h-5 bg-neutral-50 w-3/4"></div>
                    </div>
                </div>
            </Show>

            {/* content */}
            <Show when={!app.loading && app()}>
                {/* header */}
                <div class="flex justify-between items-start mb-10">
                    <div>
                        <h1 class="text-2xl font-serif text-black">{app()!.name}</h1>
                        <p class="text-neutral-500 mt-1 text-sm font-mono">{app()!.github_url}</p>
                    </div>
                    <div class="flex gap-2">
                        <button
                            onClick={openEditModal}
                            class="px-3 py-1.5 border border-neutral-300 text-neutral-700 hover:text-black hover:border-neutral-400 transition-colors text-sm"
                        >
                            settings
                        </button>
                        <button
                            onClick={toggleLogs}
                            class={`px-3 py-1.5 border transition-colors text-sm ${showLogs() ? 'border-black text-black' : 'border-neutral-300 text-neutral-700 hover:text-black hover:border-neutral-400'}`}
                        >
                            {showLogs() ? 'hide logs' : 'logs'}
                        </button>
                        <button
                            onClick={triggerDeploy}
                            disabled={deploying()}
                            class="px-3 py-1.5 bg-black text-white hover:bg-neutral-800 disabled:opacity-50 transition-colors text-sm"
                        >
                            {deploying() ? 'deploying...' : 'deploy'}
                        </button>
                        <button
                            onClick={deleteApp}
                            disabled={deleting()}
                            class="px-3 py-1.5 border border-neutral-300 text-neutral-500 hover:text-black hover:border-neutral-400 disabled:opacity-50 transition-colors text-sm"
                        >
                            {deleting() ? 'deleting...' : 'delete'}
                        </button>
                    </div>
                </div>

                {/* info grid */}
                <div class="grid grid-cols-4 gap-px bg-neutral-200 mb-8">
                    {/* status */}
                    <div class="bg-white p-5">
                        <h3 class="text-xs text-neutral-500 uppercase tracking-wider mb-2">status</h3>
                        <div class="flex items-center gap-2">
                            <span class="w-2 h-2 bg-black"></span>
                            <span class="text-black text-sm">running</span>
                        </div>
                    </div>

                    {/* domain */}
                    <div class="bg-white p-5">
                        <h3 class="text-xs text-neutral-500 uppercase tracking-wider mb-2">domain</h3>
                        <Show
                            when={app()!.domain}
                            fallback={<span class="text-neutral-400 text-sm">n/a</span>}
                        >
                            <a
                                href={`https://${app()!.domain}`}
                                target="_blank"
                                class="text-black text-sm hover:underline"
                            >
                                {app()!.domain}
                            </a>
                        </Show>
                    </div>

                    {/* branch */}
                    <div class="bg-white p-5">
                        <h3 class="text-xs text-neutral-500 uppercase tracking-wider mb-2">branch</h3>
                        <span class="text-black text-sm font-mono">{app()!.branch}</span>
                    </div>

                    {/* certificate */}
                    <div class="bg-white p-5">
                        <h3 class="text-xs text-neutral-500 uppercase tracking-wider mb-2">ssl</h3>
                        <Show when={certificate.loading}>
                            <span class="text-neutral-400 text-sm">loading...</span>
                        </Show>
                        <Show when={!certificate.loading && certificate()}>
                            <div class="flex items-center justify-between">
                                <div class="flex items-center gap-2">
                                    <Show when={certificate()!.status === 'valid'}>
                                        <span class="w-2 h-2 bg-black"></span>
                                        <span class="text-black text-sm">valid</span>
                                    </Show>
                                    <Show when={certificate()!.status === 'expiringsoon'}>
                                        <span class="w-2 h-2 bg-neutral-400"></span>
                                        <span class="text-neutral-600 text-sm">expiring</span>
                                    </Show>
                                    <Show when={certificate()!.status === 'expired'}>
                                        <span class="w-2 h-2 bg-neutral-300"></span>
                                        <span class="text-neutral-500 text-sm">expired</span>
                                    </Show>
                                    <Show when={certificate()!.status === 'pending'}>
                                        <span class="w-2 h-2 bg-neutral-400 animate-pulse"></span>
                                        <span class="text-neutral-500 text-sm">pending</span>
                                    </Show>
                                    <Show when={certificate()!.status === 'failed'}>
                                        <span class="w-2 h-2 bg-neutral-300"></span>
                                        <span class="text-neutral-500 text-sm">failed</span>
                                    </Show>
                                    <Show when={certificate()!.status === 'none'}>
                                        <span class="text-neutral-400 text-sm">n/a</span>
                                    </Show>
                                </div>
                                <Show when={app()!.domain && certificate()!.status !== 'pending'}>
                                    <button
                                        onClick={reissueCertificate}
                                        disabled={reissuing()}
                                        class="text-xs text-neutral-500 hover:text-black disabled:opacity-50"
                                    >
                                        {reissuing() ? '...' : 'reissue'}
                                    </button>
                                </Show>
                            </div>
                        </Show>
                    </div>
                </div>

                {/* services section for multi-container apps */}
                <Show when={app()!.services && app()!.services.length > 0}>
                    <div class="border border-neutral-200 mb-8">
                        <div class="border-b border-neutral-200 px-5 py-3">
                            <h2 class="text-sm font-serif text-black">services</h2>
                        </div>
                        <div class="divide-y divide-neutral-100">
                            <For each={app()!.services}>
                                {(service) => (
                                    <div class="px-5 py-4">
                                        <div class="flex justify-between items-start">
                                            <div>
                                                <div class="flex items-center gap-3">
                                                    <span class="w-2 h-2 bg-black"></span>
                                                    <span class="text-black text-sm font-medium">{service.name}</span>
                                                    <span class="text-xs text-neutral-400">:{service.port}</span>
                                                </div>
                                                <Show when={service.image}>
                                                    <p class="text-xs text-neutral-500 mt-1 ml-5 font-mono">{service.image}</p>
                                                </Show>
                                            </div>
                                            <div class="flex items-center gap-4 text-xs text-neutral-500">
                                                <span>{service.replicas} replica{service.replicas > 1 ? 's' : ''}</span>
                                                <Show when={service.memory_limit_mb}>
                                                    <span>{service.memory_limit_mb}mb</span>
                                                </Show>
                                                <Show when={service.depends_on.length > 0}>
                                                    <span>→ {service.depends_on.join(', ')}</span>
                                                </Show>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </For>
                        </div>
                    </div>
                </Show>

                {/* logs panel */}
                <Show when={showLogs()}>
                    <div class="border border-neutral-200 mb-8">
                        <div class="border-b border-neutral-200 px-5 py-3 flex justify-between items-center">
                            <div class="flex items-center gap-3">
                                <h2 class="text-sm font-serif text-black">container logs</h2>
                                <div class="flex items-center gap-2">
                                    <span class={`w-1.5 h-1.5 ${logsConnected() ? 'bg-black' : 'bg-neutral-300'}`}></span>
                                    <span class="text-xs text-neutral-500">
                                        {logsConnected() ? 'live' : 'disconnected'}
                                    </span>
                                </div>
                            </div>
                            <button
                                onClick={() => setLogs([])}
                                class="text-xs text-neutral-500 hover:text-black"
                            >
                                clear
                            </button>
                        </div>
                        <div
                            ref={logsRef}
                            class="p-4 h-72 overflow-y-auto font-mono text-xs bg-neutral-50"
                        >
                            <Show when={logs().length === 0}>
                                <p class="text-neutral-400">
                                    {logsConnected() ? 'waiting for logs...' : 'connecting...'}
                                </p>
                            </Show>
                            <For each={logs()}>
                                {(line) => (
                                    <div class="text-neutral-700 leading-relaxed whitespace-pre-wrap break-all" innerHTML={parseAnsi(line)}></div>
                                )}
                            </For>
                        </div>
                    </div>
                </Show>

                {/* container monitor */}
                <div class="border border-neutral-200 mb-8">
                    <div class="border-b border-neutral-200 px-5 py-3 flex items-center justify-between">
                        <div>
                            <h2 class="text-sm font-serif text-black">container monitor</h2>
                            <p class="text-xs text-neutral-500 mt-1">health, metrics, logs, volumes</p>
                        </div>
                        <Show when={appContainers().length > 0}>
                            <select
                                value={selectedContainer()}
                                onChange={(e) => setSelectedContainer(e.currentTarget.value)}
                                class="px-2 py-1.5 border border-neutral-300 text-xs text-neutral-700"
                            >
                                <For each={appContainers()}>
                                    {(container) => (
                                        <option value={container.id}>{container.name}</option>
                                    )}
                                </For>
                            </select>
                        </Show>
                    </div>
                    <div class="p-5">
                        <Show when={appContainers().length > 0}>
                            <ContainerMonitor containerId={selectedContainer()} />
                        </Show>
                        <Show when={appContainers().length === 0}>
                            <div class="border border-dashed border-neutral-200 p-8 text-center text-neutral-400 text-sm">
                                no running containers for this app
                            </div>
                        </Show>
                    </div>
                </div>

                {/* deployments */}
                <div class="border border-neutral-200">
                    <div class="border-b border-neutral-200 px-5 py-3">
                        <h2 class="text-sm font-serif text-black">deployments</h2>
                    </div>

                    <Show when={deployments.loading}>
                        <div class="p-5 animate-pulse space-y-3">
                            <div class="h-10 bg-neutral-50"></div>
                            <div class="h-10 bg-neutral-50"></div>
                        </div>
                    </Show>

                    <Show when={!deployments.loading && deployments()?.length === 0}>
                        <div class="p-8 text-center text-neutral-400 text-sm">
                            no deployments yet
                        </div>
                    </Show>

                    <Show when={!deployments.loading && deployments() && deployments()!.length > 0}>
                        <div class="divide-y divide-neutral-200">
                            <For each={deployments()}>
                                {(deployment) => (
                                    <div class="px-5 py-4 flex items-center justify-between">
                                        <div class="flex items-center gap-4">
                                            <span class={`w-2 h-2 ${statusIndicator(deployment.status)}`}></span>
                                            <div>
                                                <p class="text-black font-mono text-sm">
                                                    {deployment.commit_sha.substring(0, 8)}
                                                </p>
                                                <p class="text-neutral-500 text-xs mt-0.5 truncate max-w-md">
                                                    {deployment.commit_message || 'no message'}
                                                </p>
                                            </div>
                                        </div>
                                        <div class="flex items-center gap-6 text-xs">
                                            <span class="text-neutral-500">{deployment.status}</span>
                                            <span class="text-neutral-400">
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

            {/* edit modal */}
            <Show when={editing()}>
                <div class="fixed inset-0 bg-white/90 flex items-center justify-center z-50">
                    <div class="bg-white border border-neutral-300 p-6 w-full max-w-md">
                        <h2 class="text-lg font-serif text-black mb-6">app settings</h2>

                        <div class="space-y-5">
                            <div>
                                <label class="block text-xs text-neutral-500 uppercase tracking-wider mb-2">github url</label>
                                <input
                                    type="text"
                                    value={editForm().github_url}
                                    onInput={(e) => setEditForm(prev => ({ ...prev, github_url: e.currentTarget.value }))}
                                    class="w-full px-3 py-2 bg-white border border-neutral-300 text-black focus:border-black focus:outline-none text-sm"
                                />
                            </div>

                            <div>
                                <label class="block text-xs text-neutral-500 uppercase tracking-wider mb-2">branch</label>
                                <input
                                    type="text"
                                    value={editForm().branch}
                                    onInput={(e) => setEditForm(prev => ({ ...prev, branch: e.currentTarget.value }))}
                                    class="w-full px-3 py-2 bg-white border border-neutral-300 text-black focus:border-black focus:outline-none text-sm"
                                />
                            </div>

                            <div>
                                <label class="block text-xs text-neutral-500 uppercase tracking-wider mb-2">domain</label>
                                <input
                                    type="text"
                                    value={editForm().domain}
                                    onInput={(e) => setEditForm(prev => ({ ...prev, domain: e.currentTarget.value }))}
                                    class="w-full px-3 py-2 bg-white border border-neutral-300 text-black focus:border-black focus:outline-none text-sm"
                                    placeholder="app.example.com"
                                />
                            </div>

                            <div>
                                <label class="block text-xs text-neutral-500 uppercase tracking-wider mb-2">port</label>
                                <input
                                    type="number"
                                    value={editForm().port}
                                    onInput={(e) => setEditForm(prev => ({ ...prev, port: parseInt(e.currentTarget.value) || 8080 }))}
                                    class="w-full px-3 py-2 bg-white border border-neutral-300 text-black focus:border-black focus:outline-none text-sm"
                                />
                            </div>
                        </div>

                        <div class="mt-6">
                            <div class="flex justify-between items-center mb-3">
                                <label class="text-xs text-neutral-500 uppercase tracking-wider">environment variables</label>
                                <button
                                    onClick={() => setEditForm(prev => ({
                                        ...prev,
                                        env_vars: [...prev.env_vars, { key: '', value: '', secret: false }]
                                    }))}
                                    class="text-xs text-neutral-500 hover:text-black"
                                >
                                    + add
                                </button>
                            </div>
                            <div class="space-y-2">
                                <For each={editForm().env_vars}>
                                    {(env, i) => (
                                        <div class="flex items-start gap-2 border border-neutral-200 p-2">
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
                                                    class="w-full px-2 py-1.5 bg-white border border-neutral-200 text-black text-xs focus:border-neutral-400 focus:outline-none font-mono"
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
                                                    class="w-full px-2 py-1.5 bg-white border border-neutral-200 text-black text-xs focus:border-neutral-400 focus:outline-none font-mono"
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
                                                        class="w-3 h-3 bg-white border border-neutral-300"
                                                    />
                                                    <span class="text-xs text-neutral-500">secret</span>
                                                </label>
                                            </div>
                                            <button
                                                onClick={() => {
                                                    const newVars = [...editForm().env_vars];
                                                    newVars.splice(i(), 1);
                                                    setEditForm(prev => ({ ...prev, env_vars: newVars }));
                                                }}
                                                class="text-neutral-400 hover:text-black p-1"
                                            >
                                                <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                                                </svg>
                                            </button>
                                        </div>
                                    )}
                                </For>
                                <Show when={editForm().env_vars.length === 0}>
                                    <p class="text-xs text-neutral-400 text-center py-3 border border-dashed border-neutral-200">
                                        no environment variables
                                    </p>
                                </Show>
                            </div>
                        </div>

                        <div class="flex gap-2 mt-8">
                            <button
                                onClick={() => setEditing(false)}
                                class="flex-1 px-4 py-2 border border-neutral-300 text-neutral-700 hover:text-black hover:border-neutral-400 transition-colors text-sm"
                            >
                                cancel
                            </button>
                            <button
                                onClick={updateApp}
                                disabled={saving()}
                                class="flex-1 px-4 py-2 bg-black text-white hover:bg-neutral-800 disabled:opacity-50 transition-colors text-sm"
                            >
                                {saving() ? 'saving...' : 'save'}
                            </button>
                        </div>
                    </div>
                </div>
            </Show>
        </div>
    );
};

export default AppDetail;
