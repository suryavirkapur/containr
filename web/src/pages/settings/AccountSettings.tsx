import { createSignal, Show } from "solid-js";
import { changePassword } from "../../api/platform";
import {
	Button,
	Card,
	DescriptionList,
	Field,
	PasswordInput,
	Segmented,
	SettingRow,
} from "../../components/ui";
import { toast } from "../../components/ui/overlay";
import { useAuth } from "../../context/AuthContext";
import { type ThemePreference, theme } from "../../context/ThemeContext";

const AccountSettings = () => {
	const auth = useAuth();
	const [current, setCurrent] = createSignal("");
	const [next, setNext] = createSignal("");
	const [confirmValue, setConfirmValue] = createSignal("");
	const [saving, setSaving] = createSignal(false);

	const problem = () => {
		if (next() && next().length < 8) return "Use at least 8 characters";
		if (confirmValue() && confirmValue() !== next()) return "Passwords don't match";
		return null;
	};

	const submit = async (event: Event) => {
		event.preventDefault();
		if (problem() || !next()) return;
		setSaving(true);
		try {
			await changePassword(current(), next());
			toast.success("Password changed");
			setCurrent("");
			setNext("");
			setConfirmValue("");
		} catch (error) {
			toast.error("Could not change the password", error);
		} finally {
			setSaving(false);
		}
	};

	return (
		<div class="space-y-6">
			<Card title="Profile">
				<DescriptionList
					class="-my-2.5"
					items={[
						{ label: "Email", value: auth.user()?.email ?? "–" },
						{
							label: "GitHub",
							value: auth.user()?.github_username
								? `@${auth.user()?.github_username}`
								: "Not linked",
						},
						{ label: "Role", value: auth.user()?.is_admin ? "Administrator" : "Member" },
					]}
				/>
			</Card>

			<Card
				title="Password"
				description={
					auth.user()?.github_username ? "Set a password to sign in without GitHub." : undefined
				}
			>
				<form class="max-w-md space-y-4" onSubmit={(event) => void submit(event)}>
					<Field
						label="Current password"
						hint={
							auth.user()?.github_username
								? "Leave empty if you only ever signed in with GitHub."
								: undefined
						}
					>
						<PasswordInput
							autocomplete="current-password"
							value={current()}
							onInput={(event) => setCurrent(event.currentTarget.value)}
						/>
					</Field>
					<Field label="New password">
						<PasswordInput
							autocomplete="new-password"
							value={next()}
							onInput={(event) => setNext(event.currentTarget.value)}
						/>
					</Field>
					<Field label="Confirm new password" error={problem()}>
						<PasswordInput
							autocomplete="new-password"
							value={confirmValue()}
							onInput={(event) => setConfirmValue(event.currentTarget.value)}
						/>
					</Field>
					<Button
						type="submit"
						variant="primary"
						loading={saving()}
						disabled={!next() || Boolean(problem()) || next() !== confirmValue()}
					>
						Change password
					</Button>
				</form>
			</Card>

			<Card title="Appearance">
				<div class="-my-4">
					<SettingRow title="Theme" description="Match your system or pick one.">
						<Segmented<ThemePreference>
							value={theme.preference()}
							onChange={(value) => theme.set(value)}
							options={[
								{ value: "system", label: "System" },
								{ value: "light", label: "Light" },
								{ value: "dark", label: "Dark" },
							]}
						/>
					</SettingRow>
				</div>
			</Card>

			<Show when={!auth.user()?.is_admin}>
				<p class="text-[12.5px] text-fg-subtle">Server settings are managed by an administrator.</p>
			</Show>
		</div>
	);
};

export default AccountSettings;
