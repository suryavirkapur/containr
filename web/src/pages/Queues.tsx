import { Component, createResource, createSignal, For, Show } from 'solid-js';
import { A } from '@solidjs/router';

interface Queue {
    id: string;
    name: string;
    queue_type: string;
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

/**
 * fetches user's queues
 */
const fetchQueues = async (): Promise<Queue[]> => {
    const token = localStorage.getItem('znskr_token');
    const res = await fetch('/api/queues', {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        if (res.status === 401) {
            localStorage.removeItem('znskr_token');
            window.location.href = '/login';
        }
        throw new Error('failed to fetch queues');
    }
    return res.json();
};

/**
 * queues management page
 */
const Queues: Component = () => {
    const [queues, { refetch }] = createResource(fetchQueues);
    const [showCreate, setShowCreate] = createSignal(false);
    const [creating, setCreating] = createSignal(false);
    const [error, setError] = createSignal('');
    const [copiedId, setCopiedId] = createSignal<string | null>(null);

    // create form
    const [name, setName] = createSignal('');
    const [queueType, setQueueType] = createSignal('rabbitmq');
    const [memoryMb, setMemoryMb] = createSignal('512');
    const [cpuLimit, setCpuLimit] = createSignal('1.0');

    const handleCreate = async (e: Event) => {
        e.preventDefault();
        setError('');
        setCreating(true);

        try {
            const token = localStorage.getItem('znskr_token');
            const res = await fetch('/api/queues', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                    name: name(),
                    queue_type: queueType(),
                    memory_limit_mb: parseInt(memoryMb()) || 512,
                    cpu_limit: parseFloat(cpuLimit()) || 1.0,
                }),
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'failed to create queue');
            }

            setShowCreate(false);
            setName('');
            refetch();
        } catch (err: any) {
            setError(err.message);
        } finally {
            setCreating(false);
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm('delete this queue? data will be lost.')) return;

        const token = localStorage.getItem('znskr_token');
        await fetch(`/api/queues/${id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
        });
        refetch();
    };

    const handleStart = async (id: string) => {
        const token = localStorage.getItem('znskr_token');
        await fetch(`/api/queues/${id}/start`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
        });
        refetch();
    };

    const handleStop = async (id: string) => {
        const token = localStorage.getItem('znskr_token');
        await fetch(`/api/queues/${id}/stop`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
        });
        refetch();
    };

    const copyToClipboard = (id: string, text: string) => {
        navigator.clipboard.writeText(text);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
    };

    const statusIndicator = (status: string) => {
        switch (status) {
            case 'running':
                return 'bg-black';
            case 'starting':
                return 'bg-neutral-400 animate-pulse';
            case 'stopped':
                return 'bg-neutral-200';
            case 'failed':
                return 'bg-neutral-300';
            default:
                return 'bg-neutral-200';
        }
    };

    return (
        <div>
            {/* header */}
            <div class="flex justify-between items-start mb-10">
                <div>
                    <h1 class="text-2xl font-serif text-black">queues</h1>
                    <p class="text-neutral-500 mt-1 text-sm">
                        managed rabbitmq and nats instances
                    </p>
                </div>
                <button
                    onClick={() => setShowCreate(true)}
                    class="px-4 py-2 bg-black text-white hover:bg-neutral-800 text-sm"
                >
                    create queue
                </button>
            </div>

            {/* loading */}
            <Show when={queues.loading}>
                <div class="animate-pulse space-y-4">
                    <div class="h-20 bg-neutral-50 border border-neutral-200"></div>
                    <div class="h-20 bg-neutral-50 border border-neutral-200"></div>
                </div>
            </Show>

            {/* empty */}
            <Show when={!queues.loading && queues()?.length === 0}>
                <div class="border border-dashed border-neutral-200 p-12 text-center">
                    <p class="text-neutral-400 text-sm">no queues yet</p>
                    <button
                        onClick={() => setShowCreate(true)}
                        class="mt-4 text-sm text-black hover:underline"
                    >
                        create your first queue
                    </button>
                </div>
            </Show>

            {/* list */}
            <Show when={!queues.loading && queues() && queues()!.length > 0}>
                <div class="space-y-4">
                    <For each={queues()}>
                        {(queue) => (
                            <div class="border border-neutral-200 p-5">
                                <div class="flex justify-between items-start">
                                    <div>
                                        <div class="flex items-center gap-3">
                                            <span class={`w-2 h-2 ${statusIndicator(queue.status)}`}></span>
                                            <A href={`/queues/${queue.id}`} class="text-black font-medium hover:underline">
                                                {queue.name}
                                            </A>
                                            <span class="text-xs text-neutral-400">
                                                {queue.queue_type} {queue.version}
                                            </span>
                                        </div>
                                        <p class="text-xs text-neutral-500 mt-2 font-mono">
                                            {queue.internal_host}:{queue.port}
                                        </p>
                                    </div>
                                    <div class="flex gap-2">
                                        <button
                                            onClick={() => copyToClipboard(queue.id, queue.connection_string)}
                                            class="px-3 py-1 text-xs border border-neutral-300 text-neutral-700 hover:border-neutral-400"
                                        >
                                            {copiedId() === queue.id ? 'copied!' : 'copy url'}
                                        </button>
                                        <Show when={queue.status === 'stopped'}>
                                            <button
                                                onClick={() => handleStart(queue.id)}
                                                class="px-3 py-1 text-xs border border-neutral-300 text-neutral-700 hover:border-neutral-400"
                                            >
                                                start
                                            </button>
                                        </Show>
                                        <Show when={queue.status === 'running'}>
                                            <button
                                                onClick={() => handleStop(queue.id)}
                                                class="px-3 py-1 text-xs border border-neutral-300 text-neutral-700 hover:border-neutral-400"
                                            >
                                                stop
                                            </button>
                                        </Show>
                                        <button
                                            onClick={() => handleDelete(queue.id)}
                                            class="px-3 py-1 text-xs border border-neutral-300 text-neutral-500 hover:text-black hover:border-neutral-400"
                                        >
                                            delete
                                        </button>
                                    </div>
                                </div>
                                <div class="mt-3 pt-3 border-t border-neutral-100 flex gap-6 text-xs text-neutral-500">
                                    <span>{queue.memory_limit_mb}mb ram</span>
                                    <span>{queue.cpu_limit} cpu</span>
                                    <span>user: {queue.username}</span>
                                </div>
                            </div>
                        )}
                    </For>
                </div>
            </Show>

            {/* create modal */}
            <Show when={showCreate()}>
                <div class="fixed inset-0 bg-white/90 flex items-center justify-center z-50">
                    <div class="bg-white border border-neutral-300 p-6 w-full max-w-md">
                        <h2 class="text-lg font-serif text-black mb-6">create queue</h2>

                        {error() && (
                            <div class="border border-neutral-300 bg-neutral-50 text-neutral-700 px-4 py-3 mb-4 text-sm">
                                {error()}
                            </div>
                        )}

                        <form onSubmit={handleCreate} class="space-y-5">
                            <div>
                                <label class="block text-xs text-neutral-500 uppercase tracking-wider mb-2">
                                    name
                                </label>
                                <input
                                    type="text"
                                    value={name()}
                                    onInput={(e) => setName(e.currentTarget.value)}
                                    class="w-full px-3 py-2 bg-white border border-neutral-300 text-black focus:border-black focus:outline-none text-sm"
                                    placeholder="my-queue"
                                    required
                                />
                            </div>

                            <div>
                                <label class="block text-xs text-neutral-500 uppercase tracking-wider mb-2">
                                    type
                                </label>
                                <select
                                    value={queueType()}
                                    onChange={(e) => setQueueType(e.currentTarget.value)}
                                    class="w-full px-3 py-2 bg-white border border-neutral-300 text-black focus:border-black focus:outline-none text-sm"
                                >
                                    <option value="rabbitmq">rabbitmq</option>
                                    <option value="nats">nats</option>
                                </select>
                            </div>

                            <div class="grid grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-xs text-neutral-500 uppercase tracking-wider mb-2">
                                        memory (mb)
                                    </label>
                                    <input
                                        type="number"
                                        value={memoryMb()}
                                        onInput={(e) => setMemoryMb(e.currentTarget.value)}
                                        class="w-full px-3 py-2 bg-white border border-neutral-300 text-black focus:border-black focus:outline-none text-sm"
                                    />
                                </div>
                                <div>
                                    <label class="block text-xs text-neutral-500 uppercase tracking-wider mb-2">
                                        cpu cores
                                    </label>
                                    <input
                                        type="number"
                                        step="0.1"
                                        value={cpuLimit()}
                                        onInput={(e) => setCpuLimit(e.currentTarget.value)}
                                        class="w-full px-3 py-2 bg-white border border-neutral-300 text-black focus:border-black focus:outline-none text-sm"
                                    />
                                </div>
                            </div>

                            <div class="flex gap-2 pt-2">
                                <button
                                    type="button"
                                    onClick={() => setShowCreate(false)}
                                    class="flex-1 px-4 py-2 border border-neutral-300 text-neutral-700 hover:text-black hover:border-neutral-400 text-sm"
                                >
                                    cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={creating()}
                                    class="flex-1 px-4 py-2 bg-black text-white hover:bg-neutral-800 disabled:opacity-50 text-sm"
                                >
                                    {creating() ? 'creating...' : 'create'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            </Show>
        </div>
    );
};

export default Queues;
