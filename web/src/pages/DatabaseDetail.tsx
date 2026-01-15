import { Component, createEffect, createMemo, createResource, createSignal, Show } from 'solid-js';
import { useParams, A } from '@solidjs/router';
import ContainerMonitor from '../components/ContainerMonitor';

interface Database {
    id: string;
    name: string;
    db_type: string;
    version: string;
    status: string;
    internal_host: string;
    port: number;
    connection_string: string;
    username: string;
    memory_limit_mb: number;
    cpu_limit: number;
    created_at: string;
}

interface ContainerListItem {
    id: string;
    resource_type: string;
    resource_id: string;
    name: string;
}

const fetchDatabase = async (id: string): Promise<Database> => {
    const token = localStorage.getItem('znskr_token');
    const res = await fetch(`/api/databases/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        throw new Error('failed to fetch database');
    }
    return res.json();
};

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

const DatabaseDetail: Component = () => {
    const params = useParams();
    const [database] = createResource(() => params.id, fetchDatabase);
    const [containers] = createResource(fetchContainers);
    const [selectedContainer, setSelectedContainer] = createSignal('');

    const dbContainers = createMemo(() =>
        (containers() || []).filter(
            (item) => item.resource_type === 'database' && item.resource_id === params.id
        )
    );

    createEffect(() => {
        if (!selectedContainer() && dbContainers().length > 0) {
            setSelectedContainer(dbContainers()[0].id);
        }
    });

    return (
        <div>
            <div class="flex items-center justify-between mb-8">
                <div>
                    <div class="flex items-center gap-3">
                        <A href="/databases" class="text-xs text-neutral-400 hover:text-black">
                            databases
                        </A>
                        <span class="text-xs text-neutral-300">/</span>
                        <span class="text-xs text-neutral-500">{database()?.name || '...'}</span>
                    </div>
                    <h1 class="text-2xl font-serif text-black mt-2">{database()?.name}</h1>
                    <p class="text-neutral-500 mt-1 text-sm">
                        {database()?.db_type} {database()?.version}
                    </p>
                </div>
            </div>

            <Show when={database()}>
                <div class="border border-neutral-200 p-5 mb-6 text-sm text-neutral-600 grid grid-cols-2 gap-4">
                    <div>
                        <p class="text-xs text-neutral-400">host</p>
                        <p class="font-mono text-neutral-800">
                            {database()!.internal_host}:{database()!.port}
                        </p>
                    </div>
                    <div>
                        <p class="text-xs text-neutral-400">status</p>
                        <p class="text-neutral-800">{database()!.status}</p>
                    </div>
                    <div>
                        <p class="text-xs text-neutral-400">resources</p>
                        <p class="text-neutral-800">
                            {database()!.memory_limit_mb}mb / {database()!.cpu_limit} cpu
                        </p>
                    </div>
                    <div>
                        <p class="text-xs text-neutral-400">user</p>
                        <p class="text-neutral-800">{database()!.username}</p>
                    </div>
                </div>
            </Show>

            <div>
                <h2 class="text-lg font-serif text-black mb-3">container</h2>
                <Show when={dbContainers().length > 0}>
                    <ContainerMonitor containerId={selectedContainer()} />
                </Show>
                <Show when={dbContainers().length === 0}>
                    <div class="border border-dashed border-neutral-200 p-8 text-center text-neutral-400 text-sm">
                        no running container for this database
                    </div>
                </Show>
            </div>
        </div>
    );
};

export default DatabaseDetail;
