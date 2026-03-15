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
    <div class='flex flex-col gap-8'>
      <PageTitle
        title={currentContainer()?.name ?? containerId()}
        subtitle='Container runtime, files, and shell access.'
        actions={
          <div class="flex items-center gap-2">
            <A 
              href='/containers'
              class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2"
            >
              Back to Containers
            </A>
            <button 
              type='button' 
              onClick={() => void refreshAll()}
              class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2"
            >
              Refresh
            </button>
          </div>
        }
      />

      {feedback() ? <Notice tone={feedback()!.tone}>{feedback()!.text}</Notice> : null}

      <Show when={status.loading || mounts.loading}>
        <LoadingBlock message='Loading container...' />
      </Show>

      <Show when={status.error}>
        {(error) => <Notice tone='error'>Failed to load container status: {describeError(error())}</Notice>}
      </Show>

      <Panel title='Summary'>
        <KeyValueTable
          rows={[
            ['Container ID', <span class='font-mono text-muted-foreground'>{containerId()}</span>],
            ['Name', <span class="font-medium">{currentContainer()?.name ?? 'Unknown'}</span>],
            ['Resource Type', <span class="capitalize">{currentContainer()?.resource_type ?? 'Unknown'}</span>],
            ['Resource ID', <span class='font-mono text-muted-foreground'>{currentContainer()?.resource_id ?? 'Unknown'}</span>],
            ['Status', <span class={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider ${
              status()?.status === 'running' ? 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800' :
              status()?.status === 'exited' || status()?.status === 'dead' ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800' :
              'bg-muted text-muted-foreground border-border'
            }`}>{status()?.status ?? 'Unknown'}</span>],
            ['Health', <span class={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider ${
              status()?.health_status === 'healthy' ? 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800' :
              status()?.health_status === 'unhealthy' ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800' :
              status()?.health_status === 'starting' ? 'bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-900/20 dark:text-yellow-400 dark:border-yellow-800' :
              'bg-secondary text-secondary-foreground border-border'
            }`}>{status()?.health_status || 'N/A'}</span>],
            ['CPU', <span>{status() ? `${status()!.cpu_percent.toFixed(1)}%` : 'n/a'}</span>],
            ['Memory', <span>{status() ? `${formatBytes(status()!.mem_usage_bytes)} / ${formatBytes(status()!.mem_limit_bytes)}` : 'n/a'}</span>],
            ['Started', <span>{formatDateTime(status()?.started_at)}</span>],
            ['Finished', <span>{formatDateTime(status()?.finished_at)}</span>],
            ['Restarts', <span>{String(status()?.restart_count ?? 0)}</span>],
          ]}
        />
      </Panel>

      <Panel title='Shell Access' subtitle='Requests an exec token and opens a browser shell session.'>
        <div class='flex flex-col gap-6'>
          <div class='grid gap-4 sm:grid-cols-2'>
            <label class='flex flex-col gap-2'>
              <span class='text-sm font-medium leading-none'>Shell</span>
              <select 
                class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={shellChoice()} 
                onChange={(event) => setShellChoice(event.currentTarget.value)}
              >
                <For each={shellOptions}>
                  {([value, label]) => <option value={value}>{label}</option>}
                </For>
              </select>
            </label>
            <div class='flex flex-col gap-2'>
              <span class='text-sm font-medium leading-none'>Session</span>
              <div class='flex flex-wrap gap-2'>
                <button 
                  type='button' 
                  onClick={() => void connectShell()} 
                  disabled={pending() === 'exec'}
                  class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-9 px-4 py-2 disabled:opacity-50"
                >
                  {socketState() === 'open' ? 'Reconnect Shell' : 'Open Shell'}
                </button>
                <Show when={execInfo()}>
                  {(info) => (
                    <button 
                      type='button' 
                      onClick={() => void copyText(info().token)}
                      class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2"
                    >
                      Copy Exec Token
                    </button>
                  )}
                </Show>
              </div>
            </div>
          </div>
          
          <Show when={execInfo()}>
            {(info) => (
              <KeyValueTable
                rows={[
                  ['Token', <span class='font-mono break-all text-xs'>{info().token}</span>],
                  ['Expires', <span>{formatDateTime(info().expires_at)}</span>],
                  ['State', <span class="capitalize">{socketState()}</span>],
                ]}
              />
            )}
          </Show>
          
          <div class="flex flex-col border rounded-lg overflow-hidden border-border">
            <pre class='bg-[#111] text-[#fafafa] p-4 overflow-x-auto text-sm font-mono min-h-[16rem] whitespace-pre-wrap'>{shellOutput() || 'Shell output will appear here...'}</pre>
            <div class='flex bg-muted/50 border-t border-border p-2 gap-2'>
              <input
                class='flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono'
                value={shellCommand()}
                onInput={(event) => setShellCommand(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    sendShellLine();
                  }
                }}
                placeholder='Type a shell command and press Enter...'
              />
              <button 
                type='button' 
                onClick={sendShellLine} 
                disabled={socketState() !== 'open'}
                class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-9 px-4 py-2 disabled:opacity-50 whitespace-nowrap"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </Panel>

      <Panel title='Container Logs'>
        <div class='flex flex-col sm:flex-row items-end gap-4 mb-4'>
          <label class='flex flex-col gap-2 max-w-[12rem] w-full'>
            <span class='text-sm font-medium leading-none'>Tail Lines</span>
            <input 
              class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={logsTail()} 
              onInput={(event) => setLogsTail(event.currentTarget.value)} 
            />
          </label>
          <button 
            type='button' 
            onClick={() => void refetchLogs()}
            class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2"
          >
            Refresh Logs
          </button>
        </div>
        <pre class="bg-card border border-border rounded-lg p-4 overflow-x-auto text-sm font-mono text-muted-foreground min-h-[14rem]">{logs() ?? ''}</pre>
      </Panel>

      <Panel title='Mounts and Files'>
        <Show when={mounts.error}>
          {(error) => <Notice tone='error'>Failed to load mounts: {describeError(error())}</Notice>}
        </Show>
        <Show when={(mounts() ?? []).length > 0} fallback={<p class="text-sm text-muted-foreground p-4 text-center border rounded-lg border-dashed">No writable or mounted volumes detected.</p>}>
          <div class='grid gap-4 sm:grid-cols-2 mb-6'>
            <label class='flex flex-col gap-2'>
              <span class='text-sm font-medium leading-none'>Mount</span>
              <select
                class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
            <label class='flex flex-col gap-2'>
              <span class='text-sm font-medium leading-none'>Current Path</span>
              <input
                class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
                value={currentPath()}
                onInput={(event) => setCurrentPath(event.currentTarget.value)}
                placeholder='Relative path within selected mount'
              />
            </label>
          </div>

          <div class='flex flex-wrap gap-2 mb-8'>
            <button 
              type='button' 
              onClick={() => setCurrentPath(parentPath(currentPath()))} 
              disabled={!currentPath()}
              class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2 disabled:opacity-50"
            >
              Up One Level
            </button>
            <button 
              type='button' 
              onClick={() => void refetchFiles()} 
              disabled={!selectedMount()}
              class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2 disabled:opacity-50"
            >
              Refresh Files
            </button>
          </div>

          <div class='grid gap-4 sm:grid-cols-2 mb-6 pb-6 border-b border-border'>
            <label class='flex flex-col gap-2'>
              <span class='text-sm font-medium leading-none'>New Directory</span>
              <input 
                class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={newDirectory()} 
                onInput={(event) => setNewDirectory(event.currentTarget.value)} 
              />
            </label>
            <div class='flex flex-col gap-2'>
              <span class='text-sm font-medium leading-none'>Actions</span>
              <div class='flex flex-col sm:flex-row gap-2'>
                <button 
                  type='button' 
                  onClick={() => void createDirectory()} 
                  disabled={pending() === 'mkdir' || !selectedMount()}
                  class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-9 px-4 py-2 disabled:opacity-50 whitespace-nowrap"
                >
                  Create Directory
                </button>
                <div class="relative w-full">
                  <input 
                    type='file' 
                    multiple 
                    onChange={(event) => void uploadFiles(event.currentTarget.files)} 
                    class="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <div class="inline-flex w-full items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2 pointer-events-none whitespace-nowrap">
                    Upload Files
                  </div>
                </div>
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
            <div class='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
              <For each={files() ?? []}>
                {(entry) => (
                  <article class='rounded-xl border bg-card text-card-foreground shadow-sm p-4 flex flex-col gap-4'>
                    <div class='flex justify-between items-start gap-4'>
                      <div class="min-w-0">
                        <h3 class="font-semibold tracking-tight truncate text-base">{entry.name}</h3>
                        <p class='text-xs text-muted-foreground font-mono truncate mt-1'>{entry.path}</p>
                      </div>
                      <span class={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider ${
                        entry.is_dir ? 'bg-secondary text-secondary-foreground border-border' : 'bg-muted text-muted-foreground border-border'
                      }`}>
                        {entry.is_dir ? (
                          <>
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
                             Dir
                          </>
                        ) : (
                          <>
                             File
                          </>
                        )}
                      </span>
                    </div>
                    <div class='grid grid-cols-2 gap-4 py-3 border-y border-border text-xs mt-auto'>
                      <div class='flex flex-col gap-1'>
                        <p class='font-semibold uppercase text-muted-foreground tracking-wider'>Size</p>
                        <p>{entry.is_dir ? 'folder' : formatBytes(entry.size_bytes)}</p>
                      </div>
                      <div class='flex flex-col gap-1'>
                        <p class='font-semibold uppercase text-muted-foreground tracking-wider'>Modified</p>
                        <p>{formatDateTime(entry.modified_at)}</p>
                      </div>
                    </div>
                    <div class='flex justify-end gap-2'>
                      <Show when={entry.is_dir} fallback={
                        <button
                          type='button'
                          onClick={() => void downloadEntry(entry.path)}
                          disabled={pending() === `download-${entry.path}`}
                          class="inline-flex items-center justify-center rounded-md text-xs font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-8 px-3 disabled:opacity-50"
                        >
                          Download
                        </button>
                      }>
                        <button 
                          type='button' 
                          onClick={() => setCurrentPath(entry.path)}
                          class="inline-flex items-center justify-center rounded-md text-xs font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-8 px-3"
                        >
                          Open Folder
                        </button>
                      </Show>
                      <button
                        type='button'
                        onClick={() => void removeEntry(entry.path)}
                        disabled={pending() === `delete-${entry.path}`}
                        class="inline-flex items-center justify-center rounded-md text-xs font-medium transition-colors border border-input bg-background hover:bg-destructive hover:text-destructive-foreground hover:border-destructive shadow-sm h-8 px-3 disabled:opacity-50"
                      >
                        Delete
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
  <div class='rounded-xl border border-dashed border-border bg-card p-8 text-center'>
    <p class="font-semibold text-lg">No files here</p>
    <p class="text-sm text-muted-foreground mt-2">{props.path ? `The directory ${props.path} is empty.` : 'The selected mount root is empty.'}</p>
  </div>
);

export default ContainerDetail;
