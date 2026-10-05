import { A, useNavigate, useSearchParams } from "@solidjs/router";
import { createEffect, createSignal, Show } from "solid-js";
import { ApiError } from "../../api/http";
import { createGatePass } from "../../api/platform";
import { AuthLayout } from "../../components/layout/AuthLayout";
import { Button, Notice, Spinner } from "../../components/ui";
import { useAuth } from "../../context/AuthContext";

/**
 * entry point for services protected by the containr login. the proxy on a
 * gated domain sends signed-out visitors here; once signed in, the visitor
 * gets a short-lived pass and lands back on the service.
 */
const Gate = () => {
	const auth = useAuth();
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const host = () => (typeof params.host === "string" ? params.host : "");
	const returnTo = () => (typeof params.return === "string" ? params.return : "/");
	const [problem, setProblem] = createSignal<{ title: string; detail: string } | null>(null);
	let started = false;

	createEffect(() => {
		if (!auth.ready() || started) return;
		started = true;
		if (!host()) {
			setProblem({
				title: "Nothing to open",
				detail: "This link is missing the service it should open.",
			});
			return;
		}
		if (!auth.isAuthenticated()) {
			const here = `/gate?${new URLSearchParams({ host: host(), return: returnTo() })}`;
			navigate(`/login?next=${encodeURIComponent(here)}`, { replace: true });
			return;
		}
		createGatePass(host(), returnTo())
			.then(({ redirect_url }) => window.location.replace(redirect_url))
			.catch((error) => {
				const status = error instanceof ApiError ? error.status : 0;
				setProblem(
					status === 403
						? {
								title: "You don't have access",
								detail: `Only the owner of ${host()} can open it. Ask them to allow everyone with a containr account.`,
							}
						: status === 404
							? {
									title: "Not protected by containr",
									detail: `${host()} doesn't use the containr login, or it was turned off.`,
								}
							: {
									title: "Couldn't open the service",
									detail: error instanceof Error ? error.message : "Try again in a moment.",
								},
				);
			});
	});

	return (
		<AuthLayout
			title={problem()?.title ?? `Opening ${host() || "service"}`}
			subtitle={
				<Show when={!problem()} fallback={problem()?.detail}>
					Checking your containr session…
				</Show>
			}
		>
			<Show
				when={problem()}
				fallback={
					<div class="flex justify-center py-6">
						<Spinner />
					</div>
				}
			>
				<div class="space-y-4">
					<Notice>{host()} is protected by the containr login.</Notice>
					<div class="flex gap-2">
						<Button variant="secondary" onClick={() => window.location.reload()}>
							Try again
						</Button>
						<A href="/" class="btn btn-ghost">
							Go to dashboard
						</A>
					</div>
				</div>
			</Show>
		</AuthLayout>
	);
};

export default Gate;
