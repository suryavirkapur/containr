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
    <div class='stack'>
      <PageTitle title='storage' subtitle='Managed S3-compatible buckets backed by rustfs.' />
      {feedback() ? <Notice tone={feedback()!.tone}>{feedback()!.text}</Notice> : null}
      <Show when={createdEndpoint()}>
        {(endpoint) => (
          <Notice tone='success'>
            endpoint ready: <span class='mono'>{endpoint()}</span>{' '}
            <button type='button' onClick={() => void copyText(endpoint())}>copy</button>
          </Notice>
        )}
      </Show>

      <Panel title='create bucket'>
        <form class='form-stack' onSubmit={(event) => void submit(event)}>
          <label class='field'>
            <span>bucket name</span>
            <input value={name()} onInput={(event) => setName(event.currentTarget.value)} />
          </label>
          <div class='button-row'>
            <button type='submit' disabled={saving()}>{saving() ? 'creating...' : 'create bucket'}</button>
          </div>
        </form>
      </Panel>

      <Show when={buckets.loading}><LoadingBlock message='Loading buckets...' /></Show>
      <Show when={buckets.error}>{(error) => <Notice tone='error'>Failed to load buckets: {describeError(error())}</Notice>}</Show>
      <Show when={!buckets.loading && (buckets() ?? []).length === 0}>
        <EmptyBlock title='No buckets yet'>Create one above.</EmptyBlock>
      </Show>

      <Show when={!buckets.loading && (buckets() ?? []).length > 0}>
        <Panel title='bucket inventory'>
          <div class='repo-grid'>
            <For each={buckets() ?? []}>
              {(bucket) => (
                <article class='repo-card'>
                  <div class='choice-card-head'>
                    <div>
                      <A class='service-title' href={`/storage/${bucket.id}`}>
                        {bucket.name}
                      </A>
                      <p class='muted mono'>{bucket.endpoint}</p>
                    </div>
                    <span class='badge'>{bucket.publicly_exposed ? 'public' : 'private'}</span>
                  </div>
                  <div class='summary-grid'>
                    <div class='summary-card'>
                      <p class='muted'>public endpoint</p>
                      <p class='mono'>{bucket.public_endpoint ?? 'not exposed'}</p>
                    </div>
                    <div class='summary-card'>
                      <p class='muted'>size</p>
                      <p>{formatBytes(bucket.size_bytes)}</p>
                    </div>
                    <div class='summary-card'>
                      <p class='muted'>created</p>
                      <p>{formatDateTime(bucket.created_at)}</p>
                    </div>
                  </div>
                  <div class='button-row'>
                    <A href={`/storage/${bucket.id}`}>open</A>
                    <button type='button' onClick={() => void removeBucket(bucket.id)} disabled={pendingDelete() === bucket.id}>
                      delete
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
