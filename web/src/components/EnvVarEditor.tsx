import { Component, createEffect, createSignal, For, Show } from "solid-js";

import { EditableKeyValueEntry } from "../utils/keyValueEntries";
import {
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	Input,
	Switch,
	Textarea,
} from "./ui";

interface EnvVarEditorProps {
	envVars: EditableKeyValueEntry[];
	onChange: (envVars: EditableKeyValueEntry[]) => void;
	theme?: "light" | "dark";
	title?: string;
	description?: string;
	emptyText?: string;
	addLabel?: string;
	bulkHint?: string;
}

const EnvVarEditor: Component<EnvVarEditorProps> = (props) => {
	const [bulkEdit, setBulkEdit] = createSignal(false);
	const [bulkText, setBulkText] = createSignal("");
	const title = () => props.title ?? "environment variables";
	const description = () =>
		props.description ?? "shared across every service in this group";
	const emptyText = () =>
		props.emptyText ?? "no environment variables configured";
	const addLabel = () => props.addLabel ?? "add key/value pair";
	const bulkHint = () =>
		props.bulkHint ??
		".env format works. existing secret keys keep their secret flag.";

	createEffect(() => {
		if (!bulkEdit()) {
			setBulkText(envVarsToBulkText(props.envVars));
		}
	});

	const toggleBulkEdit = () => {
		if (bulkEdit()) {
			props.onChange(bulkTextToEnvVars(bulkText(), props.envVars));
		} else {
			setBulkText(envVarsToBulkText(props.envVars));
		}
		setBulkEdit(!bulkEdit());
	};

	const updateEnvVar = (
		index: number,
		field: keyof EditableKeyValueEntry,
		value: string | boolean,
	) => {
		props.onChange(
			props.envVars.map((envVar, envIndex) =>
				envIndex === index ? { ...envVar, [field]: value } : envVar,
			),
		);
	};

	const removeEnvVar = (index: number) => {
		props.onChange(props.envVars.filter((_, envIndex) => envIndex !== index));
	};

	const addEnvVar = () => {
		props.onChange([...props.envVars, { key: "", value: "", secret: false }]);
	};

	return (
		<Card variant="muted">
			<CardHeader class="flex flex-wrap items-center justify-between gap-4">
				<div>
					<CardTitle class="text-base">{title()}</CardTitle>
					<p class="mt-2 text-sm text-[var(--muted-foreground)]">
						{description()}
					</p>
				</div>
				<div class="flex items-center gap-3 text-xs uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
					<span>bulk edit</span>
					<Switch checked={bulkEdit()} onChange={() => toggleBulkEdit()} />
				</div>
			</CardHeader>

			<CardContent class="space-y-4">
				<Show when={bulkEdit()}>
					<Textarea
						label="bulk variables"
						description={bulkHint()}
					value={bulkText()}
					onInput={(event) => setBulkText(event.currentTarget.value)}
						placeholder={"export key=value\nanother_key=another_value"}
						class="h-40 resize-none font-mono"
					/>
				</Show>

				<Show when={!bulkEdit()}>
					<div class="space-y-3">
						<For each={props.envVars}>
							{(envVar, index) => (
								<div class="grid gap-3 border border-[var(--border)] bg-[var(--card)] p-3 md:grid-cols-[1fr_1.6fr_auto_auto]">
									<Input
										type="text"
										placeholder="key"
										value={envVar.key}
										onInput={(event) =>
											updateEnvVar(index(), "key", event.currentTarget.value)
										}
										class="font-mono"
									/>
									<Input
										type={envVar.secret ? "password" : "text"}
										placeholder="value"
										value={envVar.value}
										onInput={(event) =>
											updateEnvVar(index(), "value", event.currentTarget.value)
										}
										class="font-mono"
									/>
									<Button
										type="button"
										variant={envVar.secret ? "primary" : "outline"}
										size="sm"
										onClick={() =>
											updateEnvVar(index(), "secret", !envVar.secret)
										}
									>
										secret
									</Button>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={() => removeEnvVar(index())}
									>
										remove
									</Button>
								</div>
							)}
						</For>
					</div>

					<Show when={props.envVars.length === 0}>
						<div class="border border-dashed border-[var(--border-strong)] px-4 py-8 text-center text-sm text-[var(--muted-foreground)]">
							{emptyText()}
						</div>
					</Show>

					<Button type="button" variant="secondary" size="sm" onClick={addEnvVar}>
						{addLabel()}
					</Button>
				</Show>
			</CardContent>
		</Card>
	);
};

function envVarsToBulkText(envVars: EditableKeyValueEntry[]) {
	return envVars.map((envVar) => `${envVar.key}=${envVar.value}`).join("\n");
}

function bulkTextToEnvVars(
	text: string,
	existingEnvVars: EditableKeyValueEntry[],
): EditableKeyValueEntry[] {
	const existingByKey = new Map(
		existingEnvVars.map((envVar) => [envVar.key, envVar]),
	);

	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"))
		.map((line) => {
			const normalizedLine = line.startsWith("export ")
				? line.slice("export ".length)
				: line;
			const separatorIndex = normalizedLine.indexOf("=");
			if (separatorIndex < 0) {
				return null;
			}

			const key = normalizedLine.slice(0, separatorIndex).trim();
			if (!key) {
				return null;
			}

			const existing = existingByKey.get(key);
			return {
				key,
				value: normalizedLine.slice(separatorIndex + 1),
				secret: existing?.secret ?? false,
			};
		})
		.filter((envVar): envVar is EditableKeyValueEntry => envVar !== null);
}

export default EnvVarEditor;
