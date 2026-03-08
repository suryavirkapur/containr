import { Component, createResource, createSignal, For, Show } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { api, type components } from "../api";

type Database = components["schemas"]["DatabaseResponse"];

/**
 * fetches user's databases
 */
const fetchDatabases = async (): Promise<Database[]> => {
	const { data, error } = await api.GET("/api/databases");
	if (error) throw error;
	return data ?? [];
};

const describeError = (error: unknown) => {
	if (error instanceof Error) {
		return error.message;
	}

	if (
		typeof error === "object" &&
		error !== null &&
		"error" in error &&
		typeof error.error === "string"
	) {
		return error.error;
	}

	return "failed to create database";
};

/**
 * databases management page
 */
const Databases: Component = () => {
	const navigate = useNavigate();
	const [databases, { refetch }] = createResource(fetchDatabases);
	const [showCreate, setShowCreate] = createSignal(false);
	const [creating, setCreating] = createSignal(false);
	const [error, setError] = createSignal("");
	const [copiedId, setCopiedId] = createSignal<string | null>(null);

	// create form
	const [name, setName] = createSignal("");
	const [dbType, setDbType] = createSignal("postgresql");
	const [memoryMb, setMemoryMb] = createSignal("512");
	const [cpuLimit, setCpuLimit] = createSignal("1.0");

	const handleCreate = async (e: Event) => {
		e.preventDefault();
		setError("");
		setCreating(true);

		try {
			const { data, error: createError } = await api.POST("/api/databases", {
				body: {
					name: name(),
					db_type: dbType(),
					memory_limit_mb: parseInt(memoryMb()) || 512,
					cpu_limit: parseFloat(cpuLimit()) || 1.0,
				},
			});
			if (createError) throw createError;
			if (!data) throw new Error("database create response was empty");

			setShowCreate(false);
			setName("");
			await refetch();
			navigate(`/databases/${data.id}`);
		} catch (err) {
			setError(describeError(err));
			await refetch();
		} finally {
			setCreating(false);
		}
	};

	const handleDelete = async (id: string) => {
		if (!confirm("delete this database? data will be lost.")) return;

		const { error: deleteError } = await api.DELETE("/api/databases/{id}", {
			params: { path: { id } },
		});
		if (deleteError) throw deleteError;
		refetch();
	};

	const handleStart = async (id: string) => {
		const { error: startError } = await api.POST("/api/databases/{id}/start", {
			params: { path: { id } },
		});
		if (startError) throw startError;
		refetch();
	};

	const handleStop = async (id: string) => {
		const { error: stopError } = await api.POST("/api/databases/{id}/stop", {
			params: { path: { id } },
		});
		if (stopError) throw stopError;
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
			{/* header */}
			<div class="flex justify-between items-start mb-10">
				<div>
					<h1 class="text-2xl font-serif text-black">databases</h1>
					<p class="text-neutral-500 mt-1 text-sm">
						managed postgresql, mariadb, valkey, and qdrant instances
					</p>
				</div>
				<button
					onClick={() => setShowCreate(true)}
					class="px-4 py-2 bg-black text-white hover:bg-neutral-800 text-sm"
				>
					create database
				</button>
			</div>

			{/* loading */}
			<Show when={databases.loading}>
				<div class="animate-pulse space-y-4">
					<div class="h-20 bg-neutral-50 border border-neutral-200"></div>
					<div class="h-20 bg-neutral-50 border border-neutral-200"></div>
				</div>
			</Show>

			{/* empty */}
			<Show when={!databases.loading && databases()?.length === 0}>
				<div class="border border-dashed border-neutral-200 p-12 text-center">
					<p class="text-neutral-400 text-sm">no databases yet</p>
					<button
						onClick={() => setShowCreate(true)}
						class="mt-4 text-sm text-black hover:underline"
					>
						create your first database
					</button>
				</div>
			</Show>

			{/* list */}
			<Show when={!databases.loading && databases() && databases()!.length > 0}>
				<div class="space-y-4">
					<For each={databases()}>
						{(db) => (
							<div class="border border-neutral-200 p-5">
								<div class="flex justify-between items-start">
									<div>
										<div class="flex items-center gap-3">
											<span
												class={`w-2 h-2 ${statusIndicator(db.status)}`}
											></span>
											<A
												href={`/databases/${db.id}`}
												class="text-black font-medium hover:underline"
											>
												{db.name}
											</A>
											<span class="text-xs text-neutral-400">
												{db.db_type} {db.version}
											</span>
										</div>
										<p class="text-xs text-neutral-500 mt-2 font-mono">
											{db.internal_host}:{db.port}
										</p>
									</div>
									<div class="flex gap-2">
										<button
											onClick={() =>
												copyToClipboard(db.id, db.connection_string)
											}
											class="px-3 py-1 text-xs border border-neutral-300 text-neutral-700 hover:border-neutral-400"
										>
											{copiedId() === db.id ? "copied!" : "copy url"}
										</button>
										<Show when={db.status === "stopped"}>
											<button
												onClick={() => handleStart(db.id)}
												class="px-3 py-1 text-xs border border-neutral-300 text-neutral-700 hover:border-neutral-400"
											>
												start
											</button>
										</Show>
										<Show when={db.status === "running"}>
											<button
												onClick={() => handleStop(db.id)}
												class="px-3 py-1 text-xs border border-neutral-300 text-neutral-700 hover:border-neutral-400"
											>
												stop
											</button>
										</Show>
										<button
											onClick={() => handleDelete(db.id)}
											class="px-3 py-1 text-xs border border-neutral-300 text-neutral-500 hover:text-black hover:border-neutral-400"
										>
											delete
										</button>
									</div>
								</div>
								<div class="mt-3 pt-3 border-t border-neutral-100 flex gap-6 text-xs text-neutral-500">
									<span>{db.memory_limit_mb}mb ram</span>
									<span>{db.cpu_limit} cpu</span>
									<span>user: {db.username}</span>
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
						<h2 class="text-lg font-serif text-black mb-6">create database</h2>

						{error() && (
							<div class="border border-neutral-300 bg-neutral-50 text-neutral-700 px-4 py-3 mb-4 text-sm">
								{error()}
							</div>
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
									placeholder="my-database"
									required
								/>
							</div>

							<div>
								<label class="block text-xs text-neutral-500 uppercase tracking-wider mb-2">
									type
								</label>
								<select
									value={dbType()}
									onChange={(e) => setDbType(e.currentTarget.value)}
									class="w-full px-3 py-2 bg-white border border-neutral-300 text-black focus:border-black focus:outline-none text-sm"
								>
									<option value="postgresql">postgresql</option>
									<option value="mariadb">mariadb</option>
									<option value="valkey">valkey (redis)</option>
									<option value="qdrant">qdrant (vector)</option>
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

export default Databases;
