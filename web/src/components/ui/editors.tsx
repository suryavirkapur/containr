import Eye from "lucide-solid/icons/eye";
import EyeOff from "lucide-solid/icons/eye-off";
import Lock from "lucide-solid/icons/lock";
import LockOpen from "lucide-solid/icons/lock-open";
import Plus from "lucide-solid/icons/plus";
import Trash2 from "lucide-solid/icons/trash";
import { type Component, createSignal, For, Index, Show } from "solid-js";
import { Button, cx, Input, Segmented, Textarea } from "./index";
import { toast } from "./overlay";

export const SECRET_MASK = "********";

export type EnvRow = { key: string; value: string; secret: boolean };

/** parses KEY=VALUE lines (dotenv style); comments and blanks are skipped */
export const parseDotenv = (text: string): EnvRow[] => {
	const rows: EnvRow[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const body = line.startsWith("export ") ? line.slice(7) : line;
		const index = body.indexOf("=");
		if (index <= 0) continue;
		const key = body.slice(0, index).trim();
		let value = body.slice(index + 1).trim();
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'")))
		) {
			value = value.slice(1, -1);
		}
		rows.push({ key, value, secret: false });
	}
	return rows;
};

const toDotenv = (rows: EnvRow[]) =>
	rows
		.filter((row) => row.key.trim())
		.map((row) => `${row.key}=${/\s|#/.test(row.value) ? JSON.stringify(row.value) : row.value}`)
		.join("\n");

/**
 * environment variable editor with a table mode and a raw .env mode.
 * secret values come back masked from the api; leaving them untouched keeps
 * the stored value.
 */
export const EnvEditor: Component<{
	rows: EnvRow[];
	onChange: (rows: EnvRow[]) => void;
	keyPlaceholder?: string;
	allowSecrets?: boolean;
	emptyLabel?: string;
	/** fetches the stored value of a masked secret so it can be shown */
	onReveal?: (key: string) => Promise<string>;
}> = (props) => {
	const [mode, setMode] = createSignal<"table" | "raw">("table");
	const [raw, setRaw] = createSignal("");
	// revealed secrets stay out of the rows so showing one isn't an edit
	const [revealed, setRevealed] = createSignal<Record<string, string>>({});
	const [visible, setVisible] = createSignal<Record<string, boolean>>({});
	const [revealing, setRevealing] = createSignal<string | null>(null);

	const shown = (row: EnvRow) => {
		const key = row.key.trim();
		if (row.value === SECRET_MASK && visible()[key] && key in revealed()) return revealed()[key];
		return row.value;
	};

	const toggleVisible = async (row: EnvRow) => {
		const key = row.key.trim();
		if (visible()[key]) {
			setVisible({ ...visible(), [key]: false });
			return;
		}
		if (row.value === SECRET_MASK && !(key in revealed()) && props.onReveal) {
			setRevealing(key);
			try {
				const value = await props.onReveal(key);
				setRevealed({ ...revealed(), [key]: value });
			} catch (error) {
				toast.error(`Could not show ${key}`, error);
				return;
			} finally {
				setRevealing(null);
			}
		}
		setVisible({ ...visible(), [key]: true });
	};

	const update = (index: number, patch: Partial<EnvRow>) => {
		const next = props.rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
		props.onChange(next);
	};

	const remove = (index: number) => props.onChange(props.rows.filter((_, i) => i !== index));
	const add = () => props.onChange([...props.rows, { key: "", value: "", secret: false }]);

	const switchMode = (next: "table" | "raw") => {
		if (next === mode()) return;
		if (next === "raw") {
			setRaw(toDotenv(props.rows));
		} else {
			applyRaw();
		}
		setMode(next);
	};

	const applyRaw = () => {
		// keep secret flags (and masked values) for keys that already existed
		const existing = new Map(props.rows.map((row) => [row.key.trim(), row]));
		props.onChange(
			parseDotenv(raw()).map((row) => {
				const previous = existing.get(row.key);
				return previous ? { ...row, secret: previous.secret } : row;
			}),
		);
	};

	const onPaste = (event: ClipboardEvent, index: number) => {
		const text = event.clipboardData?.getData("text") ?? "";
		if (!text.includes("=") || !text.includes("\n")) return;
		const parsed = parseDotenv(text);
		if (parsed.length < 2) return;
		event.preventDefault();
		const before = props.rows.slice(0, index).filter((row) => row.key || row.value);
		const after = props.rows.slice(index + 1);
		props.onChange([...before, ...parsed, ...after]);
	};

	return (
		<div>
			<div class="mb-3 flex items-center justify-between gap-3">
				<Segmented
					value={mode()}
					onChange={switchMode}
					options={[
						{ value: "table", label: "Table" },
						{ value: "raw", label: "Raw .env" },
					]}
				/>
				<Show when={mode() === "table"}>
					<span class="hidden text-[12px] text-fg-faint sm:inline">
						Tip: paste a .env file into any key field
					</span>
				</Show>
			</div>
			<Show
				when={mode() === "table"}
				fallback={
					<div>
						<Textarea
							mono
							rows={Math.max(8, props.rows.length + 2)}
							value={raw()}
							onInput={(event) => setRaw(event.currentTarget.value)}
							onBlur={applyRaw}
							placeholder={"DATABASE_URL=postgres://...\nNODE_ENV=production"}
							spellcheck={false}
						/>
						<p class="hint">
							One KEY=value per line. Secret values show as {SECRET_MASK}; leave them as-is to keep
							them.
						</p>
					</div>
				}
			>
				<div class="space-y-2">
					<Show when={props.rows.length === 0}>
						<div class="rounded-md border border-dashed border-border px-4 py-6 text-center text-[13px] text-fg-subtle">
							{props.emptyLabel ?? "No variables yet."}
						</div>
					</Show>
					<Index each={props.rows}>
						{(row, index) => (
							<div class="flex items-center gap-2">
								<Input
									mono
									class="w-[38%] shrink-0"
									placeholder={props.keyPlaceholder ?? "KEY"}
									value={row().key}
									onInput={(event) => update(index, { key: event.currentTarget.value })}
									onPaste={(event) => onPaste(event, index)}
									spellcheck={false}
									autocomplete="off"
								/>
								<Input
									mono
									class="min-w-0 flex-1"
									placeholder="value"
									type={
										row().secret && row().value !== SECRET_MASK && !visible()[row().key.trim()]
											? "password"
											: "text"
									}
									value={shown(row())}
									onFocus={(event) => {
										if (row().value === SECRET_MASK) event.currentTarget.select();
									}}
									onInput={(event) => update(index, { value: event.currentTarget.value })}
									spellcheck={false}
									autocomplete="off"
								/>
								<Show
									when={
										row().secret &&
										(row().value !== SECRET_MASK || props.onReveal) &&
										row().key.trim()
									}
								>
									<button
										type="button"
										title={visible()[row().key.trim()] ? "Hide value" : "Show value"}
										aria-label={visible()[row().key.trim()] ? "Hide value" : "Show value"}
										disabled={revealing() === row().key.trim()}
										onClick={() => void toggleVisible(row())}
										class="btn btn-ghost btn-icon shrink-0"
									>
										<Show when={visible()[row().key.trim()]} fallback={<Eye />}>
											<EyeOff />
										</Show>
									</button>
								</Show>
								<Show when={props.allowSecrets !== false}>
									<button
										type="button"
										title={row().secret ? "Secret: hidden after saving" : "Mark as secret"}
										aria-label="Toggle secret"
										onClick={() => update(index, { secret: !row().secret })}
										class={cx(
											"btn btn-ghost btn-icon shrink-0",
											row().secret && "text-warning! hover:text-warning!",
										)}
									>
										<Show when={row().secret} fallback={<LockOpen />}>
											<Lock />
										</Show>
									</button>
								</Show>
								<button
									type="button"
									class="btn btn-ghost btn-icon shrink-0 hover:text-danger!"
									aria-label="Remove variable"
									onClick={() => remove(index)}
								>
									<Trash2 />
								</button>
							</div>
						)}
					</Index>
					<Button variant="secondary" size="sm" onClick={add}>
						<Plus />
						Add variable
					</Button>
				</div>
			</Show>
		</div>
	);
};

/** editable list of short strings (domains, paths, ...) */
export const ListEditor: Component<{
	values: string[];
	onChange: (values: string[]) => void;
	placeholder?: string;
	addLabel?: string;
	mono?: boolean;
	validate?: (value: string) => string | null;
}> = (props) => {
	const [draft, setDraft] = createSignal("");
	const [error, setError] = createSignal<string | null>(null);

	const add = () => {
		const value = draft().trim();
		if (!value) return;
		const problem = props.validate?.(value) ?? null;
		if (problem) {
			setError(problem);
			return;
		}
		if (props.values.includes(value)) {
			setError("Already in the list");
			return;
		}
		props.onChange([...props.values, value]);
		setDraft("");
		setError(null);
	};

	return (
		<div class="space-y-2">
			<For each={props.values}>
				{(value) => (
					<div class="flex h-[34px] items-center gap-2 rounded-md border border-border bg-surface-2 pr-1 pl-3">
						<span
							class={cx(
								"min-w-0 flex-1 truncate text-[13px]",
								props.mono && "font-mono text-[12.5px]",
							)}
						>
							{value}
						</span>
						<button
							type="button"
							class="btn btn-ghost btn-icon btn-sm hover:text-danger!"
							aria-label={`Remove ${value}`}
							onClick={() => props.onChange(props.values.filter((item) => item !== value))}
						>
							<Trash2 />
						</button>
					</div>
				)}
			</For>
			<div class="flex gap-2">
				<Input
					mono={props.mono}
					placeholder={props.placeholder}
					value={draft()}
					aria-invalid={Boolean(error())}
					onInput={(event) => {
						setDraft(event.currentTarget.value);
						setError(null);
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							add();
						}
					}}
				/>
				<Button variant="secondary" onClick={add} disabled={!draft().trim()}>
					<Plus />
					{props.addLabel ?? "Add"}
				</Button>
			</div>
			<Show when={error()}>
				<p class="text-xs text-danger">{error()}</p>
			</Show>
		</div>
	);
};

export const isValidDomain = (value: string): string | null =>
	/^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i.test(value)
		? null
		: "Enter a domain like app.example.com";
