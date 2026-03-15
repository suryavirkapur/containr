import { A, useParams } from '@solidjs/router';
import { createResource, Show } from 'solid-js';
import { getBucket, getBucketConnection } from '../api/storage';
import { KeyValueTable, LoadingBlock, Notice, PageTitle, Panel } from '../components/Plain';
import { copyText, describeError, formatBytes, formatDateTime } from '../utils/format';

const BucketDetail = () => {
  const params = useParams();
  const [bucket] = createResource(() => params.id, getBucket);
  const [connection] = createResource(() => params.id, getBucketConnection);

  return (
    <div class='flex flex-col gap-8'>
      <Show when={bucket.loading}><LoadingBlock message='Loading bucket...' /></Show>
      <Show when={bucket.error}>{(error) => <Notice tone='error'>Failed to load bucket: {describeError(error())}</Notice>}</Show>
      <Show when={bucket()}>
        {(currentBucket) => (
          <>
            <PageTitle
              title={currentBucket().name}
              subtitle='Bucket details and shared S3 credentials.'
              actions={
                <A 
                  href='/storage'
                  class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2"
                >
                  Back to Storage
                </A>
              }
            />
            <Panel title='Bucket Summary'>
              <KeyValueTable
                rows={[
                  ['ID', <span class='font-mono text-muted-foreground'>{currentBucket().id}</span>],
                  ['Endpoint', <span class='font-mono'>{currentBucket().endpoint}</span>],
                  ['Internal Endpoint', <span class='font-mono'>{currentBucket().internal_endpoint}</span>],
                  ['Public Endpoint', <span class='font-mono'>{currentBucket().public_endpoint ?? 'none'}</span>],
                  ['Size', <span>{formatBytes(currentBucket().size_bytes)}</span>],
                  ['Created', <span>{formatDateTime(currentBucket().created_at)}</span>],
                ]}
              />
            </Panel>
          </>
        )}
      </Show>

      <Show when={connection.error}>{(error) => <Notice tone='error'>Failed to load connection data: {describeError(error())}</Notice>}</Show>
      <Show when={connection()}>
        {(currentConnection) => (
          <Panel title='Connection Details'>
            <div class='flex flex-col gap-6'>
              <KeyValueTable
                rows={[
                  ['Bucket', <span class="font-medium">{currentConnection().bucket_name}</span>],
                  ['Endpoint', <span class='font-mono'>{currentConnection().endpoint}</span>],
                  ['Internal Endpoint', <span class='font-mono'>{currentConnection().internal_endpoint}</span>],
                  ['Access Key', <span class='font-mono'>{currentConnection().access_key}</span>],
                  ['Secret Key', <span class='font-mono'>{currentConnection().secret_key}</span>],
                  ['Note', <span>{currentConnection().note}</span>],
                ]}
              />
              <div class='flex flex-wrap gap-2 pt-4 border-t border-border'>
                <button 
                  type='button' 
                  onClick={() => void copyText(currentConnection().access_key)}
                  class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2"
                >
                  Copy Access Key
                </button>
                <button 
                  type='button' 
                  onClick={() => void copyText(currentConnection().secret_key)}
                  class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2"
                >
                  Copy Secret Key
                </button>
              </div>
            </div>
          </Panel>
        )}
      </Show>
    </div>
  );
};

export default BucketDetail;
