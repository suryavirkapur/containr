import { A, useParams } from '@solidjs/router';
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from 'solid-js';
import {
  buildContainerExecWebSocketUrl,
  createContainerDirectory,
  deleteContainerFile,
  downloadContainerFile,
  getContainerLogs,
  getContainerMounts,
  getContainerStatus,
  issueContainerExecToken,
  listContainerFiles,
  listContainers,
  uploadContainerFiles,
} from '../api/containers';
import { KeyValueTable, LoadingBlock, Notice, PageTitle, Panel } from '../components/Plain';
import { copyText, describeError, formatBytes, formatDateTime } from '../utils/format';

const parentPath = (value: string) => {
  const trimmed = value.replace(/\/+$/, '');
  if (!trimmed) return '';
  const index = trimmed.lastIndexOf('/');
  return index === -1 ? '' : trimmed.slice(0, index);
};

const shellOptions = [
  ['/bin/sh', 'sh'],
  ['/bin/bash', 'bash'],
  ['/bin/ash', 'ash'],
] as const;

const ContainerDetail = () => {
  const params = useParams();
  const containerId = () => params.id ?? '';
  const [feedback, setFeedback] = createSignal<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [logsTail, setLogsTail] = createSignal('300');
  const [selectedMount, setSelectedMount] = createSignal('');
  const [currentPath, setCurrentPath] = createSignal('');
  const [newDirectory, setNewDirectory] = createSignal('');
  const [shellCommand, setShellCommand] = createSignal('');
  const [shellChoice, setShellChoice] = createSignal('/bin/sh');
  const [shellOutput, setShellOutput] = createSignal('');
  const [execInfo, setExecInfo] = createSignal<{ token: string; expires_at: string } | null>(null);
  const [pending, setPending] = createSignal<string | null>(null);
  const [socketState, setSocketState] = createSignal<'idle' | 'connecting' | 'open' | 'closed'>('idle');
  let socket: WebSocket | null = null;

  const [containers] = createResource(listContainers);
  const [status, { refetch: refetchStatus }] = createResource(containerId, getContainerStatus);
  const [mounts, { refetch: refetchMounts }] = createResource(containerId, getContainerMounts);
  const [logs, { refetch: refetchLogs }] = createResource(
    () => ({ id: containerId(), tail: Number.parseInt(logsTail(), 10) || 300 }),
    ({ id, tail }) => getContainerLogs(id, { tail }),
  );
  const [files, { refetch: refetchFiles }] = createResource(
    () => {
      if (!containerId() || !selectedMount()) return null;
      return { id: containerId(), mount: selectedMount(), path: currentPath() || undefined };
    },
    (value) => (value ? listContainerFiles(value.id, { mount: value.mount, path: value.path }) : Promise.resolve([])),
  );

  const currentContainer = createMemo(() =>
    (containers() ?? []).find((container) => container.id === containerId()) ?? null,
  );

  createEffect(() => {
    const rows = mounts();
    if (!rows || rows.length === 0) return;
    if (!selectedMount()) {
      setSelectedMount(rows[0].destination);
    }
  });

  onCleanup(() => {
    socket?.close();
  });

  const refreshAll = async () => {
    await Promise.all([refetchStatus(), refetchMounts(), refetchLogs(), refetchFiles()]);
  };

  const connectShell = async () => {
    setPending('exec');
    setFeedback(null);
    try {
      const token = await issueContainerExecToken(containerId());
      setExecInfo(token);
      setShellOutput('');
      setSocketState('connecting');
      socket?.close();
      socket = new WebSocket(
        buildContainerExecWebSocketUrl(containerId(), token.token, shellChoice()),
      );
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        setSocketState('open');
        setFeedback({ tone: 'success', text: 'shell session opened' });
      };
      socket.onclose = () => setSocketState('closed');
      socket.onerror = () => {
        setSocketState('closed');
        setFeedback({ tone: 'error', text: 'shell session failed' });
      };
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') {
          setShellOutput((current) => `${current}${event.data}`);
          return;
        }
        const decoder = new TextDecoder();
        setShellOutput((current) => `${current}${decoder.decode(event.data)}`);
      };
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
      setSocketState('closed');
    } finally {
      setPending(null);
    }
  };

  const sendShellLine = () => {
    if (!socket || socket.readyState !== WebSocket.OPEN || !shellCommand().trim()) return;
    const encoder = new TextEncoder();
    socket.send(encoder.encode(`${shellCommand()}\n`));
    setShellOutput((current) => `${current}\n$ ${shellCommand()}\n`);
    setShellCommand('');
  };

  const createDirectory = async () => {
    if (!newDirectory().trim() || !selectedMount()) return;
    setPending('mkdir');
    setFeedback(null);
    try {
      const target = [currentPath(), newDirectory().trim()].filter(Boolean).join('/');
      await createContainerDirectory(containerId(), selectedMount(), target);
      setNewDirectory('');
      await refetchFiles();
      setFeedback({ tone: 'success', text: 'directory created' });
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
    } finally {
      setPending(null);
    }
  };

  const uploadFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0 || !selectedMount()) return;
    setPending('upload');
    setFeedback(null);
    try {
      await uploadContainerFiles(containerId(), selectedMount(), fileList, currentPath() || undefined);
      await refetchFiles();
      setFeedback({ tone: 'success', text: 'file uploaded' });
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
    } finally {
      setPending(null);
    }
  };

  const removeEntry = async (path: string) => {
    if (!selectedMount() || !confirm(`delete ${path}?`)) return;
    setPending(`delete-${path}`);
    setFeedback(null);
    try {
      await deleteContainerFile(containerId(), { mount: selectedMount(), path });
      await refetchFiles();
      setFeedback({ tone: 'success', text: 'entry deleted' });
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
    } finally {
      setPending(null);
    }
  };

  const downloadEntry = async (path: string) => {
    if (!selectedMount()) return;
    setPending(`download-${path}`);
    setFeedback(null);
    try {
      await downloadContainerFile(containerId(), { mount: selectedMount(), path });
    } catch (error) {
      setFeedback({ tone: 'error', text: describeError(error) });
    } finally {
      setPending(null);
    }
  };

  return (
    <div class='stack'>
      <PageTitle
        title={currentContainer()?.name ?? containerId()}
        subtitle='Container runtime, files, and shell access.'
        actions={
          <>
            <A href='/containers'>back to containers</A>
            <button type='button' onClick={() => void refreshAll()}>refresh</button>
          </>
        }
      />

      {feedback() ? <Notice tone={feedback()!.tone}>{feedback()!.text}</Notice> : null}

      <Show when={status.loading || mounts.loading}>
        <LoadingBlock message='Loading container...' />
      </Show>

      <Show when={status.error}>
        {(error) => <Notice tone='error'>Failed to load container status: {describeError(error())}</Notice>}
      </Show>

      <Panel title='summary'>
        <KeyValueTable
          rows={[
            ['container id', <span class='mono'>{containerId()}</span>],
            ['name', <span>{currentContainer()?.name ?? 'unknown'}</span>],
            ['resource type', <span>{currentContainer()?.resource_type ?? 'unknown'}</span>],
            ['resource id', <span class='mono'>{currentContainer()?.resource_id ?? 'unknown'}</span>],
            ['status', <span>{status()?.status ?? 'unknown'}</span>],
            ['health', <span>{status()?.health_status ?? 'n/a'}</span>],
            ['cpu', <span>{status() ? `${status()!.cpu_percent.toFixed(1)}%` : 'n/a'}</span>],
            ['memory', <span>{status() ? `${formatBytes(status()!.mem_usage_bytes)} / ${formatBytes(status()!.mem_limit_bytes)}` : 'n/a'}</span>],
            ['started', <span>{formatDateTime(status()?.started_at)}</span>],
            ['finished', <span>{formatDateTime(status()?.finished_at)}</span>],
            ['restarts', <span>{String(status()?.restart_count ?? 0)}</span>],
          ]}
        />
      </Panel>

      <Panel title='shell access' subtitle='Requests an exec token and opens a browser shell session.'>
        <div class='two-col'>
          <label class='field'>
            <span>shell</span>
            <select value={shellChoice()} onChange={(event) => setShellChoice(event.currentTarget.value)}>
              <For each={shellOptions}>
                {([value, label]) => <option value={value}>{label}</option>}
              </For>
            </select>
          </label>
          <div class='field'>
            <span>session</span>
            <div class='button-row'>
              <button type='button' onClick={() => void connectShell()} disabled={pending() === 'exec'}>
                {socketState() === 'open' ? 'reconnect shell' : 'open shell'}
              </button>
              <Show when={execInfo()}>
                {(info) => (
                  <button type='button' onClick={() => void copyText(info().token)}>copy exec token</button>
                )}
              </Show>
            </div>
          </div>
        </div>
        <Show when={execInfo()}>
          {(info) => (
            <KeyValueTable
              rows={[
                ['token', <span class='mono'>{info().token}</span>],
                ['expires', <span>{formatDateTime(info().expires_at)}</span>],
                ['state', <span>{socketState()}</span>],
              ]}
            />
          )}
        </Show>
        <pre class='terminal-output'>{shellOutput() || 'shell output will appear here'}</pre>
        <div class='button-row'>
          <input
            class='terminal-input'
            value={shellCommand()}
            onInput={(event) => setShellCommand(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                sendShellLine();
              }
            }}
            placeholder='type a shell command and press Enter'
          />
          <button type='button' onClick={sendShellLine} disabled={socketState() !== 'open'}>
            send
          </button>
        </div>
      </Panel>

      <Panel title='container logs'>
        <div class='button-row'>
          <label class='field'>
            <span>tail lines</span>
            <input value={logsTail()} onInput={(event) => setLogsTail(event.currentTarget.value)} />
          </label>
          <button type='button' onClick={() => void refetchLogs()}>refresh logs</button>
        </div>
        <pre>{logs() ?? ''}</pre>
      </Panel>

      <Panel title='mounts and files'>
        <Show when={mounts.error}>
          {(error) => <Notice tone='error'>Failed to load mounts: {describeError(error())}</Notice>}
        </Show>
        <Show when={(mounts() ?? []).length > 0} fallback={<p>No writable or mounted volumes detected.</p>}>
          <div class='two-col'>
            <label class='field'>
              <span>mount</span>
              <select
                value={selectedMount()}
                onChange={(event) => {
                  setSelectedMount(event.currentTarget.value);
                  setCurrentPath('');
                }}
              >
                <For each={mounts() ?? []}>
                  {(mount) => (
                    <option value={mount.destination}>
                      {mount.destination} ({mount.mount_type}{mount.read_only ? ', read only' : ''})
                    </option>
                  )}
                </For>
              </select>
            </label>
            <label class='field'>
              <span>current path</span>
              <input
                value={currentPath()}
                onInput={(event) => setCurrentPath(event.currentTarget.value)}
                placeholder='relative path within selected mount'
              />
            </label>
          </div>

          <div class='button-row'>
            <button type='button' onClick={() => setCurrentPath(parentPath(currentPath()))} disabled={!currentPath()}>
              up one level
            </button>
            <button type='button' onClick={() => void refetchFiles()} disabled={!selectedMount()}>
              refresh files
            </button>
          </div>

          <div class='two-col'>
            <label class='field'>
              <span>new directory</span>
              <input value={newDirectory()} onInput={(event) => setNewDirectory(event.currentTarget.value)} />
            </label>
            <div class='field'>
              <span>actions</span>
              <div class='button-row'>
                <button type='button' onClick={() => void createDirectory()} disabled={pending() === 'mkdir' || !selectedMount()}>
                  create directory
                </button>
                <input type='file' multiple onChange={(event) => void uploadFiles(event.currentTarget.files)} />
              </div>
            </div>
          </div>

          <Show when={files.loading}>
            <LoadingBlock message='Loading files...' />
          </Show>
          <Show when={files.error}>
            {(error) => <Notice tone='error'>Failed to load files: {describeError(error())}</Notice>}
          </Show>
          <Show when={!files.loading && (files() ?? []).length === 0}>
            <EmptyState path={currentPath()} />
          </Show>
          <Show when={!files.loading && (files() ?? []).length > 0}>
            <div class='repo-grid'>
              <For each={files() ?? []}>
                {(entry) => (
                  <article class='repo-card'>
                    <div class='choice-card-head'>
                      <div>
                        <h3>{entry.name}</h3>
                        <p class='muted mono'>{entry.path}</p>
                      </div>
                      <span class='badge'>{entry.is_dir ? 'directory' : 'file'}</span>
                    </div>
                    <div class='summary-grid'>
                      <div class='summary-card'>
                        <p class='muted'>size</p>
                        <p>{entry.is_dir ? 'folder' : formatBytes(entry.size_bytes)}</p>
                      </div>
                      <div class='summary-card'>
                        <p class='muted'>modified</p>
                        <p>{formatDateTime(entry.modified_at)}</p>
                      </div>
                    </div>
                    <div class='button-row'>
                      <Show when={entry.is_dir} fallback={
                        <button
                          type='button'
                          onClick={() => void downloadEntry(entry.path)}
                          disabled={pending() === `download-${entry.path}`}
                        >
                          download
                        </button>
                      }>
                        <button type='button' onClick={() => setCurrentPath(entry.path)}>open folder</button>
                      </Show>
                      <button
                        type='button'
                        onClick={() => void removeEntry(entry.path)}
                        disabled={pending() === `delete-${entry.path}`}
                      >
                        delete
                      </button>
                    </div>
                  </article>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Panel>
    </div>
  );
};

const EmptyState = (props: { path: string }) => (
  <div class='panel'>
    <p><strong>No files here</strong></p>
    <p class='muted'>{props.path ? `The directory ${props.path} is empty.` : 'The selected mount root is empty.'}</p>
  </div>
);

export default ContainerDetail;
