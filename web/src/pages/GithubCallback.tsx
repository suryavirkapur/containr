import { useNavigate } from "@solidjs/router";
import { Component, createSignal, onMount } from "solid-js";

/**
 * handles github app manifest callback
 */
const GithubCallback: Component = () => {
	const navigate = useNavigate();
	const [error, setError] = createSignal<string | null>(null);

	onMount(async () => {
		const params = new URLSearchParams(window.location.search);
		const code = params.get("code");
		if (!code) {
			setError("missing github code");
			return;
		}

		const token = localStorage.getItem("containr_token");
		if (!token) {
			setError("missing auth token");
			return;
		}

		try {
			const res = await fetch(`/api/github/app/callback?code=${encodeURIComponent(code)}`, {
				headers: {
					Authorization: `Bearer ${token}`,
				},
			});

			if (!res.ok) {
				throw new Error("failed to create github app");
			}

			navigate("/settings?github=created", { replace: true });
		} catch (err) {
			setError((err as Error).message);
		}
	});

	return (
		<div class="min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-200">
			<div class="text-sm">
				{error() ? `github app setup failed: ${error()}` : "processing github app setup..."}
			</div>
		</div>
	);
};

export default GithubCallback;
