import { A, useNavigate } from "@solidjs/router";
import { Component, createResource, createSignal, For, Show } from "solid-js";

import { api, type components } from "../api";
import { Button, PageHeader } from "../components/ui";

type Database = components["schemas"]["DatabaseResponse"];

const fetchDatabases = async (): Promise<Database[]> => {
	const { data, error } = await api.GET("/api/databases");
	if (error) throw error;
	return data ?? [];
};

const Databases: Component = () => {
	const navigate = useNavigate();
	const [databases, { refetch }] = createResource(fetchDatabases);
	const [copiedId, setCopiedId] = createSignal<string | null>(null);

	const handleDelete = async (id: string) => {
		if (!confirm("delete this database? data will be lost.")) return;

		const { error } = await api.DELETE("/api/databases/{id}", {
			params: { path: { id } },
		});
		if (error) throw error;
		await refetch();
	};

	const handleStart = async (id: string) => {
		const { error } = await api.POST("/api/databases/{id}/start", {
			params: { path: { id } },
		});
		if (error) throw error;
		await refetch();
	};

	const handleStop = async (id: string) => {
		const { error } = await api.POST("/api/databases/{id}/stop", {
			params: { path: { id } },
		});
		if (error) throw error;
		await refetch();
	};

	const handleRestart = async (id: string) => {
		const { error } = await api.POST("/api/databases/{id}/restart", {
			params: { path: { id } },
		});
		if (error) throw error;
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
				title="databases"
				description="managed postgres, mariadb, valkey, and qdrant instances"
				actions={
					<Button
						onClick={() =>
							navigate("/projects/new?kind=database&type=postgresql")
						}
					>
						create database
					</Button>
				}
			/>

			<Show when={databases.loading}>
				<div class="mt-10 animate-pulse space-y-4">
					<div class="h-20 border border-neutral-200 bg-neutral-50"></div>
					<div class="h-20 border border-neutral-200 bg-neutral-50"></div>
				</div>
			</Show>

			<Show when={!databases.loading && databases()?.length === 0}>
				<div class="mt-10 border border-dashed border-neutral-200 p-12 text-center">
					<p class="text-sm text-neutral-400">no databases yet</p>
					<Button
						variant="ghost"
						size="sm"
						onClick={() =>
							navigate("/projects/new?kind=database&type=postgresql")
						}
					>
						create your first database
					</Button>
				</div>
			</Show>

			<Show when={!databases.loading && databases() && databases()!.length > 0}>
				<div class="mt-10 space-y-4">
					<For each={databases()}>
						{(db) => (
							<div class="border border-neutral-200 p-5">
								<div class="flex items-start justify-between gap-4">
									<div>
										<div class="flex items-center gap-3">
											<span
												class={`h-2 w-2 ${statusIndicator(db.status)}`}
											></span>
											<A
												href={`/databases/${db.id}`}
												class="font-medium text-black hover:underline"
											>
												{db.name}
											</A>
											<span class="text-xs text-neutral-400">
												{db.db_type} {db.version}
											</span>
										</div>
										<p class="mt-2 font-mono text-xs text-neutral-500">
											{db.internal_host}:{db.port}
										</p>
									</div>
									<div class="flex flex-wrap gap-2">
										<button
											onClick={() =>
												copyToClipboard(db.id, db.connection_string)
											}
											class="border border-neutral-300 px-3 py-1 text-xs text-neutral-700 hover:border-neutral-400"
										>
											{copiedId() === db.id ? "copied!" : "copy url"}
										</button>
										<button
											onClick={() => handleRestart(db.id)}
											class="border border-neutral-300 px-3 py-1 text-xs text-neutral-700 hover:border-neutral-400"
										>
											restart
										</button>
										<Show when={db.status === "stopped"}>
											<button
												onClick={() => handleStart(db.id)}
												class="border border-neutral-300 px-3 py-1 text-xs text-neutral-700 hover:border-neutral-400"
											>
												start
											</button>
										</Show>
										<Show when={db.status === "running"}>
											<button
												onClick={() => handleStop(db.id)}
												class="border border-neutral-300 px-3 py-1 text-xs text-neutral-700 hover:border-neutral-400"
											>
												stop
											</button>
										</Show>
										<button
											onClick={() => handleDelete(db.id)}
											class="border border-neutral-300 px-3 py-1 text-xs text-neutral-500 hover:border-neutral-400 hover:text-black"
										>
											delete
										</button>
									</div>
								</div>
								<div class="mt-3 flex gap-6 border-t border-neutral-100 pt-3 text-xs text-neutral-500">
									<span>{db.memory_limit_mb}mb ram</span>
									<span>{db.cpu_limit} cpu</span>
									<span>user: {db.username}</span>
								</div>
							</div>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
};

export default Databases;
