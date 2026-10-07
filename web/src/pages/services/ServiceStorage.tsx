import ChevronRight from "lucide-solid/icons/chevron-right";
import Download from "lucide-solid/icons/download";
import File from "lucide-solid/icons/file";
import Folder from "lucide-solid/icons/folder";
import FolderPlus from "lucide-solid/icons/folder-plus";
import HardDrive from "lucide-solid/icons/hard-drive";
import Plus from "lucide-solid/icons/plus";
import RefreshCw from "lucide-solid/icons/refresh-cw";
import Trash from "lucide-solid/icons/trash";
import Upload from "lucide-solid/icons/upload";
import {
	createEffect,
	createMemo,
	createResource,
	createSignal,
	For,
	Index,
	Match,
	on,
	Show,
	Switch as SolidSwitch,
} from "solid-js";
import { errorMessage } from "../../api/http";
import {
	createVolumeDirectory,
	deleteVolumeEntry,
	downloadVolumeEntry,
	listContainerMounts,
	listVolumeEntries,
	type MountInput,
	uploadVolumeFile,
} from "../../api/platform";
import {
	Button,
	Card,
	EmptyState,
	Input,
	Notice,
	SaveBar,
	Select,
	Skeleton,
	Switch,
} from "../../components/ui";
import { confirm, toast } from "../../components/ui/overlay";
import { useAuth } from "../../context/AuthContext";
import { formatBytes, timeAgo } from "../../lib/format";
import { useService } from "./context";

const VolumesEditor = () => {
	const ctx = useService();
	const auth = useAuth();
	const [mounts, setMounts] = createSignal<MountInput[]>([]);
	const [saving, setSaving] = createSignal(false);

	const initial = createMemo(() =>
		(ctx.settings()?.service.mounts ?? []).map((mount) => ({
			name: mount.name,
			target: mount.target,
			read_only: mount.read_only ?? false,
			host_path: (mount as MountInput).host_path ?? null,
			shared: (mount as MountInput).shared ?? false,
		})),
	);
	const reset = () => setMounts(initial().map((mount) => ({ ...mount })));
	createEffect(on(initial, reset));

	const dirty = () => JSON.stringify(mounts()) !== JSON.stringify(initial());
	const update = (index: number, patch: Partial<MountInput>) =>
		setMounts(mounts().map((mount, i) => (i === index ? { ...mount, ...patch } : mount)));

	const save = async () => {
		const cleaned = mounts().filter((mount) => mount.target.trim());
		for (const mount of cleaned) {
			if (!mount.target.startsWith("/")) {
				toast.error("Mount paths must be absolute", mount.target);
				return;
			}
			if (!mount.host_path && !mount.name.trim()) {
				toast.error("Give each volume a name");
				return;
			}
		}
		const request = ctx.serviceRequest({
			mounts: cleaned.map((mount) => ({
				name: mount.name.trim() || mount.target.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, ""),
				target: mount.target.trim(),
				read_only: mount.read_only,
				...(mount.host_path ? { host_path: mount.host_path.trim() } : { shared: mount.shared }),
			})),
		});
		if (!request) return;
		setSaving(true);
		await ctx.save({ service: request }, "Volumes saved");
		setSaving(false);
	};

	return (
		<Card
			title="Persistent volumes"
			description="Data written to these paths survives restarts and redeploys. Everything else in the container is reset on deploy."
		>
			<div class="space-y-2">
				<Show when={mounts().length > 0}>
					<div class="grid grid-cols-[1fr_1.4fr_auto_auto_32px] gap-2 px-0.5 text-[12px] text-fg-subtle">
						<span>{auth.user()?.is_admin ? "Volume name or host path" : "Volume name"}</span>
						<span>Path in container</span>
						<span>Shared</span>
						<span>Read-only</span>
						<span />
					</div>
				</Show>
				<Index
					each={mounts()}
					fallback={
						<div class="rounded-md border border-dashed border-border px-4 py-6 text-center text-[13px] text-fg-subtle">
							No persistent volumes. Add one for databases, uploads or anything that must survive a
							deploy.
						</div>
					}
				>
					{(mount, index) => (
						<div class="grid grid-cols-[1fr_1.4fr_auto_auto_32px] items-center gap-2">
							<Input
								mono
								placeholder={auth.user()?.is_admin ? "data or /srv/data" : "data"}
								value={mount().host_path ?? mount().name}
								onInput={(event) => {
									const value = event.currentTarget.value;
									if (auth.user()?.is_admin && value.startsWith("/")) {
										update(index, {
											host_path: value,
											name: mount().name || "host",
											shared: false,
										});
									} else {
										update(index, { name: value, host_path: null });
									}
								}}
							/>
							<Input
								mono
								placeholder="/var/lib/app"
								value={mount().target}
								onInput={(event) => update(index, { target: event.currentTarget.value })}
							/>
							<div class="flex justify-center">
								<Switch
									checked={mount().shared ?? false}
									disabled={Boolean(mount().host_path)}
									onChange={(value) => update(index, { shared: value })}
									label="Shared"
								/>
							</div>
							<div class="flex justify-center">
								<Switch
									checked={mount().read_only ?? false}
									onChange={(value) => update(index, { read_only: value })}
									label="Read-only"
								/>
							</div>
							<button
								type="button"
								class="btn btn-ghost btn-icon hover:text-danger!"
								aria-label="Remove volume"
								onClick={() => setMounts(mounts().filter((_, i) => i !== index))}
							>
								<Trash />
							</button>
						</div>
					)}
				</Index>
				<Button
					variant="secondary"
					size="sm"
					onClick={() =>
						setMounts([
							...mounts(),
							{ name: "", target: "", read_only: false, host_path: null, shared: false },
						])
					}
				>
					<Plus />
					Add volume
				</Button>
				<p class="hint">
					Shared volumes are the same directory for every service in this project that mounts the
					same name.
				</p>
				<Show when={auth.user()?.is_admin}>
					<p class="hint">
						Start the first field with / to bind a directory from the server (admins only).
					</p>
				</Show>
			</div>
			<SaveBar
				dirty={dirty()}
				saving={saving()}
				onSave={() => void save()}
				onReset={reset}
				label="Unsaved volume changes · redeploy to apply"
			/>
		</Card>
	);
};

const FileBrowser = () => {
	const ctx = useService();
	const [container, setContainer] = createSignal<string>("");
	const [mount, setMount] = createSignal<string>("");
	const [path, setPath] = createSignal("");
	const [busy, setBusy] = createSignal(false);
	const [folderName, setFolderName] = createSignal<string | null>(null);
	let uploadInput: HTMLInputElement | undefined;

	createEffect(() => {
		const ids = ctx.service()?.container_ids ?? [];
		if (!ids.includes(container())) setContainer(ids[0] ?? "");
	});

	const [mounts] = createResource(
		() => container() || null,
		(id) => listContainerMounts(id),
	);
	const usableMounts = () =>
		(mounts() ?? []).filter((item) => ["volume", "bind"].includes(item.mount_type.toLowerCase()));

	createEffect(() => {
		const list = usableMounts();
		if (!list.some((item) => item.destination === mount())) {
			setMount(list[0]?.destination ?? "");
			setPath("");
		}
	});

	const [entries, { refetch }] = createResource(
		() => (container() && mount() ? { id: container(), mount: mount(), path: path() } : null),
		(source) => listVolumeEntries(source.id, source.mount, source.path || undefined),
	);

	const sorted = createMemo(() =>
		[...(entries() ?? [])].sort((a, b) =>
			a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1,
		),
	);
	const segments = () => path().split("/").filter(Boolean);
	const join = (name: string) => (path() ? `${path()}/${name}` : name);

	const act = async (task: () => Promise<unknown>, message: string) => {
		setBusy(true);
		try {
			await task();
			toast.success(message);
			await refetch();
		} catch (error) {
			toast.error("File operation failed", error);
		} finally {
			setBusy(false);
		}
	};

	const remove = async (name: string, isDir: boolean) => {
		const ok = await confirm({
			title: `Delete ${name}?`,
			description: isDir
				? "The folder and everything in it is deleted."
				: "The file is deleted permanently.",
			confirmLabel: "Delete",
			danger: true,
		});
		if (ok) await act(() => deleteVolumeEntry(container(), mount(), join(name)), `Deleted ${name}`);
	};

	return (
		<Card
			title="Files"
			description="Browse and edit the contents of mounted volumes in a running container."
			flush
			actions={
				<Show when={container() && mount()}>
					<Button
						variant="ghost"
						size="sm"
						icon
						onClick={() => void refetch()}
						aria-label="Refresh"
					>
						<RefreshCw />
					</Button>
					<Button variant="secondary" size="sm" onClick={() => setFolderName("")} disabled={busy()}>
						<FolderPlus />
						New folder
					</Button>
					<Button
						variant="secondary"
						size="sm"
						onClick={() => uploadInput?.click()}
						disabled={busy()}
					>
						<Upload />
						Upload
					</Button>
					<input
						ref={uploadInput}
						type="file"
						multiple
						class="hidden"
						onChange={(event) => {
							const files = [...(event.currentTarget.files ?? [])];
							event.currentTarget.value = "";
							if (!files.length) return;
							void act(
								async () => {
									for (const file of files)
										await uploadVolumeFile(container(), mount(), path(), file);
								},
								files.length === 1 ? `Uploaded ${files[0].name}` : `Uploaded ${files.length} files`,
							);
						}}
					/>
				</Show>
			}
		>
			<SolidSwitch>
				<Match when={!ctx.service()?.container_ids.length}>
					<div class="p-4">
						<EmptyState
							icon={<HardDrive />}
							title="No running container"
							description="Start or deploy the service to browse its volumes."
						/>
					</div>
				</Match>
				<Match when={mounts.error}>
					<div class="p-4">
						<Notice tone="danger">{errorMessage(mounts.error)}</Notice>
					</div>
				</Match>
				<Match when={mounts() && usableMounts().length === 0}>
					<div class="p-4">
						<EmptyState
							icon={<HardDrive />}
							title="No volumes mounted"
							description="Add a persistent volume above, then redeploy."
						/>
					</div>
				</Match>
				<Match when={true}>
					<div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
						<Show when={(ctx.service()?.container_ids.length ?? 0) > 1}>
							<Select
								class="w-auto max-w-[220px]"
								value={container()}
								onChange={(event) => setContainer(event.currentTarget.value)}
							>
								<For each={ctx.service()?.container_ids}>
									{(id) => <option value={id}>{id}</option>}
								</For>
							</Select>
						</Show>
						<Select
							class="w-auto max-w-[260px] font-mono text-[12.5px]"
							value={mount()}
							onChange={(event) => {
								setMount(event.currentTarget.value);
								setPath("");
							}}
						>
							<For each={usableMounts()}>
								{(item) => <option value={item.destination}>{item.destination}</option>}
							</For>
						</Select>
						<nav class="flex min-w-0 flex-wrap items-center gap-1 text-[13px]">
							<button
								type="button"
								class="rounded px-1.5 py-0.5 text-fg-muted hover:bg-surface-hover hover:text-fg"
								onClick={() => setPath("")}
							>
								root
							</button>
							<For each={segments()}>
								{(segment, index) => (
									<>
										<ChevronRight width={13} height={13} class="text-fg-faint" />
										<button
											type="button"
											class="rounded px-1.5 py-0.5 text-fg-muted hover:bg-surface-hover hover:text-fg"
											onClick={() =>
												setPath(
													segments()
														.slice(0, index() + 1)
														.join("/"),
												)
											}
										>
											{segment}
										</button>
									</>
								)}
							</For>
						</nav>
					</div>
					<Show when={folderName() !== null}>
						<form
							class="flex items-center gap-2 border-b border-border px-4 py-2.5"
							onSubmit={(event) => {
								event.preventDefault();
								const name = folderName()?.trim();
								if (!name) return;
								setFolderName(null);
								void act(
									() => createVolumeDirectory(container(), mount(), join(name)),
									`Created ${name}`,
								);
							}}
						>
							<Folder width={15} height={15} class="text-fg-subtle" />
							<Input
								autofocus
								class="max-w-xs"
								placeholder="folder-name"
								value={folderName() ?? ""}
								onInput={(event) => setFolderName(event.currentTarget.value)}
							/>
							<Button type="submit" size="sm" variant="primary">
								Create
							</Button>
							<Button size="sm" variant="ghost" onClick={() => setFolderName(null)}>
								Cancel
							</Button>
						</form>
					</Show>
					<SolidSwitch>
						<Match when={entries.loading && !entries()}>
							<div class="space-y-2 p-4">
								<Skeleton class="h-8" />
								<Skeleton class="h-8" />
							</div>
						</Match>
						<Match when={entries.error}>
							<div class="p-4">
								<Notice tone="danger">{errorMessage(entries.error)}</Notice>
							</div>
						</Match>
						<Match when={true}>
							<div class="max-h-[480px] overflow-y-auto">
								<table class="table">
									<tbody>
										<Show when={path()}>
											<tr
												class="row-link"
												onClick={() => setPath(segments().slice(0, -1).join("/"))}
											>
												<td colSpan={4} class="text-fg-subtle">
													<span class="flex items-center gap-2.5">
														<Folder width={15} height={15} />
														..
													</span>
												</td>
											</tr>
										</Show>
										<For
											each={sorted()}
											fallback={
												<tr>
													<td colSpan={4} class="py-8 text-center text-fg-subtle">
														This folder is empty
													</td>
												</tr>
											}
										>
											{(entry) => (
												<tr
													class={entry.is_dir ? "row-link" : undefined}
													onClick={() => entry.is_dir && setPath(join(entry.name))}
												>
													<td>
														<span class="flex items-center gap-2.5">
															<Show
																when={entry.is_dir}
																fallback={<File width={15} height={15} class="text-fg-faint" />}
															>
																<Folder width={15} height={15} class="text-accent" />
															</Show>
															<span class="truncate">{entry.name}</span>
														</span>
													</td>
													<td class="w-28 text-right text-[12px] text-fg-subtle tabular-nums">
														{entry.is_dir ? "" : formatBytes(entry.size_bytes)}
													</td>
													<td class="w-36 text-[12px] text-fg-subtle">
														{timeAgo(entry.modified_at)}
													</td>
													<td class="w-24 text-right" onClick={(event) => event.stopPropagation()}>
														<Show when={!entry.is_dir}>
															<button
																type="button"
																class="btn btn-ghost btn-icon btn-sm"
																aria-label={`Download ${entry.name}`}
																onClick={() =>
																	void downloadVolumeEntry(
																		container(),
																		mount(),
																		join(entry.name),
																		entry.name,
																	).catch((error) => toast.error("Download failed", error))
																}
															>
																<Download />
															</button>
														</Show>
														<button
															type="button"
															class="btn btn-ghost btn-icon btn-sm hover:text-danger!"
															aria-label={`Delete ${entry.name}`}
															onClick={() => void remove(entry.name, entry.is_dir)}
														>
															<Trash />
														</button>
													</td>
												</tr>
											)}
										</For>
									</tbody>
								</table>
							</div>
						</Match>
					</SolidSwitch>
				</Match>
			</SolidSwitch>
		</Card>
	);
};

const ServiceStorage = () => {
	const ctx = useService();
	return (
		<div class="space-y-6">
			<Show when={ctx.isApp()}>
				<VolumesEditor />
			</Show>
			<FileBrowser />
		</div>
	);
};

export default ServiceStorage;
