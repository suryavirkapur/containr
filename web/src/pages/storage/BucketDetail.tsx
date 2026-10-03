import { useParams } from "@solidjs/router";
import { createResource, Show } from "solid-js";
import { errorMessage } from "../../api/http";
import { getBucket, getBucketConnection } from "../../api/storage";
import { useBreadcrumbs } from "../../components/layout/breadcrumbs";
import {
	Card,
	CopyButton,
	CopyField,
	DescriptionList,
	Field,
	Notice,
	PageHeader,
	Skeleton,
} from "../../components/ui";
import { formatBytes, formatDateTime } from "../../lib/format";

const BucketDetail = () => {
	const params = useParams();
	const [bucket] = createResource(() => params.id, getBucket);
	const [connection] = createResource(() => params.id, getBucketConnection);
	useBreadcrumbs(() => [
		{ label: "Storage", href: "/storage" },
		{ label: bucket()?.name ?? "Bucket" },
	]);

	const snippet = () => {
		const value = connection();
		if (!value) return "";
		return `S3_ENDPOINT=${value.internal_endpoint}
S3_BUCKET=${value.bucket_name}
S3_ACCESS_KEY_ID=${value.access_key}
S3_SECRET_ACCESS_KEY=${value.secret_key}
S3_FORCE_PATH_STYLE=true`;
	};

	return (
		<div class="animate-fade-in">
			<PageHeader eyebrow="Bucket" title={bucket()?.name ?? <Skeleton class="h-7 w-40" />} />
			<Show when={bucket.error || connection.error}>
				<Notice tone="danger" class="mb-6">
					{errorMessage(bucket.error ?? connection.error)}
				</Notice>
			</Show>
			<div class="grid gap-6 lg:grid-cols-[1fr_320px]">
				<Card
					title="Credentials"
					description="Use any S3 SDK or tool. Path-style addressing is required."
				>
					<Show when={connection()} fallback={<Skeleton class="h-48" />}>
						{(value) => (
							<div class="space-y-4">
								<Field label="Endpoint (inside containr)">
									<CopyField value={value().internal_endpoint} />
								</Field>
								<Show when={value().public_endpoint}>
									<Field label="Public endpoint">
										<CopyField value={value().public_endpoint ?? ""} />
									</Field>
								</Show>
								<div class="grid gap-4 sm:grid-cols-2">
									<Field label="Access key">
										<CopyField value={value().access_key} />
									</Field>
									<Field label="Secret key">
										<CopyField value={value().secret_key} secret />
									</Field>
								</div>
								<Field
									label="As environment variables"
									hint="Paste into a service's Environment tab."
								>
									<div class="relative">
										<pre class="overflow-x-auto rounded-md border border-border bg-surface-2 px-3 py-2.5 font-mono text-[12px] text-fg-muted">
											{snippet().replace(/(S3_SECRET_ACCESS_KEY=).*/, "$1••••••••")}
										</pre>
										<div class="absolute top-1.5 right-1.5">
											<CopyButton value={snippet()} label="Copy variables" />
										</div>
									</div>
								</Field>
								<Show when={value().uses_shared_credentials}>
									<Notice tone="warning">{value().note}</Notice>
								</Show>
							</div>
						)}
					</Show>
				</Card>
				<Card title="Details">
					<Show when={bucket()} fallback={<Skeleton class="h-24" />}>
						{(value) => (
							<DescriptionList
								class="-my-2.5"
								items={[
									{ label: "Size", value: formatBytes(value().size_bytes) },
									{ label: "Host", value: `${value().internal_host}:${value().port}`, mono: true },
									{ label: "Public", value: value().publicly_exposed ? "Yes" : "No" },
									{ label: "Created", value: formatDateTime(value().created_at) },
								]}
							/>
						)}
					</Show>
				</Card>
			</div>
		</div>
	);
};

export default BucketDetail;
