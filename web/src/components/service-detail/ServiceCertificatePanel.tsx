import { For, Show, type Component } from "solid-js";

import type { ServiceCertificate } from "../../api/services";
import {
	Alert,
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	EmptyState,
	Skeleton,
} from "../ui";
import {
	certificateStatusVariant,
	describeError,
	formatCertificateStatus,
	formatDate,
} from "./formatters";

interface ServiceCertificatePanelProps {
	domains: string[];
	certificates?: ServiceCertificate[];
	loading: boolean;
	error: unknown;
	reissuingAll: boolean;
	reissuingDomain: string | null;
	onRefresh: () => void | Promise<void>;
	onReissue: (domain?: string) => void | Promise<void>;
}

export const ServiceCertificatePanel: Component<ServiceCertificatePanelProps> = (
	props,
) => (
	<Card>
		<CardHeader class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
			<div>
				<CardTitle>certificates</CardTitle>
				<CardDescription>
					Domain-level certificate status and reissue controls for this
					service.
				</CardDescription>
			</div>
			<div class="flex flex-wrap gap-2">
				<Button variant="outline" onClick={() => void props.onRefresh()}>
					refresh certificates
				</Button>
				<Button
					variant="secondary"
					isLoading={props.reissuingAll}
					onClick={() => void props.onReissue()}
				>
					reissue all
				</Button>
			</div>
		</CardHeader>
		<CardContent class="space-y-4">
			<Show when={props.error}>
				<Alert variant="destructive" title="failed to load certificates">
					{describeError(props.error)}
				</Alert>
			</Show>
			<Show when={props.loading}>
				<Skeleton class="h-40 w-full" />
			</Show>
			<Show
				when={!props.loading && props.domains.length > 0}
				fallback={
					<EmptyState
						title="no custom domains"
						description="Add one or more custom domains to manage service certificates."
					/>
				}
			>
				<div class="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
					<For each={props.domains}>
						{(domain) => {
							const certificate = () =>
								props.certificates?.find((entry) => entry.domain === domain);

							return (
								<div class="grid gap-4 bg-[var(--card)] px-4 py-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_auto] lg:items-center">
									<div class="space-y-2">
										<p class="font-mono text-sm text-[var(--foreground)]">
											{domain}
										</p>
										<p class="text-xs text-[var(--muted-foreground)]">
											issued {formatDate(certificate()?.issued_at)}
											{" · "}
											expires {formatDate(certificate()?.expires_at)}
										</p>
									</div>
									<div class="flex flex-wrap items-center gap-2">
										<Badge
											variant={certificateStatusVariant(
												certificate()?.status ?? "none",
											)}
										>
											{formatCertificateStatus(certificate()?.status ?? "none")}
										</Badge>
									</div>
									<div class="flex justify-start lg:justify-end">
										<Button
											variant="outline"
											isLoading={props.reissuingDomain === domain}
											onClick={() => void props.onReissue(domain)}
										>
											reissue
										</Button>
									</div>
								</div>
							);
						}}
					</For>
				</div>
			</Show>
		</CardContent>
	</Card>
);
