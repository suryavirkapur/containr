import { useNavigate, useSearchParams } from "@solidjs/router";
import Package from "lucide-solid/icons/package";
import Plus from "lucide-solid/icons/plus";
import Trash from "lucide-solid/icons/trash";
import { createEffect, createResource, createSignal, For, Match, Switch } from "solid-js";
import { errorMessage } from "../../api/http";
import { createBucket, deleteBucket, listBuckets } from "../../api/storage";
import { useBreadcrumbs } from "../../components/layout/breadcrumbs";
import {
	Badge,
	Button,
	EmptyState,
	Field,
	Input,
	Notice,
	PageHeader,
	Skeleton,
} from "../../components/ui";
import { confirm, Modal, toast } from "../../components/ui/overlay";
import { formatBytes, timeAgo } from "../../lib/format";

const Buckets = () => {
	useBreadcrumbs(() => [{ label: "Storage" }]);
	const navigate = useNavigate();
	const [params, setParams] = useSearchParams();
	const [buckets, { refetch }] = createResource(listBuckets);
	const [open, setOpen] = createSignal(false);
	const [name, setName] = createSignal("");
	const [creating, setCreating] = createSignal(false);

	createEffect(() => {
		if (params.new) {
			setOpen(true);
			setParams({ new: undefined }, { replace: true });
		}
	});

	const valid = () => /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name().trim());

	const create = async () => {
		if (!valid()) return;
		setCreating(true);
		try {
			const bucket = await createBucket(name().trim());
			toast.success(`Created ${bucket.name}`);
			setOpen(false);
			setName("");
			navigate(`/storage/${bucket.id}`);
		} catch (error) {
			toast.error("Could not create the bucket", error);
		} finally {
			setCreating(false);
		}
	};

	const remove = async (id: string, bucketName: string) => {
		const ok = await confirm({
			title: `Delete ${bucketName}?`,
			description: "Every object in the bucket is deleted permanently.",
			confirmLabel: "Delete bucket",
			danger: true,
			typeToConfirm: bucketName,
		});
		if (!ok) return;
		try {
			await deleteBucket(id);
			toast.success(`Deleted ${bucketName}`);
			void refetch();
		} catch (error) {
			toast.error("Delete failed", error);
		}
	};

	return (
		<div class="animate-fade-in">
			<PageHeader
				title="Storage"
				description="S3-compatible buckets served by the built-in object store. Use them for uploads, backups and static assets."
				actions={
					<Button variant="primary" onClick={() => setOpen(true)}>
						<Plus />
						New bucket
					</Button>
				}
			/>
			<Switch>
				<Match when={buckets.loading && !buckets()}>
					<Skeleton class="h-32" />
				</Match>
				<Match when={buckets.error}>
					<Notice tone="danger" title="Object storage is unavailable">
						{errorMessage(buckets.error)}. Check the storage endpoint under Settings.
					</Notice>
				</Match>
				<Match when={!buckets()?.length}>
					<EmptyState
						icon={<Package />}
						title="No buckets yet"
						description="Create a bucket to get S3 credentials for your apps."
					>
						<Button variant="primary" onClick={() => setOpen(true)}>
							<Plus />
							New bucket
						</Button>
					</EmptyState>
				</Match>
				<Match when={true}>
					<div class="card overflow-x-auto">
						<table class="table min-w-[640px]">
							<thead>
								<tr>
									<th>Bucket</th>
									<th>Access</th>
									<th>Size</th>
									<th>Created</th>
									<th class="w-10" />
								</tr>
							</thead>
							<tbody>
								<For each={buckets()}>
									{(bucket) => (
										<tr class="row-link" onClick={() => navigate(`/storage/${bucket.id}`)}>
											<td>
												<div class="flex items-center gap-3">
													<span class="flex h-8 w-8 items-center justify-center rounded-md bg-surface-2 text-fg-subtle">
														<Package width={15} height={15} />
													</span>
													<div>
														<div class="font-medium">{bucket.name}</div>
														<div class="font-mono text-[11.5px] text-fg-subtle">
															{bucket.internal_endpoint}
														</div>
													</div>
												</div>
											</td>
											<td>
												<Badge tone={bucket.publicly_exposed ? "accent" : "neutral"}>
													{bucket.publicly_exposed ? "Public endpoint" : "Private"}
												</Badge>
											</td>
											<td class="tabular-nums text-fg-muted">{formatBytes(bucket.size_bytes)}</td>
											<td class="text-fg-subtle">{timeAgo(bucket.created_at)}</td>
											<td onClick={(event) => event.stopPropagation()}>
												<button
													type="button"
													class="btn btn-ghost btn-icon btn-sm hover:text-danger!"
													aria-label={`Delete ${bucket.name}`}
													onClick={() => void remove(bucket.id, bucket.name)}
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
			</Switch>

			<Modal
				open={open()}
				onClose={() => setOpen(false)}
				title="New bucket"
				description="Bucket names are global on this server."
				footer={
					<>
						<Button variant="secondary" onClick={() => setOpen(false)}>
							Cancel
						</Button>
						<Button
							variant="primary"
							loading={creating()}
							disabled={!valid()}
							onClick={() => void create()}
						>
							Create bucket
						</Button>
					</>
				}
			>
				<Field label="Name" hint="3–63 lowercase letters, numbers, dots or dashes.">
					<Input
						autofocus
						mono
						placeholder="media-uploads"
						value={name()}
						onInput={(event) => setName(event.currentTarget.value.toLowerCase())}
						onKeyDown={(event) => {
							if (event.key === "Enter") void create();
						}}
					/>
				</Field>
			</Modal>
		</div>
	);
};

export default Buckets;
