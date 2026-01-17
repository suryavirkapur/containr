import { Component, createResource, createSignal, Show } from 'solid-js';
import { useParams, A, useNavigate } from '@solidjs/router';

interface Bucket {
    id: string;
    name: string;
    access_key: string;
    secret_key: string;
    endpoint: string;
    size_bytes: number;
    created_at: string;
}

/**
 * fetches bucket details
 */
const fetchBucket = async (id: string): Promise<Bucket> => {
    const token = localStorage.getItem('znskr_token');
    const res = await fetch(`/api/buckets/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        if (res.status === 401) {
            localStorage.removeItem('znskr_token');
            window.location.href = '/login';
        }
        throw new Error('failed to fetch bucket');
    }
    return res.json();
};

/**
 * bucket detail page
 */
const BucketDetail: Component = () => {
    const params = useParams();
    const navigate = useNavigate();
    const [bucket] = createResource(() => params.id, fetchBucket);
    const [deleting, setDeleting] = createSignal(false);
    const [copiedField, setCopiedField] = createSignal<string | null>(null);

    const copyToClipboard = (field: string, text: string) => {
        navigator.clipboard.writeText(text);
        setCopiedField(field);
        setTimeout(() => setCopiedField(null), 2000);
    };

    const formatBytes = (bytes: number) => {
        if (bytes === 0) return '0 bytes';
        const k = 1024;
        const sizes = ['bytes', 'kb', 'mb', 'gb', 'tb'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const handleDelete = async () => {
        if (!confirm('delete this bucket? all files will be lost.')) return;
        setDeleting(true);
        try {
            const token = localStorage.getItem('znskr_token');
            await fetch(`/api/buckets/${params.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            navigate('/storage');
        } catch (err) {
            console.error(err);
            setDeleting(false);
        }
    };

    return (
        <div>
            {/* header */}
            <div class="flex items-center justify-between mb-8">
                <div>
                    <div class="flex items-center gap-3">
                        <A href="/storage" class="text-xs text-neutral-400 hover:text-black">
                            storage
                        </A>
                        <span class="text-xs text-neutral-300">/</span>
                        <span class="text-xs text-neutral-500">{bucket()?.name || '...'}</span>
                    </div>
                    <h1 class="text-2xl font-serif text-black mt-2">{bucket()?.name}</h1>
                    <p class="text-neutral-500 mt-1 text-sm">s3-compatible storage bucket</p>
                </div>
                <button
                    onClick={handleDelete}
                    disabled={deleting()}
                    class="px-4 py-2 border border-neutral-300 text-neutral-500 hover:text-black hover:border-neutral-400 disabled:opacity-50 text-sm"
                >
                    {deleting() ? 'deleting...' : 'delete bucket'}
                </button>
            </div>

            {/* loading */}
            <Show when={bucket.loading}>
                <div class="animate-pulse space-y-4">
                    <div class="h-32 bg-neutral-50 border border-neutral-200"></div>
                </div>
            </Show>

            {/* content */}
            <Show when={!bucket.loading && bucket()}>
                {/* connection info */}
                <div class="border border-neutral-200 mb-6">
                    <div class="border-b border-neutral-200 px-5 py-3">
                        <h2 class="text-sm font-serif text-black">connection details</h2>
                    </div>
                    <div class="p-5 space-y-4">
                        <div>
                            <label class="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
                                endpoint
                            </label>
                            <div class="flex items-center gap-2">
                                <code class="flex-1 px-3 py-2 bg-neutral-50 border border-neutral-200 text-black text-sm font-mono">
                                    {bucket()!.endpoint}
                                </code>
                                <button
                                    onClick={() => copyToClipboard('endpoint', bucket()!.endpoint)}
                                    class="px-3 py-2 text-xs border border-neutral-300 text-neutral-500 hover:text-black"
                                >
                                    {copiedField() === 'endpoint' ? 'copied' : 'copy'}
                                </button>
                            </div>
                        </div>

                        <div>
                            <label class="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
                                bucket name
                            </label>
                            <div class="flex items-center gap-2">
                                <code class="flex-1 px-3 py-2 bg-neutral-50 border border-neutral-200 text-black text-sm font-mono">
                                    {bucket()!.name}
                                </code>
                                <button
                                    onClick={() => copyToClipboard('name', bucket()!.name)}
                                    class="px-3 py-2 text-xs border border-neutral-300 text-neutral-500 hover:text-black"
                                >
                                    {copiedField() === 'name' ? 'copied' : 'copy'}
                                </button>
                            </div>
                        </div>

                        <div>
                            <label class="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
                                access key
                            </label>
                            <div class="flex items-center gap-2">
                                <code class="flex-1 px-3 py-2 bg-neutral-50 border border-neutral-200 text-black text-sm font-mono">
                                    {bucket()!.access_key}
                                </code>
                                <button
                                    onClick={() => copyToClipboard('access', bucket()!.access_key)}
                                    class="px-3 py-2 text-xs border border-neutral-300 text-neutral-500 hover:text-black"
                                >
                                    {copiedField() === 'access' ? 'copied' : 'copy'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                {/* bucket info */}
                <div class="border border-neutral-200">
                    <div class="border-b border-neutral-200 px-5 py-3">
                        <h2 class="text-sm font-serif text-black">bucket info</h2>
                    </div>
                    <div class="p-5 grid grid-cols-2 gap-4 text-sm">
                        <div>
                            <p class="text-xs text-neutral-400">size</p>
                            <p class="text-neutral-800 font-mono">{formatBytes(bucket()!.size_bytes)}</p>
                        </div>
                        <div>
                            <p class="text-xs text-neutral-400">created</p>
                            <p class="text-neutral-800">{new Date(bucket()!.created_at).toLocaleDateString()}</p>
                        </div>
                    </div>
                </div>

                {/* note about secret key */}
                <div class="mt-6 p-4 border border-dashed border-neutral-200 text-center">
                    <p class="text-xs text-neutral-400">
                        the secret key is only shown once during bucket creation.
                        if you've lost it, you'll need to delete this bucket and create a new one.
                    </p>
                </div>
            </Show>
        </div>
    );
};

export default BucketDetail;
