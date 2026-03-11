import { Component, createSignal } from "solid-js";
import { A, useNavigate } from "@solidjs/router";

import { api } from "../api";
import {
	Alert,
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	Input,
	Separator,
} from "../components/ui";

const Login: Component = () => {
	const [email, setEmail] = createSignal("");
	const [password, setPassword] = createSignal("");
	const [error, setError] = createSignal("");
	const [loading, setLoading] = createSignal(false);
	const navigate = useNavigate();

	const handleSubmit = async (event: Event) => {
		event.preventDefault();
		setError("");
		setLoading(true);

		try {
			const { data, error: apiError } = await api.POST("/api/auth/login", {
				body: { email: email(), password: password() },
			});
			if (apiError) throw apiError;
			localStorage.setItem("containr_token", data.token);
			navigate("/");
		} catch (err: any) {
			setError(err.message);
		} finally {
			setLoading(false);
		}
	};

	return (
		<div class="flex min-h-screen items-center justify-center px-4 py-10">
			<Card class="w-full max-w-md">
				<CardHeader class="space-y-4 text-center">
					<p class="text-[11px] font-semibold uppercase tracking-[0.32em] text-[var(--muted-foreground)]">
						containr
					</p>
					<div class="space-y-2">
						<CardTitle class="text-3xl">sign in</CardTitle>
						<p class="text-sm text-[var(--muted-foreground)]">
							deploy and manage services and storage from one control plane
						</p>
					</div>
				</CardHeader>
				<CardContent class="space-y-6">
					{error() ? (
						<Alert variant="destructive" title="sign in failed">
							{error()}
						</Alert>
					) : null}

					<form onSubmit={handleSubmit} class="space-y-4">
						<Input
							label="email"
							type="email"
							value={email()}
							onInput={(event) => setEmail(event.currentTarget.value)}
							placeholder="you@example.com"
							required
						/>
						<Input
							label="password"
							type="password"
							value={password()}
							onInput={(event) => setPassword(event.currentTarget.value)}
							placeholder="********"
							required
						/>
						<Button type="submit" isLoading={loading()} class="w-full">
							sign in
						</Button>
					</form>

					<div class="space-y-4">
						<div class="flex items-center gap-4">
							<Separator />
							<span class="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--muted-foreground)]">
								or
							</span>
							<Separator />
						</div>

						<a href="/api/auth/github" class="block">
							<Button variant="secondary" class="w-full">
								continue with github
							</Button>
						</a>
					</div>

					<p class="text-center text-sm text-[var(--muted-foreground)]">
						don&apos;t have an account?{" "}
						<A
							href="/register"
							class="text-[var(--foreground)] underline underline-offset-4"
						>
							sign up
						</A>
					</p>
				</CardContent>
			</Card>
		</div>
	);
};

export default Login;
