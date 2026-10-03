import { A, useNavigate } from "@solidjs/router";
import { createResource, createSignal, Match, Switch } from "solid-js";
import { getRegistrationStatus } from "../../api/auth";
import { errorMessage } from "../../api/http";
import { AuthLayout } from "../../components/layout/AuthLayout";
import { Button, Field, Input, Notice, PasswordInput, Skeleton } from "../../components/ui";
import { useAuth } from "../../context/AuthContext";

const Register = () => {
	const auth = useAuth();
	const navigate = useNavigate();
	const [status] = createResource(getRegistrationStatus);
	const [email, setEmail] = createSignal("");
	const [password, setPassword] = createSignal("");
	const [confirmPassword, setConfirmPassword] = createSignal("");
	const [error, setError] = createSignal<string | null>(null);
	const [saving, setSaving] = createSignal(false);

	const submit = async (event: Event) => {
		event.preventDefault();
		if (password().length < 8) {
			setError("Use at least 8 characters for the password.");
			return;
		}
		if (password() !== confirmPassword()) {
			setError("Passwords do not match.");
			return;
		}
		setSaving(true);
		setError(null);
		try {
			await auth.register(email().trim(), password());
			navigate("/");
		} catch (requestError) {
			setError(errorMessage(requestError, "Registration failed"));
		} finally {
			setSaving(false);
		}
	};

	return (
		<AuthLayout
			title="Create the admin account"
			subtitle="The first account owns this containr server."
			footer={
				<>
					Already set up?{" "}
					<A href="/login" class="font-medium text-fg underline-offset-4 hover:underline">
						Sign in
					</A>
				</>
			}
		>
			<Switch>
				<Match when={status.loading}>
					<div class="space-y-3">
						<Skeleton class="h-9 w-full" />
						<Skeleton class="h-9 w-full" />
					</div>
				</Match>
				<Match when={status() && !status()?.registration_open}>
					<Notice title="Registration is closed">
						This server already has an administrator. Ask them to create an account for you.
					</Notice>
				</Match>
				<Match when={true}>
					<form class="space-y-4" onSubmit={(event) => void submit(event)}>
						<Field label="Email" for="email">
							<Input
								id="email"
								type="email"
								autocomplete="email"
								required
								value={email()}
								onInput={(event) => setEmail(event.currentTarget.value)}
							/>
						</Field>
						<Field label="Password" for="password" hint="At least 8 characters.">
							<PasswordInput
								id="password"
								autocomplete="new-password"
								required
								value={password()}
								onInput={(event) => setPassword(event.currentTarget.value)}
							/>
						</Field>
						<Field label="Confirm password" for="confirm">
							<PasswordInput
								id="confirm"
								autocomplete="new-password"
								required
								value={confirmPassword()}
								onInput={(event) => setConfirmPassword(event.currentTarget.value)}
							/>
						</Field>
						{error() && <Notice tone="danger">{error()}</Notice>}
						<Button type="submit" variant="primary" size="lg" class="w-full" loading={saving()}>
							Create account
						</Button>
					</form>
				</Match>
			</Switch>
		</AuthLayout>
	);
};

export default Register;
