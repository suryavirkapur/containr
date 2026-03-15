import { A } from '@solidjs/router';
import { createResource, createSignal, For, Show } from 'solid-js';
import { createBucket, deleteBucket, listBuckets } from '../api/storage';
import { EmptyBlock, LoadingBlock, Notice, PageTitle, Panel } from '../components/Plain';
import { copyText, describeError, formatBytes, formatDateTime } from '../utils/format';

const Storage = () => {
  const [name, setName] = createSignal('');
  const [feedback, setFeedback] = createSignal<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [createdEndpoint, setCreatedEndpoint] = createSignal<string | null>(null);
  const [pendingDelete, setPendingDelete] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [buckets, { refetch }] = createResource(listBuckets);

  const submit = async (event: Event) => {
    event.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      const bucket = await createBucket(name().trim());
      setName('');
      setCreatedEndpoint(bucket.endpoint);
      setFeedback({ tone: 'success', text: `bucket ${bucket.name} created` });
      await refetch();
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
    } finally {
      setSaving(false);
    }
  };

  const removeBucket = async (id: string) => {
    if (!confirm('delete this bucket?')) return;
    setPendingDelete(id);
    setFeedback(null);
    try {
      await deleteBucket(id);
      await refetch();
      setFeedback({ tone: 'success', text: 'bucket deleted' });
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <div class='flex flex-col gap-6'>
      <PageTitle title='Storage' subtitle='Managed S3-compatible buckets backed by rustfs.' />
      
      {feedback() ? <Notice tone={feedback()!.tone}>{feedback()!.text}</Notice> : null}
      
      <Show when={createdEndpoint()}>
        {(endpoint) => (
          <Notice tone='success'>
            <div class="flex items-center gap-2">
              <span>Endpoint ready:</span>
              <span class='font-mono text-sm bg-background/50 px-1.5 py-0.5 rounded'>{endpoint()}</span>
              <button 
                type='button' 
                onClick={() => void copyText(endpoint())}
                class="inline-flex items-center justify-center rounded-md text-xs font-medium transition-colors hover:bg-background/50 h-6 px-2 ml-2"
              >
                Copy
              </button>
            </div>
          </Notice>
        )}
      </Show>

      <Panel title='Create Bucket'>
        <form class='flex flex-col gap-4' onSubmit={(event) => void submit(event)}>
          <label class='flex flex-col gap-2'>
            <span class='text-sm font-medium leading-none'>Bucket Name</span>
            <input 
              class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={name()} 
              onInput={(event) => setName(event.currentTarget.value)} 
            />
          </label>
          <div class='flex gap-2 pt-2'>
            <button 
              type='submit' 
              disabled={saving()}
              class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-9 px-4 py-2 disabled:opacity-50"
            >
              {saving() ? 'Creating...' : 'Create Bucket'}
            </button>
          </div>
        </form>
      </Panel>

      <Show when={buckets.loading}><LoadingBlock message='Loading buckets...' /></Show>
      <Show when={buckets.error}>{(error) => <Notice tone='error'>Failed to load buckets: {describeError(error())}</Notice>}</Show>
      <Show when={!buckets.loading && (buckets() ?? []).length === 0}>
        <EmptyBlock title='No buckets yet'>Create one above.</EmptyBlock>
      </Show>

      <Show when={!buckets.loading && (buckets() ?? []).length > 0}>
        <Panel title='Bucket Inventory'>
          <div class='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
            <For each={buckets() ?? []}>
              {(bucket) => (
                <article class='rounded-xl border bg-card text-card-foreground shadow-sm p-4 flex flex-col gap-4 hover:border-primary/20 transition-colors'>
                  <div class='flex justify-between items-start gap-4'>
                    <div class='min-w-0'>
                      <A class='font-semibold tracking-tight hover:underline text-base truncate block' href={`/storage/${bucket.id}`}>
                        {bucket.name}
                      </A>
                      <p class='text-xs text-muted-foreground font-mono truncate mt-1 flex gap-1 items-center'>
                        {bucket.endpoint}
                      </p>
                    </div>
                    <span class={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider whitespace-nowrap ${
                      bucket.publicly_exposed ? 'bg-secondary text-secondary-foreground border-border' : 'bg-muted text-muted-foreground border-border'
                    }`}>
                      {bucket.publicly_exposed ? 'Public' : 'Private'}
                    </span>
                  </div>
                  
                  <div class='grid grid-cols-2 gap-4 py-3 border-y border-border text-sm'>
                    <div class='flex flex-col gap-1 col-span-2'>
                      <p class='text-[0.7rem] font-semibold uppercase text-muted-foreground tracking-wider'>Public Endpoint</p>
                      <p class='text-xs font-mono truncate'>{bucket.public_endpoint ?? 'Not exposed'}</p>
                    </div>
                    <div class='flex flex-col gap-1'>
                      <p class='text-[0.7rem] font-semibold uppercase text-muted-foreground tracking-wider'>Size</p>
                      <p class='text-xs'>{formatBytes(bucket.size_bytes)}</p>
                    </div>
                    <div class='flex flex-col gap-1'>
                      <p class='text-[0.7rem] font-semibold uppercase text-muted-foreground tracking-wider'>Created</p>
                      <p class='text-xs'>{formatDateTime(bucket.created_at)}</p>
                    </div>
                  </div>
                  
                  <div class='flex justify-end gap-2'>
                    <A 
                      href={`/storage/${bucket.id}`}
                      class="inline-flex items-center justify-center rounded-md text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-8 px-3"
                    >
                      Open
                    </A>
                    <button 
                      type='button' 
                      onClick={() => void removeBucket(bucket.id)} 
                      disabled={pendingDelete() === bucket.id}
                      class="inline-flex items-center justify-center rounded-md text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring border border-input bg-background hover:bg-destructive hover:text-destructive-foreground hover:border-destructive shadow-sm h-8 px-3 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </article>
              )}
            </For>
          </div>
        </Panel>
      </Show>
    </div>
  );
};

export default Storage;
