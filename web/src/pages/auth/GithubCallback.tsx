import { A, useNavigate } from "@solidjs/router";
import { createSignal, onMount, Show } from "solid-js";
import { finishGithubLogin } from "../../api/auth";
import { errorMessage } from "../../api/http";
import { finishGithubAppInstall, finishGithubAppSetup } from "../../api/settings";
import { AuthLayout } from "../../components/layout/AuthLayout";
import { Notice, Spinner } from "../../components/ui";

const TOKEN_KEY = "containr_token";
const USER_KEY = "containr_user";

/** handles github sign-in, github app creation and app installation redirects */
const GithubCallback = (props: { install?: boolean }) => {
	const navigate = useNavigate();
	const [message, setMessage] = createSignal("Talking to GitHub…");
	const [error, setError] = createSignal<string | null>(null);

	onMount(async () => {
		const params = new URLSearchParams(window.location.search);
		const token = localStorage.getItem(TOKEN_KEY);
		try {
			if (props.install) {
				if (!token) throw new Error("You need to be signed in to finish the installation.");
				setMessage("Saving the GitHub App installation…");
				await finishGithubAppInstall(
					params.get("installation_id"),
					params.get("setup_action"),
					token,
				);
				navigate("/settings/github?installed=1", { replace: true });
				return;
			}

			const code = params.get("code");
			const state = params.get("state");
			if (!code) throw new Error("GitHub did not return an authorization code.");

			if (state) {
				setMessage(token ? "Linking your GitHub account…" : "Signing you in…");
				const response = await finishGithubLogin(code, state, token);
				localStorage.setItem(TOKEN_KEY, response.token);
				// replace any cached user from a previous session
				localStorage.setItem(USER_KEY, JSON.stringify(response.user));
				window.location.replace(response.linked ? "/settings/account?github=linked" : "/");
				return;
			}

			if (!token) throw new Error("You need to be signed in to finish the GitHub App setup.");
			setMessage("Saving the GitHub App…");
			await finishGithubAppSetup(code, token);
			navigate("/settings/github?created=1", { replace: true });
		} catch (requestError) {
			setError(errorMessage(requestError));
		}
	});

	return (
		<AuthLayout title="GitHub" subtitle="Finishing up with GitHub.">
			<Show
				when={error()}
				fallback={
					<div class="flex items-center gap-3 text-[13px] text-fg-muted">
						<Spinner />
						{message()}
					</div>
				}
			>
				<div class="space-y-4">
					<Notice tone="danger">{error()}</Notice>
					<A href="/" class="btn btn-secondary w-full">
						Back to containr
					</A>
				</div>
			</Show>
		</AuthLayout>
	);
};

export default GithubCallback;
