import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { Card, Notice, SaveBar } from "../../components/ui";
import { EnvEditor, type EnvRow } from "../../components/ui/editors";
import { useService } from "./context";

const normalize = (rows: EnvRow[]) =>
	JSON.stringify(
		rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value, row.secret]),
	);

const ServiceEnvironment = () => {
	const ctx = useService();
	const [serviceVars, setServiceVars] = createSignal<EnvRow[]>([]);
	const [sharedVars, setSharedVars] = createSignal<EnvRow[]>([]);
	const [saving, setSaving] = createSignal(false);

	const initialService = createMemo(() =>
		(ctx.settings()?.service.env_vars ?? []).map((env) => ({
			key: env.key,
			value: env.value,
			secret: env.secret,
		})),
	);
	const initialShared = createMemo(() =>
		(ctx.settings()?.env_vars ?? []).map((env) => ({
			key: env.key,
			value: env.value,
			secret: env.secret,
		})),
	);

	const reset = () => {
		setServiceVars(initialService());
		setSharedVars(initialShared());
	};
	createEffect(reset);

	const dirty = () =>
		normalize(serviceVars()) !== normalize(initialService()) ||
		normalize(sharedVars()) !== normalize(initialShared());

	const duplicate = () => {
		const keys = serviceVars()
			.map((row) => row.key.trim())
			.filter(Boolean);
		return keys.find((key, index) => keys.indexOf(key) !== index);
	};

	const clean = (rows: EnvRow[]) =>
		rows
			.filter((row) => row.key.trim())
			.map((row) => ({ key: row.key.trim(), value: row.value, secret: row.secret }));

	const save = async () => {
		const request = ctx.serviceRequest({ env_vars: clean(serviceVars()) });
		if (!request) return;
		setSaving(true);
		const ok = await ctx.save(
			{ env_vars: clean(sharedVars()), service: request },
			"Environment saved",
		);
		setSaving(false);
		if (ok) reset();
	};

	return (
		<div class="space-y-6">
			<Card
				title="Service variables"
				description="Injected into this service's containers at start. Lock a variable to hide its value after saving."
			>
				<EnvEditor
					rows={serviceVars()}
					onChange={setServiceVars}
					emptyLabel="No variables set for this service."
				/>
				<Show when={duplicate()}>
					<Notice tone="warning" class="mt-3">
						<code>{duplicate()}</code> is defined more than once; the last value wins.
					</Notice>
				</Show>
			</Card>
			<Card
				title="Shared variables"
				description="Available to every service in this project. Service variables override shared ones with the same key."
			>
				<EnvEditor rows={sharedVars()} onChange={setSharedVars} emptyLabel="No shared variables." />
			</Card>
			<SaveBar
				dirty={dirty()}
				saving={saving()}
				onSave={() => void save()}
				onReset={reset}
				label="Unsaved environment changes · redeploy to apply"
			/>
		</div>
	);
};

export default ServiceEnvironment;
