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
    <div class='stack'>
      <Show when={bucket.loading}><LoadingBlock message='Loading bucket...' /></Show>
      <Show when={bucket.error}>{(error) => <Notice tone='error'>Failed to load bucket: {describeError(error())}</Notice>}</Show>
      <Show when={bucket()}>
        {(currentBucket) => (
          <>
            <PageTitle
              title={currentBucket().name}
              subtitle='Bucket details and shared S3 credentials.'
              actions={<A href='/storage'>back to storage</A>}
            />
            <Panel title='bucket summary'>
              <KeyValueTable
                rows={[
                  ['id', <span class='mono'>{currentBucket().id}</span>],
                  ['endpoint', <span class='mono'>{currentBucket().endpoint}</span>],
                  ['internal endpoint', <span class='mono'>{currentBucket().internal_endpoint}</span>],
                  ['public endpoint', <span class='mono'>{currentBucket().public_endpoint ?? 'none'}</span>],
                  ['size', <span>{formatBytes(currentBucket().size_bytes)}</span>],
                  ['created', <span>{formatDateTime(currentBucket().created_at)}</span>],
                ]}
              />
            </Panel>
          </>
        )}
      </Show>

      <Show when={connection.error}>{(error) => <Notice tone='error'>Failed to load connection data: {describeError(error())}</Notice>}</Show>
      <Show when={connection()}>
        {(currentConnection) => (
          <Panel title='connection details'>
            <KeyValueTable
              rows={[
                ['bucket', <span>{currentConnection().bucket_name}</span>],
                ['endpoint', <span class='mono'>{currentConnection().endpoint}</span>],
                ['internal endpoint', <span class='mono'>{currentConnection().internal_endpoint}</span>],
                ['access key', <span class='mono'>{currentConnection().access_key}</span>],
                ['secret key', <span class='mono'>{currentConnection().secret_key}</span>],
                ['note', <span>{currentConnection().note}</span>],
              ]}
            />
            <div class='button-row'>
              <button type='button' onClick={() => void copyText(currentConnection().access_key)}>copy access key</button>
              <button type='button' onClick={() => void copyText(currentConnection().secret_key)}>copy secret key</button>
            </div>
          </Panel>
        )}
      </Show>
    </div>
  );
};

export default BucketDetail;
