import {
  Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  Show,
} from "solid-js";
import { useParams, A } from "@solidjs/router";
import ContainerMonitor from "../components/ContainerMonitor";
import { api } from "../api";
import type { components } from "../api/schema";

type Queue = components["schemas"]["QueueResponse"] & { password?: string };
type ContainerListItem = components["schemas"]["ContainerListItem"];

const fetchQueue = async (id: string): Promise<Queue> => {
  const { data, error } = await api.GET("/api/queues/{id}", {
    params: { path: { id } },
  });
  if (error) throw error;
  return data;
};

const fetchContainers = async (): Promise<ContainerListItem[]> => {
  const { data, error } = await api.GET("/api/containers");
  if (error) throw error;
  return data;
};

const QueueDetail: Component = () => {
  const params = useParams();
  const [queue] = createResource(() => params.id, fetchQueue);
  const [containers] = createResource(fetchContainers);
  const [selectedContainer, setSelectedContainer] = createSignal("");
  const [showPassword, setShowPassword] = createSignal(false);

  const queueContainers = createMemo(() =>
    (containers() || []).filter(
      (item) =>
        item.resource_type === "queue" && item.resource_id === params.id,
    ),
  );

  createEffect(() => {
    if (!selectedContainer() && queueContainers().length > 0) {
      setSelectedContainer(queueContainers()[0].id);
    }
  });

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <div>
      <div class="flex items-center justify-between mb-8">
        <div>
          <div class="flex items-center gap-3">
            <A href="/queues" class="text-xs text-neutral-400 hover:text-black">
              queues
            </A>
            <span class="text-xs text-neutral-300">/</span>
            <span class="text-xs text-neutral-500">
              {queue()?.name || "..."}
            </span>
          </div>
          <h1 class="text-2xl font-serif text-black mt-2">{queue()?.name}</h1>
          <p class="text-neutral-500 mt-1 text-sm">
            {queue()?.queue_type} {queue()?.version}
          </p>
        </div>
      </div>

      <Show when={queue()}>
        {/* info grid */}
        <div class="border border-neutral-200 p-5 mb-6 text-sm text-neutral-600 grid grid-cols-2 gap-4">
          <div>
            <p class="text-xs text-neutral-400">host</p>
            <p class="font-mono text-neutral-800">
              {queue()!.internal_host}:{queue()!.port}
            </p>
          </div>
          <div>
            <p class="text-xs text-neutral-400">status</p>
            <p class="text-neutral-800">{queue()!.status}</p>
          </div>
          <div>
            <p class="text-xs text-neutral-400">resources</p>
            <p class="text-neutral-800">
              {queue()!.memory_limit_mb}mb / {queue()!.cpu_limit} cpu
            </p>
          </div>
          <div>
            <p class="text-xs text-neutral-400">created</p>
            <p class="text-neutral-800">
              {new Date(queue()!.created_at).toLocaleDateString()}
            </p>
          </div>
        </div>

        {/* credentials section */}
        <div class="mb-6">
          <h2 class="text-lg font-serif text-black mb-3">credentials</h2>
          <div class="border border-neutral-200 p-5 text-sm text-neutral-600 space-y-4">
            <div class="grid grid-cols-2 gap-4">
              <div>
                <p class="text-xs text-neutral-400">username</p>
                <div class="flex items-center gap-2">
                  <p class="font-mono text-neutral-800">{queue()!.username}</p>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(queue()!.username)}
                    class="text-xs text-neutral-400 hover:text-black"
                  >
                    copy
                  </button>
                </div>
              </div>
              <div>
                <p class="text-xs text-neutral-400">host:port</p>
                <div class="flex items-center gap-2">
                  <p class="font-mono text-neutral-800">
                    {queue()!.internal_host}:{queue()!.port}
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      copyToClipboard(
                        `${queue()!.internal_host}:${queue()!.port}`,
                      )
                    }
                    class="text-xs text-neutral-400 hover:text-black"
                  >
                    copy
                  </button>
                </div>
              </div>
            </div>
            <Show when={queue()!.password}>
              <div>
                <p class="text-xs text-neutral-400">password</p>
                <div class="flex items-center gap-2">
                  <p class="font-mono text-neutral-800">
                    {showPassword() ? queue()!.password : "••••••••••••"}
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword())}
                    class="text-xs text-neutral-400 hover:text-black"
                  >
                    {showPassword() ? "hide" : "show"}
                  </button>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(queue()!.password || "")}
                    class="text-xs text-neutral-400 hover:text-black"
                  >
                    copy
                  </button>
                </div>
              </div>
            </Show>
            <div>
              <p class="text-xs text-neutral-400">connection string</p>
              <div class="flex items-center gap-2">
                <p class="font-mono text-neutral-800 break-all">
                  {queue()!.connection_string}
                </p>
                <button
                  type="button"
                  onClick={() => copyToClipboard(queue()!.connection_string)}
                  class="text-xs text-neutral-400 hover:text-black flex-shrink-0"
                >
                  copy
                </button>
              </div>
            </div>
          </div>
        </div>
      </Show>

      {/* container monitor */}
      <div>
        <h2 class="text-lg font-serif text-black mb-3">container</h2>
        <Show
          when={queueContainers().length > 0}
          fallback={
            <div class="border border-dashed border-neutral-200 p-8 text-center text-neutral-400 text-sm">
              no running container for this queue
            </div>
          }
        >
          <ContainerMonitor containerId={selectedContainer()} />
        </Show>
      </div>
    </div>
  );
};

export default QueueDetail;
