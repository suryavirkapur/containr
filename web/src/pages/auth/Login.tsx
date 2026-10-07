import { A, useNavigate, useSearchParams } from "@solidjs/router";
import { createResource, createSignal, Show } from "solid-js";
import { getRegistrationStatus } from "../../api/auth";
import { errorMessage } from "../../api/http";
import { AuthLayout } from "../../components/layout/AuthLayout";
import { Button, Field, Input, Notice, PasswordInput } from "../../components/ui";
import { GithubIcon } from "../../components/ui/brand";
import { useAuth } from "../../context/AuthContext";

/** only same-site paths, so ?next= can't send people elsewhere */
export const safeNext = (value: unknown) =>
	typeof value === "string" &&
	value.startsWith("/") &&
	!value.startsWith("//") &&
	!value.startsWith("/\\")
		? value
		: "/";

const Login = () => {
	const auth = useAuth();
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const [status] = createResource(getRegistrationStatus);
	const [email, setEmail] = createSignal("");
	const [password, setPassword] = createSignal("");
	const [error, setError] = createSignal<string | null>(null);
	const [saving, setSaving] = createSignal(false);

	const submit = async (event: Event) => {
		event.preventDefault();
		setSaving(true);
		setError(null);
		try {
			await auth.login(email().trim(), password());
			navigate(safeNext(params.next), { replace: true });
		} catch (requestError) {
			setError(errorMessage(requestError, "Sign in failed"));
		} finally {
			setSaving(false);
		}
	};

	return (
		<AuthLayout
			title="Sign in to containr"
			subtitle="Deploy and run containers on your own server."
			footer={
				<Show when={status()?.registration_open}>
					First time here?{" "}
					<A href="/register" class="font-medium text-fg underline-offset-4 hover:underline">
						Create the admin account
					</A>
				</Show>
			}
		>
			<form class="space-y-4" onSubmit={(event) => void submit(event)}>
				<Show when={error()}>
					<Notice tone="danger">{error()}</Notice>
				</Show>
				<Field label="Email" for="email">
					<Input
						id="email"
						type="email"
						autocomplete="email"
						required
						value={email()}
						onInput={(event) => setEmail(event.currentTarget.value)}
						placeholder="you@company.com"
					/>
				</Field>
				<Field label="Password" for="password">
					<PasswordInput
						id="password"
						autocomplete="current-password"
						required
						value={password()}
						onInput={(event) => setPassword(event.currentTarget.value)}
					/>
				</Field>
				<Button type="submit" variant="primary" size="lg" class="w-full" loading={saving()}>
					Sign in
				</Button>
				<Show when={status()?.github_enabled}>
					<div class="flex items-center gap-3 text-[12px] text-fg-faint">
						<div class="h-px flex-1 bg-border" />
						or
						<div class="h-px flex-1 bg-border" />
					</div>
					<a href="/api/auth/github" class="btn btn-secondary btn-lg w-full">
						<GithubIcon />
						Continue with GitHub
					</a>
				</Show>
			</form>
		</AuthLayout>
	);
};

export default Login;
