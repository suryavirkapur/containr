import { Component, JSX } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { AuthProvider, useAuth } from "../context/AuthContext";
import { Button } from "./ui";

/// main layout with navigation
const Layout: Component<{ children?: JSX.Element }> = (props) => {
	return (
		<AuthProvider>
			<LayoutContent>{props.children}</LayoutContent>
		</AuthProvider>
	);
};

const LayoutContent: Component<{ children?: JSX.Element }> = (props) => {
	const { user, logout, isAuthenticated } = useAuth();
	const navigate = useNavigate();
	const links = [
		{ href: "/projects", label: "services" },
		{ href: "/databases", label: "databases" },
		{ href: "/queues", label: "queues" },
		{ href: "/storage", label: "storage" },
		{ href: "/projects/new", label: "new service" },
		{ href: "/settings", label: "settings" },
	];

	const handleLogout = () => {
		logout();
		navigate("/login");
	};

	return (
		<div class="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
			<header class="sticky top-0 z-40 border-b border-[var(--border)] bg-[rgba(9,9,11,0.88)] backdrop-blur">
				<div class="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-5 lg:flex-row lg:items-center lg:justify-between">
					<div class="flex items-center justify-between gap-6">
						<A href="/" class="space-y-1">
							<p class="text-[11px] font-semibold uppercase tracking-[0.32em] text-[var(--muted-foreground)]">
								internal paas
							</p>
							<div class="font-serif text-2xl tracking-tight">containr</div>
						</A>
						<div class="border-l border-[var(--border)] pl-6 text-xs uppercase tracking-[0.2em] text-[var(--muted-foreground)]">
							single-binary deploy control plane
						</div>
					</div>

					<nav class="flex flex-wrap items-center gap-2">
						{links.map((link) => (
							<A
								href={link.href}
								class="border border-transparent px-3 py-2 text-xs font-medium uppercase tracking-[0.18em] text-[var(--muted-foreground)] transition-colors hover:border-[var(--border)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
							>
								{link.label}
							</A>
						))}
					</nav>

					<div class="flex items-center gap-3">
						{isAuthenticated() ? (
							<>
								<div class="border border-[var(--border)] bg-[var(--muted)] px-3 py-2 font-mono text-xs text-[var(--muted-foreground)]">
									{user()?.email}
								</div>
								<Button variant="outline" size="sm" onClick={handleLogout}>
									logout
								</Button>
							</>
						) : (
							<A href="/login">
								<Button size="sm">login</Button>
							</A>
						)}
					</div>
				</div>
			</header>

			<main class="flex-1">
				<div class="mx-auto max-w-7xl px-6 py-10">{props.children}</div>
			</main>

			<footer class="border-t border-[var(--border)] bg-[rgba(10,12,18,0.88)]">
				<div class="mx-auto flex max-w-7xl flex-col gap-3 px-6 py-6 text-sm text-[var(--muted-foreground)] md:flex-row md:items-center md:justify-between">
					<div class="font-serif text-base text-[var(--foreground)]">
						containr
					</div>
					<p class="text-xs uppercase tracking-[0.18em]">
						services, databases, queues, and storage from one control plane
					</p>
				</div>
			</footer>
		</div>
	);
};

export default Layout;
