import { Show, type Component } from "solid-js";

import {
	Alert,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Skeleton,
} from "../ui";
import { describeError } from "./formatters";

interface ServiceLogsPanelProps {
	logMarkup: string;
	loading: boolean;
	error: unknown;
	onRefresh: () => void | Promise<void>;
}

export const ServiceLogsPanel: Component<ServiceLogsPanelProps> = (props) => (
	<Card>
		<CardHeader class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
			<div>
				<CardTitle>service logs</CardTitle>
				<CardDescription>
					Recent logs from the canonical service runtime endpoint.
				</CardDescription>
			</div>
			<Button variant="outline" onClick={() => void props.onRefresh()}>
				refresh logs
			</Button>
		</CardHeader>
		<CardContent>
			<Show when={props.error}>
				<Alert variant="destructive" title="failed to load logs">
					{describeError(props.error)}
				</Alert>
			</Show>
			<Show when={props.loading}>
				<Skeleton class="h-80 w-full" />
			</Show>
			<Show when={!props.loading}>
				<div
					class="min-h-80 overflow-x-auto rounded-[var(--radius)] border border-[var(--border)] bg-black px-4 py-4 font-mono text-xs leading-6 text-white"
					innerHTML={props.logMarkup}
				/>
			</Show>
		</CardContent>
	</Card>
);
