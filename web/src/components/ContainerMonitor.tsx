import { Component, createEffect, createMemo, createResource, createSignal, For, Show } from 'solid-js';

interface ContainerStatus {
    status: string;
    health_status: string | null;
    started_at: string | null;
    finished_at: string | null;
    restart_count: number;
    cpu_percent: number;
    mem_usage_bytes: number;
    mem_limit_bytes: number;
}

interface ContainerMount {
    destination: string;
    mount_type: string;
    name: string | null;
    read_only: boolean;
}

interface VolumeEntry {
    name: string;
    path: string;
    is_dir: boolean;
    size_bytes: number;
    modified_at: string | null;
}

const formatBytes = (bytes: number) => {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, idx)).toFixed(1)} ${units[idx]}`;
};

const ansiColors: Record<string, string> = {
    '30': '#000', '31': '#e74c3c', '32': '#2ecc71', '33': '#f1c40f',
    '34': '#3498db', '35': '#9b59b6', '36': '#1abc9c', '37': '#ecf0f1',
    '90': '#7f8c8d', '91': '#e74c3c', '92': '#2ecc71', '93': '#f1c40f',
    '94': '#3498db', '95': '#9b59b6', '96': '#1abc9c', '97': '#fff',
};

const ansiToHtml = (text: string): string => {
    let result = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    
    result = result.replace(/\x1b\[([0-9;]*)m/g, (_, codes) => {
        if (!codes || codes === '0') return '</span>';
        const parts = codes.split(';');
        const styles: string[] = [];
        for (const code of parts) {
            if (code === '1') styles.push('font-weight:bold');
            else if (code === '3') styles.push('font-style:italic');
            else if (code === '4') styles.push('text-decoration:underline');
            else if (ansiColors[code]) styles.push(`color:${ansiColors[code]}`);
        }
        return styles.length ? `<span style="${styles.join(';')}">` : '';
    });
    
    return result;
};

const formatUptime = (startedAt: string | null) => {
    if (!startedAt) return 'n/a';
    const start = new Date(startedAt).getTime();
    if (!start) return 'n/a';
    const diff = Math.max(Date.now() - start, 0);
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
};

const fetchStatus = async (id: string): Promise<ContainerStatus> => {
    const token = localStorage.getItem('znskr_token');
    const res = await fetch(`/api/containers/${id}/status`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        throw new Error('failed to fetch status');
    }
    return res.json();
};

const fetchLogs = async (id: string): Promise<string> => {
    const token = localStorage.getItem('znskr_token');
    const res = await fetch(`/api/containers/${id}/logs?tail=200`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        throw new Error('failed to fetch logs');
    }
    const data = await res.json();
    return data.logs || '';
};

const fetchMounts = async (id: string): Promise<ContainerMount[]> => {
    const token = localStorage.getItem('znskr_token');
    const res = await fetch(`/api/containers/${id}/mounts`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        throw new Error('failed to fetch mounts');
    }
    return res.json();
};

const fetchEntries = async (id: string, mount: string, path: string): Promise<VolumeEntry[]> => {
    const token = localStorage.getItem('znskr_token');
    const params = new URLSearchParams({ mount });
    if (path) params.set('path', path);
    const res = await fetch(`/api/containers/${id}/files?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        throw new Error('failed to fetch files');
    }
    return res.json();
};

const ContainerMonitor: Component<{ containerId: string; defaultTab?: 'overview' | 'metrics' | 'logs' | 'volumes' }> = (props) => {
    const [tab, setTab] = createSignal<'overview' | 'metrics' | 'logs' | 'volumes'>(props.defaultTab || 'overview');
    const [status, { refetch: refetchStatus }] = createResource(
        () => props.containerId,
        fetchStatus
    );
    const [logs, { refetch: refetchLogs }] = createResource(
        () => props.containerId,
        fetchLogs
    );
    const [mounts, { refetch: refetchMounts }] = createResource(
        () => props.containerId,
        fetchMounts
    );
    const [selectedMount, setSelectedMount] = createSignal('');
    const [currentPath, setCurrentPath] = createSignal('');
    const [newFolderName, setNewFolderName] = createSignal('');

    const [entries, entriesActions] = createResource(
        () => {
            const mount = selectedMount();
            if (!mount) return null;
            return { id: props.containerId, mount, path: currentPath() };
        },
        (args) => fetchEntries(args.id, args.mount, args.path)
    );

    const refetchEntries = () => entriesActions.refetch();

    const mountOptions = createMemo(() => mounts() || []);

    createEffect(() => {
        props.containerId;
        setTab(props.defaultTab || 'overview');
        setSelectedMount('');
        setCurrentPath('');
    });

    createEffect(() => {
        if (!selectedMount() && mountOptions().length > 0) {
            setSelectedMount(mountOptions()[0].destination);
        }
    });

    const handleCreateFolder = async () => {
        const name = newFolderName().trim();
        if (!name || !selectedMount()) return;
        const token = localStorage.getItem('znskr_token');
        const folderPath = currentPath() ? `${currentPath()}/${name}` : name;
        const params = new URLSearchParams({ mount: selectedMount(), path: folderPath });
        await fetch(`/api/containers/${props.containerId}/files/mkdir?${params.toString()}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
        });
        setNewFolderName('');
        refetchEntries();
    };

    const handleUpload = async (files: FileList | null) => {
        if (!files || !selectedMount()) return;
        const token = localStorage.getItem('znskr_token');
        const params = new URLSearchParams({ mount: selectedMount() });
        if (currentPath()) params.set('path', currentPath());
        const form = new FormData();
        Array.from(files).forEach((file) => {
            form.append('file', file, file.name);
        });
        await fetch(`/api/containers/${props.containerId}/files/upload?${params.toString()}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: form,
        });
        refetchEntries();
    };

    const handleDelete = async (entry: VolumeEntry) => {
        if (!selectedMount()) return;
        if (!confirm(`delete ${entry.name}?`)) return;
        const token = localStorage.getItem('znskr_token');
        const params = new URLSearchParams({ mount: selectedMount(), path: entry.path });
        await fetch(`/api/containers/${props.containerId}/files?${params.toString()}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
        });
        refetchEntries();
    };

    const handleDownload = (entry: VolumeEntry) => {
        if (entry.is_dir || !selectedMount()) return;
        const params = new URLSearchParams({ mount: selectedMount(), path: entry.path });
        window.open(`/api/containers/${props.containerId}/files/download?${params.toString()}`, '_blank');
    };

    const pathSegments = createMemo(() => {
        const path = currentPath();
        if (!path) return [];
        return path.split('/').filter(Boolean);
    });

    return (
        <div class="border border-neutral-200 p-5">
            <div class="flex items-center justify-between mb-4">
                <div>
                    <p class="text-xs text-neutral-400">container</p>
                    <p class="text-sm font-mono text-neutral-700">{props.containerId}</p>
                </div>
                <button
                    onClick={() => {
                        refetchStatus();
                        refetchLogs();
                        refetchMounts();
                        refetchEntries();
                    }}
                    class="px-3 py-1 text-xs border border-neutral-300 text-neutral-700 hover:border-neutral-400"
                >
                    refresh
                </button>
            </div>

            <div class="flex gap-2 mb-4 text-xs">
                {(['overview', 'metrics', 'logs', 'volumes'] as const).map((name) => (
                    <button
                        onClick={() => setTab(name)}
                        class={`px-2.5 py-1 border ${tab() === name ? 'bg-black text-white border-black' : 'bg-white text-neutral-600 border-neutral-300 hover:border-neutral-400'}`}
                    >
                        {name}
                    </button>
                ))}
            </div>

            <Show when={tab() === 'overview'}>
                <div class="grid grid-cols-2 gap-4 text-sm">
                    <div>
                        <p class="text-xs text-neutral-400">status</p>
                        <p class="text-neutral-800">{status()?.status || 'n/a'}</p>
                    </div>
                    <div>
                        <p class="text-xs text-neutral-400">health</p>
                        <p class="text-neutral-800">{status()?.health_status || 'none'}</p>
                    </div>
                    <div>
                        <p class="text-xs text-neutral-400">uptime</p>
                        <p class="text-neutral-800">{formatUptime(status()?.started_at || null)}</p>
                    </div>
                    <div>
                        <p class="text-xs text-neutral-400">restarts</p>
                        <p class="text-neutral-800">{status()?.restart_count ?? 0}</p>
                    </div>
                </div>
            </Show>

            <Show when={tab() === 'metrics'}>
                <div class="grid grid-cols-2 gap-4 text-sm">
                    <div>
                        <p class="text-xs text-neutral-400">cpu</p>
                        <p class="text-neutral-800">{status() ? `${status()!.cpu_percent.toFixed(2)}%` : 'n/a'}</p>
                    </div>
                    <div>
                        <p class="text-xs text-neutral-400">memory</p>
                        <p class="text-neutral-800">
                            {status()
                                ? `${formatBytes(status()!.mem_usage_bytes)} / ${formatBytes(status()!.mem_limit_bytes)}`
                                : 'n/a'}
                        </p>
                    </div>
                </div>
            </Show>

            <Show when={tab() === 'logs'}>
                <div
                    class="bg-black text-white text-xs font-mono p-4 h-64 overflow-auto whitespace-pre-wrap"
                    innerHTML={ansiToHtml(logs() || 'no logs')}
                />
            </Show>

            <Show when={tab() === 'volumes'}>
                <div class="space-y-4">
                    <div class="flex items-center gap-3">
                        <select
                            value={selectedMount()}
                            onChange={(e) => {
                                setSelectedMount(e.currentTarget.value);
                                setCurrentPath('');
                            }}
                            class="px-2 py-1.5 border border-neutral-300 text-xs text-neutral-700"
                        >
                            <option value="">select mount</option>
                            <For each={mountOptions()}>
                                {(mount) => (
                                    <option value={mount.destination}>
                                        {mount.destination} ({mount.mount_type})
                                    </option>
                                )}
                            </For>
                        </select>
                        <Show when={selectedMount()}>
                            <label class="px-3 py-1 text-xs border border-neutral-300 text-neutral-700 hover:border-neutral-400 cursor-pointer">
                                upload
                                <input
                                    type="file"
                                    class="hidden"
                                    multiple
                                    onChange={(e) => handleUpload(e.currentTarget.files)}
                                />
                            </label>
                            <div class="flex items-center gap-2">
                                <input
                                    type="text"
                                    placeholder="folder name"
                                    value={newFolderName()}
                                    onInput={(e) => setNewFolderName(e.currentTarget.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
                                    class="px-2 py-1 border border-neutral-300 text-xs text-neutral-700 w-32"
                                />
                                <button
                                    onClick={handleCreateFolder}
                                    class="px-3 py-1 text-xs border border-neutral-300 text-neutral-700 hover:border-neutral-400"
                                >
                                    create folder
                                </button>
                            </div>
                        </Show>
                    </div>

                    <Show when={selectedMount()}>
                        <div class="text-xs text-neutral-500">
                            <span>path:</span>
                            <button
                                onClick={() => setCurrentPath('')}
                                class="ml-2 text-neutral-700 hover:underline"
                            >
                                /
                            </button>
                            <For each={pathSegments()}>
                                {(segment, idx) => (
                                    <button
                                        onClick={() => {
                                            const parts = pathSegments().slice(0, idx() + 1);
                                            setCurrentPath(parts.join('/'));
                                        }}
                                        class="ml-2 text-neutral-700 hover:underline"
                                    >
                                        {segment}
                                    </button>
                                )}
                            </For>
                        </div>

                        <Show when={entries.loading}>
                            <div class="text-xs text-neutral-400">loading files...</div>
                        </Show>

                        <div class="border border-neutral-200">
                            <For each={entries() || []}>
                                {(entry) => (
                                    <div class="flex items-center justify-between px-3 py-2 border-b border-neutral-100 text-sm">
                                        <button
                                            onClick={() => {
                                                if (entry.is_dir) setCurrentPath(entry.path);
                                            }}
                                            class={`text-left flex-1 ${entry.is_dir ? 'text-black' : 'text-neutral-700'}`}
                                        >
                                            {entry.is_dir ? '[dir]' : '[file]'} {entry.name}
                                        </button>
                                        <div class="flex items-center gap-3 text-xs text-neutral-500">
                                            <span>{entry.is_dir ? 'folder' : formatBytes(entry.size_bytes)}</span>
                                            <button
                                                onClick={() => handleDownload(entry)}
                                                class={`border border-neutral-300 px-2 py-0.5 ${entry.is_dir ? 'text-neutral-300 cursor-not-allowed' : 'text-neutral-700 hover:border-neutral-400'}`}
                                                disabled={entry.is_dir}
                                            >
                                                download
                                            </button>
                                            <button
                                                onClick={() => handleDelete(entry)}
                                                class="border border-neutral-300 px-2 py-0.5 text-neutral-700 hover:border-neutral-400"
                                            >
                                                delete
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </For>
                            <Show when={entries() && entries()!.length === 0}>
                                <div class="px-3 py-4 text-xs text-neutral-400">empty folder</div>
                            </Show>
                        </div>
                    </Show>
                </div>
            </Show>
        </div>
    );
};

export default ContainerMonitor;
