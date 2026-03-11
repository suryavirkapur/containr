import { A } from "@solidjs/router";
import { type Component, createResource, createSignal, For, Show } from "solid-js";
import { api, type components } from "../api";

type Bucket = components["schemas"]["BucketResponse"];

/** fetches user's storage buckets */
const fetchBuckets = async (): Promise<Bucket[]> => {
	const { data, error } = await api.GET("/api/buckets");
	if (error) throw error;
	return data;
};

/** storage buckets management page */
const Storage: Component = () => {
	const [buckets, { refetch }] = createResource(fetchBuckets);
	const [showCreate, setShowCreate] = createSignal(false);
	const [creating, setCreating] = createSignal(false);
	const [error, setError] = createSignal("");
	const [newBucket, setNewBucket] = createSignal<Bucket | null>(null);
	const [copiedField, setCopiedField] = createSignal<string | null>(null);
	const [name, setName] = createSignal("");

	const handleCreate = async (e: Event) => {
		e.preventDefault();
		setError("");
		setCreating(true);

		try {
			const { data: bucket, error: createError } = await api.POST("/api/buckets", {
				body: { name: name() },
			});
			if (createError) throw createError;
			setNewBucket(bucket);
			setShowCreate(false);
			setName("");
			refetch();
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setCreating(false);
		}
	};

	const handleDelete = async (id: string) => {
		if (!confirm("delete this bucket? all files will be lost.")) return;

		try {
			const { error } = await api.DELETE("/api/buckets/{id}", {
				params: { path: { id } },
			});
			if (error) throw error;
			refetch();
		} catch (err) {
			setError((err as Error).message);
		}
	};

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
		return parseFloat((bytes / k ** i).toFixed(2)) + " " + sizes[i];
	};

	return (
		<div>
			<div class="flex justify-between items-start mb-10">
				<div>
					<h1 class="text-2xl font-serif text-black">storage</h1>
					<p class="text-neutral-500 mt-1 text-sm">s3-compatible object storage via rustfs</p>
				</div>
				<button
					onClick={() => setShowCreate(true)}
					class="px-4 py-2 bg-black text-white hover:bg-neutral-800 text-sm"
				>
					create bucket
				</button>
			</div>

			<Show when={newBucket()}>
				<div class="fixed inset-0 bg-white/90 flex items-center justify-center z-50">
					<div class="bg-white border border-neutral-300 p-6 w-full max-w-lg">
						<h2 class="text-lg font-serif text-black mb-2">bucket created</h2>
						<p class="text-xs text-neutral-500 mb-6">
							the bucket is ready for containr services and optional public s3 access.
						</p>

						<div class="space-y-4">
							<div>
								<label class="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
									preferred endpoint
								</label>
								<div class="flex gap-2">
									<input
										type="text"
										readonly
										value={newBucket()!.endpoint}
										class="flex-1 px-3 py-2 bg-neutral-50 border border-neutral-200 text-black text-sm font-mono"
									/>
									<button
										onClick={() => copyToClipboard("endpoint", newBucket()!.endpoint)}
										class="px-3 py-2 border border-neutral-300 text-xs"
									>
										{copiedField() === "endpoint" ? "copied" : "copy"}
									</button>
								</div>
							</div>

							<div>
								<label class="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
									internal docker endpoint
								</label>
								<div class="flex gap-2">
									<input
										type="text"
										readonly
										value={newBucket()!.internal_endpoint}
										class="flex-1 px-3 py-2 bg-neutral-50 border border-neutral-200 text-black text-sm font-mono"
									/>
									<button
										onClick={() =>
											copyToClipboard("internal_endpoint", newBucket()!.internal_endpoint)
										}
										class="px-3 py-2 border border-neutral-300 text-xs"
									>
										{copiedField() === "internal_endpoint" ? "copied" : "copy"}
									</button>
								</div>
							</div>

							<Show when={newBucket()!.public_endpoint}>
								<div>
									<label class="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
										public s3 endpoint
									</label>
									<div class="flex gap-2">
										<input
											type="text"
											readonly
											value={newBucket()!.public_endpoint || ""}
											class="flex-1 px-3 py-2 bg-neutral-50 border border-neutral-200 text-black text-sm font-mono"
										/>
										<button
											onClick={() =>
												copyToClipboard("public_endpoint", newBucket()!.public_endpoint!)
											}
											class="px-3 py-2 border border-neutral-300 text-xs"
										>
											{copiedField() === "public_endpoint" ? "copied" : "copy"}
										</button>
									</div>
								</div>
							</Show>
						</div>

						<button
							onClick={() => setNewBucket(null)}
							class="w-full mt-6 px-4 py-2 bg-black text-white hover:bg-neutral-800 text-sm"
						>
							done
						</button>
					</div>
				</div>
			</Show>

			<Show when={buckets.loading}>
				<div class="animate-pulse space-y-4">
					<div class="h-20 bg-neutral-50 border border-neutral-200"></div>
					<div class="h-20 bg-neutral-50 border border-neutral-200"></div>
				</div>
			</Show>

			<Show when={!buckets.loading && buckets()?.length === 0}>
				<div class="border border-dashed border-neutral-200 p-12 text-center">
					<p class="text-neutral-400 text-sm">no buckets yet</p>
					<button
						onClick={() => setShowCreate(true)}
						class="mt-4 text-sm text-black hover:underline"
					>
						create your first bucket
					</button>
				</div>
			</Show>

			<Show when={!buckets.loading && buckets() && buckets()!.length > 0}>
				<div class="space-y-4">
					<For each={buckets()}>
						{(bucket) => (
							<div class="border border-neutral-200 p-5">
								<div class="flex justify-between items-start gap-4">
									<div class="min-w-0">
										<div class="flex items-center gap-3">
											<span class="w-2 h-2 bg-black"></span>
											<A
												href={`/storage/${bucket.id}`}
												class="text-black font-medium hover:underline"
											>
												{bucket.name}
											</A>
										</div>
										<p class="text-xs text-neutral-500 mt-2 font-mono break-all">
											{bucket.endpoint}
										</p>
										<p class="text-xs text-neutral-400 mt-1 font-mono break-all">
											internal: {bucket.internal_endpoint}
										</p>
									</div>
									<div class="flex gap-2 shrink-0">
										<button
											onClick={() => handleDelete(bucket.id)}
											class="px-3 py-1 text-xs border border-neutral-300 text-neutral-500 hover:text-black hover:border-neutral-400"
										>
											delete
										</button>
									</div>
								</div>
								<div class="mt-3 pt-3 border-t border-neutral-100 flex gap-6 text-xs text-neutral-500">
									<span>{bucket.publicly_exposed ? "public s3" : "internal only"}</span>
									<span>host: {bucket.internal_host}</span>
									<span>size: {formatBytes(bucket.size_bytes)}</span>
								</div>
							</div>
						)}
					</For>
				</div>
			</Show>

			<Show when={showCreate()}>
				<div class="fixed inset-0 bg-white/90 flex items-center justify-center z-50">
					<div class="bg-white border border-neutral-300 p-6 w-full max-w-md">
						<h2 class="text-lg font-serif text-black mb-6">create bucket</h2>

						{error() && (
							<div class="border border-neutral-300 bg-neutral-50 text-neutral-700 px-4 py-3 mb-4 text-sm">
								{error()}
							</div>
						)}

						<form onSubmit={handleCreate} class="space-y-5">
							<div>
								<label class="block text-xs text-neutral-500 uppercase tracking-wider mb-2">
									bucket name
								</label>
								<input
									type="text"
									value={name()}
									onInput={(e) => setName(e.currentTarget.value)}
									class="w-full px-3 py-2 bg-white border border-neutral-300 text-black focus:border-black focus:outline-none text-sm"
									placeholder="my-bucket"
									pattern="[a-z0-9-]+"
									required
								/>
								<p class="mt-1 text-xs text-neutral-400">
									lowercase letters, numbers, and hyphens only
								</p>
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
									{creating() ? "creating..." : "create"}
								</button>
							</div>
						</form>
					</div>
				</div>
			</Show>
		</div>
	);
};

export default Storage;
