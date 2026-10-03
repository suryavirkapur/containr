import Clock from "lucide-solid/icons/clock";
import Cog from "lucide-solid/icons/cog";
import Globe from "lucide-solid/icons/globe";
import Lock from "lucide-solid/icons/lock";
import { type Component, createMemo, For, type JSX, Show } from "solid-js";
import type { ServiceInput } from "../../api/platform";
import { cx, Field, Input, Select } from "../../components/ui";
import { useAppStore } from "../../context/AppStore";

export type ServiceType = NonNullable<ServiceInput["service_type"]>;

const TYPES: Array<{
	value: ServiceType;
	label: string;
	description: string;
	icon: () => JSX.Element;
}> = [
	{
		value: "web_service",
		label: "Web service",
		description: "Public HTTP with a URL",
		icon: () => <Globe />,
	},
	{
		value: "private_service",
		label: "Private service",
		description: "Reachable inside the project",
		icon: () => <Lock />,
	},
	{
		value: "background_worker",
		label: "Worker",
		description: "No inbound traffic",
		icon: () => <Cog />,
	},
	{
		value: "cron_job",
		label: "Cron job",
		description: "Runs on a schedule",
		icon: () => <Clock />,
	},
];

export const ServiceTypePicker: Component<{
	value: ServiceType;
	onChange: (value: ServiceType) => void;
}> = (props) => (
	<div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
		<For each={TYPES}>
			{(type) => (
				<button
					type="button"
					onClick={() => props.onChange(type.value)}
					class={cx(
						"flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors [&>svg]:h-4 [&>svg]:w-4",
						props.value === type.value
							? "border-accent bg-accent-soft shadow-[0_0_0_1px_var(--accent)]"
							: "border-border hover:border-border-strong hover:bg-surface-hover",
					)}
				>
					<span
						class={cx(
							"[&>svg]:h-4 [&>svg]:w-4",
							props.value === type.value ? "text-accent-soft-fg" : "text-fg-subtle",
						)}
					>
						{type.icon()}
					</span>
					<span class="text-[13px] font-medium">{type.label}</span>
					<span class="text-[12px] text-fg-subtle">{type.description}</span>
				</button>
			)}
		</For>
	</div>
);

/** existing projects (app groups) the caller owns */
export const useProjects = () => {
	const store = useAppStore();
	return createMemo(() => {
		const seen = new Map<string, string>();
		for (const service of store.state.services) {
			if (service.resource_kind === "app_service" && service.group_id) {
				seen.set(service.group_id, service.project_name ?? service.name);
			}
		}
		return [...seen.entries()]
			.map(([id, name]) => ({ id, name }))
			.sort((a, b) => a.name.localeCompare(b.name));
	});
};

export const ProjectField: Component<{
	value: string;
	onChange: (value: string) => void;
	hint?: JSX.Element;
	allowNew?: boolean;
}> = (props) => {
	const projects = useProjects();
	return (
		<Field
			label="Project"
			hint={
				props.hint ??
				"Services in the same project share a private network and can reach each other by name."
			}
		>
			<Select value={props.value} onChange={(event) => props.onChange(event.currentTarget.value)}>
				<Show when={props.allowNew !== false}>
					<option value="">New project</option>
				</Show>
				<For each={projects()}>
					{(project) => <option value={project.id}>{project.name}</option>}
				</For>
			</Select>
		</Field>
	);
};

export const PortField: Component<{
	value: string;
	onChange: (value: string) => void;
	hint?: JSX.Element;
}> = (props) => (
	<Field
		label="Container port"
		hint={props.hint ?? "The port your app listens on inside the container."}
	>
		<Input
			mono
			inputmode="numeric"
			value={props.value}
			onInput={(event) => props.onChange(event.currentTarget.value)}
		/>
	</Field>
);

export const nameProblem = (value: string): string | null => {
	if (!value.trim()) return "Give the service a name";
	if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(value.trim()))
		return "Use lowercase letters, numbers and dashes (it becomes a hostname)";
	return null;
};

export const FormSection: Component<{
	title: string;
	description?: JSX.Element;
	children: JSX.Element;
}> = (props) => (
	<section class="grid gap-x-10 gap-y-4 border-b border-border py-7 first:pt-0 last:border-0 md:grid-cols-[240px_1fr]">
		<div>
			<h2 class="text-[14px] font-semibold">{props.title}</h2>
			<Show when={props.description}>
				<p class="mt-1 text-[13px] text-fg-subtle">{props.description}</p>
			</Show>
		</div>
		<div class="min-w-0 space-y-4">{props.children}</div>
	</section>
);
