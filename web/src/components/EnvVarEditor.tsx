import { Component, createEffect, createSignal, For, Show } from "solid-js";

import { EditableKeyValueEntry } from "../utils/keyValueEntries";

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
	const isDark = () => props.theme === "dark";

	const inputClass = () =>
		isDark()
			? "bg-neutral-900 border-neutral-700 text-white focus:border-neutral-400"
			: "bg-white border-neutral-300 text-black focus:border-black";
	const subtleTextClass = () =>
		isDark() ? "text-neutral-400" : "text-neutral-500";
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
		<section class="border border-neutral-200 p-4">
			<div class="flex justify-between items-center mb-4">
				<div>
					<h3 class="text-xs text-neutral-500 uppercase tracking-wider">
						{title()}
					</h3>
					<p class={`text-xs mt-2 ${subtleTextClass()}`}>{description()}</p>
				</div>
				<label class="flex items-center gap-2 cursor-pointer text-xs text-neutral-500">
					<span>bulk edit</span>
					<button
						type="button"
						onClick={toggleBulkEdit}
						class={`relative w-8 h-4 transition-colors ${
							bulkEdit() ? "bg-black" : "bg-neutral-300"
						}`}
					>
						<span
							class={`absolute top-0.5 w-3 h-3 bg-white transition-transform ${
								bulkEdit() ? "translate-x-4" : "translate-x-0.5"
							}`}
						/>
					</button>
				</label>
			</div>

			<Show when={bulkEdit()}>
				<textarea
					value={bulkText()}
					onInput={(event) => setBulkText(event.currentTarget.value)}
					placeholder={"export key=value\nanother_key=another_value"}
					class={`w-full h-36 px-3 py-2 border focus:outline-none text-sm font-mono resize-none ${inputClass()}`}
				/>
				<p class={`text-xs mt-2 ${subtleTextClass()}`}>{bulkHint()}</p>
			</Show>

			<Show when={!bulkEdit()}>
				<div class="space-y-2">
					<For each={props.envVars}>
						{(envVar, index) => (
							<div class="flex gap-2">
								<input
									type="text"
									placeholder="key"
									value={envVar.key}
									onInput={(event) =>
										updateEnvVar(index(), "key", event.currentTarget.value)
									}
									class={`flex-1 px-3 py-2 border text-sm focus:outline-none font-mono ${inputClass()}`}
								/>
								<input
									type={envVar.secret ? "password" : "text"}
									placeholder="value"
									value={envVar.value}
									onInput={(event) =>
										updateEnvVar(index(), "value", event.currentTarget.value)
									}
									class={`flex-[2] px-3 py-2 border text-sm focus:outline-none font-mono ${inputClass()}`}
								/>
								<button
									type="button"
									onClick={() =>
										updateEnvVar(index(), "secret", !envVar.secret)
									}
									class={`px-3 py-1 text-xs border ${
										envVar.secret
											? "border-black bg-black text-white"
											: "border-neutral-300 text-neutral-700 hover:border-neutral-400"
									}`}
								>
									secret
								</button>
								<button
									type="button"
									onClick={() => removeEnvVar(index())}
									class="px-3 py-1 text-neutral-500 hover:text-black border border-neutral-300"
								>
									remove
								</button>
							</div>
						)}
					</For>
				</div>

				<Show when={props.envVars.length === 0}>
					<div
						class={`text-center py-8 text-sm border border-dashed border-neutral-200 ${subtleTextClass()}`}
					>
						{emptyText()}
					</div>
				</Show>

				<button
					type="button"
					onClick={addEnvVar}
					class="mt-3 px-3 py-1.5 border border-neutral-300 text-neutral-700 hover:border-black hover:text-black text-xs"
				>
					{addLabel()}
				</button>
			</Show>
		</section>
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
