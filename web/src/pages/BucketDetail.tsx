import { A, useNavigate, useParams } from "@solidjs/router";
import { Component, createResource, createSignal, Show } from "solid-js";
import { api, components } from "../api";

type Bucket = components["schemas"]["BucketResponse"];
type BucketConnection = components["schemas"]["BucketConnectionResponse"];

/** fetches bucket details */
const fetchBucket = async (id: string): Promise<Bucket> => {
  const { data, error } = await api.GET("/api/buckets/{id}", {
    params: { path: { id } },
  });
  if (error) throw error;
  return data;
};

/** fetches bucket connection details */
const fetchBucketConnection = async (id: string): Promise<BucketConnection> => {
  const { data, error } = await api.GET("/api/buckets/{id}/connection", {
    params: { path: { id } },
  });
  if (error) throw error;
  return data;
};

/** bucket detail page */
const BucketDetail: Component = () => {
  const params = useParams();
  const navigate = useNavigate();
  const bucketId = () => params.id;
  const [bucket] = createResource(
    () => bucketId() ?? null,
    (id) => fetchBucket(id),
  );
  const [connection] = createResource(
    () => bucketId() ?? null,
    (id) => fetchBucketConnection(id),
  );
  const [deleting, setDeleting] = createSignal(false);
  const [copiedField, setCopiedField] = createSignal<string | null>(null);

  const copyToClipboard = (field: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 bytes";
    const k = 1024;
    const sizes = ["bytes", "kb", "mb", "gb", "tb"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const handleDelete = async () => {
    const id = bucketId();
    if (!id) return;
    if (!confirm("delete this bucket? all files will be lost.")) return;
    setDeleting(true);
    try {
      const { error } = await api.DELETE("/api/buckets/{id}", {
        params: { path: { id } },
      });
      if (error) throw error;
      navigate("/storage");
    } catch (err) {
      console.error(err);
      setDeleting(false);
    }
  };

  return (
    <div>
      <div class="flex items-center justify-between mb-8">
        <div>
          <div class="flex items-center gap-3">
            <A href="/storage" class="text-xs text-neutral-400 hover:text-black">
              storage
            </A>
            <span class="text-xs text-neutral-300">/</span>
            <span class="text-xs text-neutral-500">{bucket()?.name || "..."}</span>
          </div>
          <h1 class="text-2xl font-serif text-black mt-2">{bucket()?.name}</h1>
          <p class="text-neutral-500 mt-1 text-sm">
            s3-compatible object storage for containr workloads
          </p>
        </div>
        <button
          onClick={handleDelete}
          disabled={deleting()}
          class="px-4 py-2 border border-neutral-300 text-neutral-500 hover:text-black hover:border-neutral-400 disabled:opacity-50 text-sm"
        >
          {deleting() ? "deleting..." : "delete bucket"}
        </button>
      </div>

      <Show when={bucket.loading}>
        <div class="animate-pulse space-y-4">
          <div class="h-40 bg-neutral-50 border border-neutral-200"></div>
        </div>
      </Show>

      <Show when={!bucket.loading && bucket() && connection()}>
        <div class="space-y-6">
          <div class="border border-neutral-200">
            <div class="border-b border-neutral-200 px-5 py-3">
              <h2 class="text-sm font-serif text-black">s3 endpoints</h2>
            </div>
            <div class="p-5 space-y-4">
              <div>
                <label class="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
                  preferred endpoint
                </label>
                <div class="flex items-center gap-2">
                  <code class="flex-1 px-3 py-2 bg-neutral-50 border border-neutral-200 text-black text-sm font-mono">
                    {connection()!.endpoint}
                  </code>
                  <button
                    onClick={() => copyToClipboard("endpoint", connection()!.endpoint)}
                    class="px-3 py-2 text-xs border border-neutral-300 text-neutral-500 hover:text-black"
                  >
                    {copiedField() === "endpoint" ? "copied" : "copy"}
                  </button>
                </div>
              </div>

              <div>
                <label class="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
                  internal docker endpoint
                </label>
                <div class="flex items-center gap-2">
                  <code class="flex-1 px-3 py-2 bg-neutral-50 border border-neutral-200 text-black text-sm font-mono">
                    {connection()!.internal_endpoint}
                  </code>
                  <button
                    onClick={() =>
                      copyToClipboard("internal_endpoint", connection()!.internal_endpoint)
                    }
                    class="px-3 py-2 text-xs border border-neutral-300 text-neutral-500 hover:text-black"
                  >
                    {copiedField() === "internal_endpoint" ? "copied" : "copy"}
                  </button>
                </div>
              </div>

              <Show when={connection()!.public_endpoint}>
                <div>
                  <label class="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
                    public s3 endpoint
                  </label>
                  <div class="flex items-center gap-2">
                    <code class="flex-1 px-3 py-2 bg-neutral-50 border border-neutral-200 text-black text-sm font-mono">
                      {connection()!.public_endpoint}
                    </code>
                    <button
                      onClick={() =>
                        copyToClipboard("public_endpoint", connection()!.public_endpoint!)
                      }
                      class="px-3 py-2 text-xs border border-neutral-300 text-neutral-500 hover:text-black"
                    >
                      {copiedField() === "public_endpoint" ? "copied" : "copy"}
                    </button>
                  </div>
                </div>
              </Show>

              <div class="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p class="text-xs text-neutral-400">internal host</p>
                  <p class="text-neutral-800 font-mono">{connection()!.internal_host}</p>
                </div>
                <div>
                  <p class="text-xs text-neutral-400">port</p>
                  <p class="text-neutral-800 font-mono">{connection()!.port}</p>
                </div>
              </div>
            </div>
          </div>

          <div class="border border-neutral-200">
            <div class="border-b border-neutral-200 px-5 py-3">
              <h2 class="text-sm font-serif text-black">credentials</h2>
            </div>
            <div class="p-5 space-y-4">
              <div>
                <label class="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
                  access key
                </label>
                <div class="flex items-center gap-2">
                  <code class="flex-1 px-3 py-2 bg-neutral-50 border border-neutral-200 text-black text-sm font-mono">
                    {connection()!.access_key}
                  </code>
                  <button
                    onClick={() => copyToClipboard("access_key", connection()!.access_key)}
                    class="px-3 py-2 text-xs border border-neutral-300 text-neutral-500 hover:text-black"
                  >
                    {copiedField() === "access_key" ? "copied" : "copy"}
                  </button>
                </div>
              </div>

              <div>
                <label class="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
                  secret key
                </label>
                <div class="flex items-center gap-2">
                  <code class="flex-1 px-3 py-2 bg-neutral-50 border border-neutral-200 text-black text-sm font-mono">
                    {connection()!.secret_key}
                  </code>
                  <button
                    onClick={() => copyToClipboard("secret_key", connection()!.secret_key)}
                    class="px-3 py-2 text-xs border border-neutral-300 text-neutral-500 hover:text-black"
                  >
                    {copiedField() === "secret_key" ? "copied" : "copy"}
                  </button>
                </div>
              </div>

              <p class="text-xs text-neutral-500">{connection()!.note}</p>
            </div>
          </div>

          <div class="border border-neutral-200">
            <div class="border-b border-neutral-200 px-5 py-3">
              <h2 class="text-sm font-serif text-black">bucket info</h2>
            </div>
            <div class="p-5 grid grid-cols-2 gap-4 text-sm">
              <div>
                <p class="text-xs text-neutral-400">size</p>
                <p class="text-neutral-800 font-mono">
                  {formatBytes(bucket()!.size_bytes)}
                </p>
              </div>
              <div>
                <p class="text-xs text-neutral-400">created</p>
                <p class="text-neutral-800">
                  {new Date(bucket()!.created_at).toLocaleDateString()}
                </p>
              </div>
              <div>
                <p class="text-xs text-neutral-400">public exposure</p>
                <p class="text-neutral-800">
                  {bucket()!.publicly_exposed ? "enabled" : "internal only"}
                </p>
              </div>
              <div>
                <p class="text-xs text-neutral-400">bucket name</p>
                <p class="text-neutral-800 font-mono">{bucket()!.name}</p>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default BucketDetail;
