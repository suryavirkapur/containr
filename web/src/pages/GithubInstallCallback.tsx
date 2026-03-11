import { useNavigate } from "@solidjs/router";
import { type Component, createSignal, onMount } from "solid-js";

/**
 * handles github app installation callback
 */
const GithubInstallCallback: Component = () => {
	const navigate = useNavigate();
	const [error, setError] = createSignal<string | null>(null);

	onMount(async () => {
		const params = new URLSearchParams(window.location.search);
		const installationId = params.get("installation_id");
		const setupAction = params.get("setup_action");

		const token = localStorage.getItem("containr_token");
		if (!token) {
			setError("missing auth token");
			return;
		}

		const query = new URLSearchParams();
		if (installationId) {
			query.set("installation_id", installationId);
		}
		if (setupAction) {
			query.set("setup_action", setupAction);
		}

		try {
			const res = await fetch(`/api/github/app/install/callback?${query.toString()}`, {
				headers: {
					Authorization: `Bearer ${token}`,
				},
			});

			if (!res.ok) {
				throw new Error("failed to update github installation");
			}

			navigate("/settings?github=installed", { replace: true });
		} catch (err) {
			setError((err as Error).message);
		}
	});

	return (
		<div class="min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-200">
			<div class="text-sm">
				{error() ? `github install failed: ${error()}` : "processing github installation..."}
			</div>
		</div>
	);
};

export default GithubInstallCallback;
