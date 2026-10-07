import { useSearchParams } from "@solidjs/router";
import { createResource, createSignal, onMount, Show } from "solid-js";
import { getRegistrationStatus, startGithubLink, unlinkGithub } from "../../api/auth";
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
import { GithubIcon } from "../../components/ui/brand";
import { confirm, toast } from "../../components/ui/overlay";
import { useAuth } from "../../context/AuthContext";
import { type ThemePreference, theme } from "../../context/ThemeContext";

const AccountSettings = () => {
	const auth = useAuth();
	const [current, setCurrent] = createSignal("");
	const [next, setNext] = createSignal("");
	const [confirmValue, setConfirmValue] = createSignal("");
	const [saving, setSaving] = createSignal(false);
	const [status] = createResource(getRegistrationStatus);
	const [linking, setLinking] = createSignal(false);
	const [searchParams, setSearchParams] = useSearchParams();
	const githubUser = () => auth.user()?.github_username;
	const hasPassword = () => auth.user()?.has_password ?? true;

	onMount(() => {
		if (searchParams.github === "linked") {
			toast.success("GitHub account linked", githubUser() ? `@${githubUser()}` : undefined);
			setSearchParams({ github: undefined }, { replace: true });
		}
	});

	const link = async () => {
		setLinking(true);
		try {
			window.location.assign(await startGithubLink());
		} catch (error) {
			toast.error("Could not start linking GitHub", error);
			setLinking(false);
		}
	};

	const unlink = async () => {
		const ok = await confirm({
			title: "Unlink GitHub?",
			description:
				"You won't be able to sign in with GitHub, and deploys stop using your GitHub token for private repositories. A GitHub App connected by an admin keeps working.",
			confirmLabel: "Unlink GitHub",
			danger: true,
		});
		if (!ok) return;
		setLinking(true);
		try {
			await unlinkGithub();
			await auth.refreshUser();
			toast.success("GitHub account unlinked");
		} catch (error) {
			toast.error("Could not unlink GitHub", error);
		} finally {
			setLinking(false);
		}
	};

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
			await auth.refreshUser();
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
						{ label: "Role", value: auth.user()?.is_admin ? "Administrator" : "Member" },
					]}
				/>
			</Card>

			<Card title="GitHub">
				<div class="-my-4">
					<SettingRow
						title={
							<span class="flex items-center gap-2">
								<GithubIcon class="text-fg-subtle" />
								{githubUser() ? `@${githubUser()}` : "Not linked"}
							</span>
						}
						description={
							githubUser()
								? hasPassword()
									? "You can sign in with GitHub, and deploys use your GitHub access for private repositories."
									: "You sign in with GitHub. Set a password below before unlinking, or you won't be able to sign in."
								: status()?.github_enabled === false
									? "GitHub sign-in isn't set up on this server. An admin can add a GitHub OAuth app's client ID and secret to containr.toml."
									: "Link your GitHub account to sign in with GitHub and deploy private repositories."
						}
					>
						<Show
							when={githubUser()}
							fallback={
								<Button
									variant="secondary"
									loading={linking()}
									disabled={!status()?.github_enabled}
									onClick={() => void link()}
								>
									Link GitHub account
								</Button>
							}
						>
							<Button
								variant="secondary"
								loading={linking()}
								disabled={!hasPassword()}
								onClick={() => void unlink()}
							>
								Unlink GitHub
							</Button>
						</Show>
					</SettingRow>
				</div>
			</Card>

			<Card
				title="Password"
				description={hasPassword() ? undefined : "Set a password to sign in without GitHub."}
			>
				<form class="max-w-md space-y-4" onSubmit={(event) => void submit(event)}>
					<Field
						label="Current password"
						hint={
							hasPassword() ? undefined : "Leave empty: this account doesn't have a password yet."
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
