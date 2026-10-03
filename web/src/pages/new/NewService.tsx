import { A } from "@solidjs/router";
import ArrowRight from "lucide-solid/icons/arrow-right";
import Database from "lucide-solid/icons/database";
import FileUp from "lucide-solid/icons/file-up";
import GitBranch from "lucide-solid/icons/git-branch";
import Package from "lucide-solid/icons/package";
import Store from "lucide-solid/icons/store";
import { type Component, For, type JSX } from "solid-js";
import { useBreadcrumbs } from "../../components/layout/breadcrumbs";
import { PageHeader } from "../../components/ui";

const OPTIONS: Array<{
	href: string;
	title: string;
	description: string;
	icon: () => JSX.Element;
	color: string;
}> = [
	{
		href: "/new/git",
		title: "Git repository",
		description: "Build from GitHub or any Git URL with a Dockerfile. Redeploys on every push.",
		icon: () => <GitBranch />,
		color: "#6d6afe",
	},
	{
		href: "/new/image",
		title: "Docker image",
		description: "Run any image from Docker Hub, GHCR or your private registry.",
		icon: () => <Package />,
		color: "#0ea5e9",
	},
	{
		href: "/new/upload",
		title: "Upload or Dockerfile",
		description: "Deploy a tarball of your project or paste a Dockerfile. No Git needed.",
		icon: () => <FileUp />,
		color: "#a855f7",
	},
	{
		href: "/new/database",
		title: "Database",
		description: "PostgreSQL, MariaDB, Redis, Qdrant or RabbitMQ with persistent storage.",
		icon: () => <Database />,
		color: "#14b8a6",
	},
	{
		href: "/apps",
		title: "One-click app",
		description: "WordPress, Ghost, n8n, Plausible, Uptime Kuma and dozens more, preconfigured.",
		icon: () => <Store />,
		color: "#f59e0b",
	},
];

const Option: Component<(typeof OPTIONS)[number]> = (props) => (
	<A href={props.href} class="card card-interactive group flex items-start gap-4 p-5">
		<span
			class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg [&>svg]:h-5 [&>svg]:w-5"
			style={{
				color: props.color,
				background: `color-mix(in srgb, ${props.color} 14%, transparent)`,
			}}
		>
			{props.icon()}
		</span>
		<span class="min-w-0 flex-1">
			<span class="block text-[14px] font-semibold">{props.title}</span>
			<span class="mt-1 block text-[13px] text-fg-subtle">{props.description}</span>
		</span>
		<ArrowRight
			width={16}
			height={16}
			class="mt-1 text-fg-faint transition-transform group-hover:translate-x-0.5 group-hover:text-fg"
		/>
	</A>
);

const NewService = () => {
	useBreadcrumbs(() => [{ label: "New service" }]);
	return (
		<div class="animate-fade-in mx-auto max-w-3xl">
			<PageHeader
				title="What do you want to deploy?"
				description="Pick a source. You can change everything later."
			/>
			<div class="grid gap-3">
				<For each={OPTIONS}>{(option) => <Option {...option} />}</For>
			</div>
		</div>
	);
};

export default NewService;
