import { A } from "@solidjs/router";
import { Component, For } from "solid-js";
import { Badge, Card, CardContent, CardHeader, CardTitle, PageHeader } from "../components/ui";

interface QuickAction {
	href: string;
	label: string;
	title: string;
	description: string;
	badge: string;
}

const repositoryActions: QuickAction[] = [
	{
		href: "/services/new/repo?type=web_service",
		label: "web service",
		title: "git repository",
		description: "deploy a public service from a repository with automatic routing.",
		badge: "repository",
	},
	{
		href: "/services/new/repo?type=private_service",
		label: "private service",
		title: "internal runtime",
		description: "deploy a service that stays private inside the service network.",
		badge: "repository",
	},
	{
		href: "/services/new/repo?type=background_worker",
		label: "background worker",
		title: "worker runtime",
		description: "deploy a long-running worker without a public endpoint.",
		badge: "repository",
	},
	{
		href: "/services/new/repo?type=cron_job",
		label: "cron service",
		title: "scheduled runtime",
		description: "deploy a scheduled service with a cron expression.",
		badge: "repository",
	},
];

const templateActions: QuickAction[] = [
	{
		href: "/services/new/template?type=postgresql",
		label: "postgres service",
		title: "postgresql template",
		description: "launch managed PostgreSQL with connection details in one place.",
		badge: "template",
	},
	{
		href: "/services/new/template?type=redis",
		label: "valkey service",
		title: "valkey template",
		description: "launch a redis-compatible cache or broker service.",
		badge: "template",
	},
	{
		href: "/services/new/template?type=mariadb",
		label: "mariadb service",
		title: "mariadb template",
		description: "launch a mysql-compatible relational service.",
		badge: "template",
	},
	{
		href: "/services/new/template?type=qdrant",
		label: "qdrant service",
		title: "qdrant template",
		description: "launch a vector search service with optional public access.",
		badge: "template",
	},
	{
		href: "/services/new/template?type=rabbitmq",
		label: "rabbitmq service",
		title: "rabbitmq template",
		description: "launch a managed messaging service with ready-made credentials.",
		badge: "template",
	},
];

const CreateFlow: Component = () => {
	return (
		<div class="space-y-8">
			<PageHeader
				eyebrow="create"
				title="new service"
				description="launch a brand new service from a repository or managed template."
			/>

			<Card>
				<CardHeader>
					<p class="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
						git repository
					</p>
					<CardTitle class="mt-2">connect source code</CardTitle>
				</CardHeader>
				<CardContent class="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
					<For each={repositoryActions}>
						{(action) => (
							<A href={action.href} class="block h-full">
								<Card variant="hover" class="h-full">
									<CardContent class="flex h-full flex-col space-y-4">
										<div class="flex items-center justify-between gap-3">
											<p class="font-serif text-xl">{action.label}</p>
											<Badge variant="outline">{action.badge}</Badge>
										</div>
										<div class="flex-1 space-y-2">
											<p class="text-sm font-medium text-[var(--foreground)]">{action.title}</p>
											<p class="text-sm leading-6 text-[var(--muted-foreground)]">
												{action.description}
											</p>
										</div>
									</CardContent>
								</Card>
							</A>
						)}
					</For>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<p class="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--muted-foreground)]">
						managed templates
					</p>
					<CardTitle class="mt-2">launch a database or resource</CardTitle>
				</CardHeader>
				<CardContent class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					<For each={templateActions}>
						{(action) => (
							<A href={action.href} class="block h-full">
								<Card variant="hover" class="h-full">
									<CardContent class="flex h-full flex-col space-y-4">
										<div class="flex items-center justify-between gap-3">
											<p class="font-serif text-xl">{action.label}</p>
											<Badge variant="outline">{action.badge}</Badge>
										</div>
										<div class="flex-1 space-y-2">
											<p class="text-sm font-medium text-[var(--foreground)]">{action.title}</p>
											<p class="text-sm leading-6 text-[var(--muted-foreground)]">
												{action.description}
											</p>
										</div>
									</CardContent>
								</Card>
							</A>
						)}
					</For>
				</CardContent>
			</Card>
		</div>
	);
};

export default CreateFlow;
