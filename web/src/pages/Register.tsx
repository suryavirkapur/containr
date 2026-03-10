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
} from "../components/ui";

const Register: Component = () => {
	const [email, setEmail] = createSignal("");
	const [password, setPassword] = createSignal("");
	const [confirmPassword, setConfirmPassword] = createSignal("");
	const [error, setError] = createSignal("");
	const [loading, setLoading] = createSignal(false);
	const navigate = useNavigate();

	const handleSubmit = async (event: Event) => {
		event.preventDefault();
		setError("");

		if (password() !== confirmPassword()) {
			setError("passwords do not match");
			return;
		}

		if (password().length < 8) {
			setError("password must be at least 8 characters");
			return;
		}

		setLoading(true);

		try {
			const { data, error: apiError } = await api.POST("/api/auth/register", {
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
						<CardTitle class="text-3xl">create account</CardTitle>
						<p class="text-sm text-[var(--muted-foreground)]">
							spin up your own internal paas workspace and start deploying services
						</p>
					</div>
				</CardHeader>
				<CardContent class="space-y-6">
					{error() ? (
						<Alert variant="destructive" title="registration failed">
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
							placeholder="at least 8 characters"
							required
						/>
						<Input
							label="confirm password"
							type="password"
							value={confirmPassword()}
							onInput={(event) => setConfirmPassword(event.currentTarget.value)}
							placeholder="confirm your password"
							required
						/>
						<Button type="submit" isLoading={loading()} class="w-full">
							create account
						</Button>
					</form>

					<p class="text-center text-sm text-[var(--muted-foreground)]">
						already have an account?{" "}
						<A href="/login" class="text-[var(--foreground)] underline underline-offset-4">
							sign in
						</A>
					</p>
				</CardContent>
			</Card>
		</div>
	);
};

export default Register;
