import {
	Component,
	createEffect,
	createResource,
	createSignal,
	For,
	Show,
} from "solid-js";
import { A, useSearchParams } from "@solidjs/router";
import { api } from "../api";
import type { components } from "../api";
import { Alert, Button, PageHeader } from "../components/ui";

type Queue = components["schemas"]["QueueResponse"];

/**
 * fetches user's queues
 */
const fetchQueues = async (): Promise<Queue[]> => {
	const { data, error } = await api.GET("/api/queues");
	if (error) throw error;
	return data ?? [];
};

/**
 * queues management page
 */
const Queues: Component = () => {
	const [searchParams] = useSearchParams();
	const [queues, { refetch }] = createResource(fetchQueues);
	const [showCreate, setShowCreate] = createSignal(false);
	const [creating, setCreating] = createSignal(false);
	const [error, setError] = createSignal("");
	const [copiedId, setCopiedId] = createSignal<string | null>(null);

	// create form
	const [name, setName] = createSignal("");
	const [queueType, setQueueType] = createSignal("rabbitmq");
	const [memoryMb, setMemoryMb] = createSignal("512");
	const [cpuLimit, setCpuLimit] = createSignal("1.0");

	createEffect(() => {
		if (searchParams.create === "1") {
			setShowCreate(true);
		}

		if (searchParams.type === "rabbitmq") {
			setQueueType("rabbitmq");
		}
	});

	const handleCreate = async (e: Event) => {
		e.preventDefault();
		setError("");
		setCreating(true);

		try {
			const { error } = await api.POST("/api/queues", {
				body: {
					name: name(),
					queue_type: queueType(),
					memory_limit_mb: parseInt(memoryMb()) || 512,
					cpu_limit: parseFloat(cpuLimit()) || 1.0,
				},
			});
			if (error) throw error;

			setShowCreate(false);
			setName("");
			refetch();
		} catch (err: any) {
			setError(err.message);
		} finally {
			setCreating(false);
		}
	};

	const handleDelete = async (id: string) => {
		if (!confirm("delete this queue? data will be lost.")) return;

		const { error } = await api.DELETE("/api/queues/{id}", {
			params: { path: { id } },
		});
		if (error) throw error;
		refetch();
	};

	const handleStart = async (id: string) => {
		const { error } = await api.POST("/api/queues/{id}/start", {
			params: { path: { id } },
		});
		if (error) throw error;
		refetch();
	};

	const handleStop = async (id: string) => {
		const { error } = await api.POST("/api/queues/{id}/stop", {
			params: { path: { id } },
		});
		if (error) throw error;
		refetch();
	};

	const copyToClipboard = (id: string, text: string) => {
		navigator.clipboard.writeText(text);
		setCopiedId(id);
		setTimeout(() => setCopiedId(null), 2000);
	};

	const statusIndicator = (status: string) => {
		switch (status) {
			case "running":
				return "bg-black";
			case "starting":
				return "bg-neutral-400 animate-pulse";
			case "stopped":
				return "bg-neutral-200";
			case "failed":
				return "bg-neutral-300";
			default:
				return "bg-neutral-200";
		}
	};

	return (
		<div>
			<PageHeader
				title="queues"
				description="managed rabbitmq instances"
				actions={
					<Button onClick={() => setShowCreate(true)}>create queue</Button>
				}
			/>

			{/* loading */}
			<Show when={queues.loading}>
				<div class="animate-pulse space-y-4">
					<div class="h-20 bg-neutral-50 border border-neutral-200"></div>
					<div class="h-20 bg-neutral-50 border border-neutral-200"></div>
				</div>
			</Show>

			{/* empty */}
			<Show when={!queues.loading && queues()?.length === 0}>
				<div class="mt-10 border border-dashed border-neutral-200 p-12 text-center">
					<p class="text-neutral-400 text-sm">no queues yet</p>
					<Button variant="ghost" size="sm" onClick={() => setShowCreate(true)}>
						create your first queue
					</Button>
				</div>
			</Show>

			{/* list */}
			<Show when={!queues.loading && queues() && queues()!.length > 0}>
				<div class="mt-10 space-y-4">
					<For each={queues()}>
						{(queue) => (
							<div class="border border-neutral-200 p-5">
								<div class="flex justify-between items-start">
									<div>
										<div class="flex items-center gap-3">
											<span
												class={`w-2 h-2 ${statusIndicator(queue.status)}`}
											></span>
											<A
												href={`/queues/${queue.id}`}
												class="text-black font-medium hover:underline"
											>
												{queue.name}
											</A>
											<span class="text-xs text-neutral-400">
												{queue.queue_type} {queue.version}
											</span>
										</div>
										<p class="text-xs text-neutral-500 mt-2 font-mono">
											{queue.internal_host}:{queue.port}
										</p>
									</div>
									<div class="flex gap-2">
										<button
											onClick={() =>
												copyToClipboard(queue.id, queue.connection_string)
											}
											class="px-3 py-1 text-xs border border-neutral-300 text-neutral-700 hover:border-neutral-400"
										>
											{copiedId() === queue.id ? "copied!" : "copy url"}
										</button>
										<Show when={queue.status === "stopped"}>
											<button
												onClick={() => handleStart(queue.id)}
												class="px-3 py-1 text-xs border border-neutral-300 text-neutral-700 hover:border-neutral-400"
											>
												start
											</button>
										</Show>
										<Show when={queue.status === "running"}>
											<button
												onClick={() => handleStop(queue.id)}
												class="px-3 py-1 text-xs border border-neutral-300 text-neutral-700 hover:border-neutral-400"
											>
												stop
											</button>
										</Show>
										<button
											onClick={() => handleDelete(queue.id)}
											class="px-3 py-1 text-xs border border-neutral-300 text-neutral-500 hover:text-black hover:border-neutral-400"
										>
											delete
										</button>
									</div>
								</div>
								<div class="mt-3 pt-3 border-t border-neutral-100 flex gap-6 text-xs text-neutral-500">
									<span>{queue.memory_limit_mb}mb ram</span>
									<span>{queue.cpu_limit} cpu</span>
									<span>user: {queue.username}</span>
								</div>
							</div>
						)}
					</For>
				</div>
			</Show>

			{/* create modal */}
			<Show when={showCreate()}>
				<div class="fixed inset-0 bg-white/90 flex items-center justify-center z-50">
					<div class="bg-white border border-neutral-300 p-6 w-full max-w-md">
						<h2 class="text-lg font-serif text-black mb-6">create queue</h2>

						{error() && (
							<Alert variant="destructive" title="create failed">
								{error()}
							</Alert>
						)}

						<form onSubmit={handleCreate} class="space-y-5">
							<div>
								<label class="block text-xs text-neutral-500 uppercase tracking-wider mb-2">
									name
								</label>
								<input
									type="text"
									value={name()}
									onInput={(e) => setName(e.currentTarget.value)}
									class="w-full px-3 py-2 bg-white border border-neutral-300 text-black focus:border-black focus:outline-none text-sm"
									placeholder="my-queue"
									required
								/>
							</div>

							<div>
								<label class="block text-xs text-neutral-500 uppercase tracking-wider mb-2">
									type
								</label>
								<select
									value={queueType()}
									onChange={(e) => setQueueType(e.currentTarget.value)}
									class="w-full px-3 py-2 bg-white border border-neutral-300 text-black focus:border-black focus:outline-none text-sm"
								>
									<option value="rabbitmq">rabbitmq</option>
								</select>
							</div>

							<div class="grid grid-cols-2 gap-4">
								<div>
									<label class="block text-xs text-neutral-500 uppercase tracking-wider mb-2">
										memory (mb)
									</label>
									<input
										type="number"
										value={memoryMb()}
										onInput={(e) => setMemoryMb(e.currentTarget.value)}
										class="w-full px-3 py-2 bg-white border border-neutral-300 text-black focus:border-black focus:outline-none text-sm"
									/>
								</div>
								<div>
									<label class="block text-xs text-neutral-500 uppercase tracking-wider mb-2">
										cpu cores
									</label>
									<input
										type="number"
										step="0.1"
										value={cpuLimit()}
										onInput={(e) => setCpuLimit(e.currentTarget.value)}
										class="w-full px-3 py-2 bg-white border border-neutral-300 text-black focus:border-black focus:outline-none text-sm"
									/>
								</div>
							</div>

							<div class="flex gap-2 pt-2">
								<Button
									type="button"
									variant="outline"
									onClick={() => setShowCreate(false)}
									class="flex-1"
								>
									cancel
								</Button>
								<Button type="submit" disabled={creating()} class="flex-1">
									{creating() ? "creating..." : "create"}
								</Button>
							</div>
						</form>
					</div>
				</div>
			</Show>
		</div>
	);
};

export default Queues;
