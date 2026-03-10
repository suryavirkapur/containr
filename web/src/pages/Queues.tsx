import { A, useNavigate } from "@solidjs/router";
import { Component, createResource, createSignal, For, Show } from "solid-js";

import { api } from "../api";
import type { components } from "../api";
import { Button, PageHeader } from "../components/ui";

type Queue = components["schemas"]["QueueResponse"];

const buildAuthHeaders = (): Headers => {
	const headers = new Headers();
	const token = localStorage.getItem("containr_token");

	if (token) {
		headers.set("Authorization", `Bearer ${token}`);
	}

	return headers;
};

const handleUnauthorized = (response: Response) => {
	if (response.status !== 401) {
		return;
	}

	localStorage.removeItem("containr_token");
	window.location.href = "/login";
};

const readErrorMessage = async (response: Response): Promise<string> => {
	try {
		const data = (await response.json()) as { error?: string };
		if (typeof data.error === "string" && data.error.trim()) {
			return data.error;
		}
	} catch {
		// ignore malformed json and use the fallback below
	}

	return `request failed with status ${response.status}`;
};

const fetchQueues = async (): Promise<Queue[]> => {
	const { data, error } = await api.GET("/api/queues");
	if (error) throw error;
	return data ?? [];
};

const Queues: Component = () => {
	const navigate = useNavigate();
	const [queues, { refetch }] = createResource(fetchQueues);
	const [copiedId, setCopiedId] = createSignal<string | null>(null);

	const handleDelete = async (id: string) => {
		if (!confirm("delete this queue? data will be lost.")) return;

		const { error } = await api.DELETE("/api/queues/{id}", {
			params: { path: { id } },
		});
		if (error) throw error;
		await refetch();
	};

	const handleStart = async (id: string) => {
		const { error } = await api.POST("/api/queues/{id}/start", {
			params: { path: { id } },
		});
		if (error) throw error;
		await refetch();
	};

	const handleStop = async (id: string) => {
		const { error } = await api.POST("/api/queues/{id}/stop", {
			params: { path: { id } },
		});
		if (error) throw error;
		await refetch();
	};

	const handleRestart = async (id: string) => {
		const response = await fetch(`/api/services/${id}/restart`, {
			method: "POST",
			headers: buildAuthHeaders(),
		});

		handleUnauthorized(response);
		if (!response.ok) {
			throw new Error(await readErrorMessage(response));
		}

		await refetch();
	};

	const copyToClipboard = (id: string, text: string) => {
		void navigator.clipboard.writeText(text);
		setCopiedId(id);
		setTimeout(() => setCopiedId(null), 2000);
	};

	const statusIndicator = (status: string) => {
		switch (status) {
			case "running":
				return "bg-black";
			case "starting":
				return "animate-pulse bg-neutral-400";
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
					<Button
						onClick={() => navigate("/projects/new?kind=queue&type=rabbitmq")}
					>
						create queue
					</Button>
				}
			/>

			<Show when={queues.loading}>
				<div class="mt-10 animate-pulse space-y-4">
					<div class="h-20 border border-neutral-200 bg-neutral-50"></div>
					<div class="h-20 border border-neutral-200 bg-neutral-50"></div>
				</div>
			</Show>

			<Show when={!queues.loading && queues()?.length === 0}>
				<div class="mt-10 border border-dashed border-neutral-200 p-12 text-center">
					<p class="text-sm text-neutral-400">no queues yet</p>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => navigate("/projects/new?kind=queue&type=rabbitmq")}
					>
						create your first queue
					</Button>
				</div>
			</Show>

			<Show when={!queues.loading && queues() && queues()!.length > 0}>
				<div class="mt-10 space-y-4">
					<For each={queues()}>
						{(queue) => (
							<div class="border border-neutral-200 p-5">
								<div class="flex items-start justify-between gap-4">
									<div>
										<div class="flex items-center gap-3">
											<span
												class={`h-2 w-2 ${statusIndicator(queue.status)}`}
											></span>
											<A
												href={`/queues/${queue.id}`}
												class="font-medium text-black hover:underline"
											>
												{queue.name}
											</A>
											<span class="text-xs text-neutral-400">
												{queue.queue_type} {queue.version}
											</span>
										</div>
										<p class="mt-2 font-mono text-xs text-neutral-500">
											{queue.internal_host}:{queue.port}
										</p>
									</div>
									<div class="flex flex-wrap gap-2">
										<button
											onClick={() =>
												copyToClipboard(queue.id, queue.connection_string)
											}
											class="border border-neutral-300 px-3 py-1 text-xs text-neutral-700 hover:border-neutral-400"
										>
											{copiedId() === queue.id ? "copied!" : "copy url"}
										</button>
										<button
											onClick={() => void handleRestart(queue.id)}
											class="border border-neutral-300 px-3 py-1 text-xs text-neutral-700 hover:border-neutral-400"
										>
											restart
										</button>
										<Show when={queue.status === "stopped"}>
											<button
												onClick={() => handleStart(queue.id)}
												class="border border-neutral-300 px-3 py-1 text-xs text-neutral-700 hover:border-neutral-400"
											>
												start
											</button>
										</Show>
										<Show when={queue.status === "running"}>
											<button
												onClick={() => handleStop(queue.id)}
												class="border border-neutral-300 px-3 py-1 text-xs text-neutral-700 hover:border-neutral-400"
											>
												stop
											</button>
										</Show>
										<button
											onClick={() => handleDelete(queue.id)}
											class="border border-neutral-300 px-3 py-1 text-xs text-neutral-500 hover:border-neutral-400 hover:text-black"
										>
											delete
										</button>
									</div>
								</div>
								<div class="mt-3 flex gap-6 border-t border-neutral-100 pt-3 text-xs text-neutral-500">
									<span>{queue.memory_limit_mb}mb ram</span>
									<span>{queue.cpu_limit} cpu</span>
									<span>user: {queue.username}</span>
								</div>
							</div>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
};

export default Queues;
