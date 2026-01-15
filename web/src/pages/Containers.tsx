import { Component, createMemo, createResource, createSignal, For, Show } from 'solid-js';
import ContainerMonitor from '../components/ContainerMonitor';

interface ContainerListItem {
    id: string;
    resource_type: string;
    resource_id: string;
    name: string;
}

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

const Containers: Component = () => {
    const [containers, { refetch }] = createResource(fetchContainers);
    const [selectedId, setSelectedId] = createSignal('');

    const items = createMemo(() => containers() || []);

    return (
        <div>
            <div class="flex justify-between items-start mb-8">
                <div>
                    <h1 class="text-2xl font-serif text-black">containers</h1>
                    <p class="text-neutral-500 mt-1 text-sm">
                        health, metrics, logs, and volumes across your services
                    </p>
                </div>
                <button
                    onClick={() => refetch()}
                    class="px-4 py-2 border border-neutral-300 text-neutral-700 hover:border-neutral-400 text-sm"
                >
                    refresh list
                </button>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div class="border border-neutral-200 p-4">
                    <h2 class="text-xs text-neutral-400 uppercase tracking-wider mb-3">
                        containers
                    </h2>
                    <Show when={containers.loading}>
                        <div class="text-xs text-neutral-400">loading...</div>
                    </Show>
                    <Show when={!containers.loading && items().length === 0}>
                        <div class="text-xs text-neutral-400">no running containers</div>
                    </Show>
                    <div class="space-y-2">
                        <For each={items()}>
                            {(item) => (
                                <button
                                    onClick={() => setSelectedId(item.id)}
                                    class={`w-full text-left px-3 py-2 border ${selectedId() === item.id ? 'border-black text-black' : 'border-neutral-200 text-neutral-600 hover:border-neutral-300'} text-sm`}
                                >
                                    <div class="font-medium">{item.name}</div>
                                    <div class="text-xs text-neutral-400">{item.resource_type}</div>
                                </button>
                            )}
                        </For>
                    </div>
                </div>

                <div class="lg:col-span-2">
                    <Show when={selectedId()}>
                        <ContainerMonitor containerId={selectedId()} />
                    </Show>
                    <Show when={!selectedId()}>
                        <div class="border border-dashed border-neutral-200 p-10 text-center text-neutral-400 text-sm">
                            select a container to view details
                        </div>
                    </Show>
                </div>
            </div>
        </div>
    );
};

export default Containers;
