import { A, useLocation, useNavigate } from "@solidjs/router";
import { Component, For, JSX, Show, createSignal } from "solid-js";

import {
	type ColorScheme,
	colorSchemes,
	useTheme,
} from "../context/ThemeContext";
import { AuthProvider, useAuth } from "../context/AuthContext";
import {
	Button,
	Card,
	CardContent,
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInset,
	SidebarMenu,
	SidebarMenuItem,
	SidebarMenuLink,
} from "./ui";

interface NavLink {
	href: string;
	label: string;
	icon: string;
	matches: (path: string) => boolean;
}

interface NavSection {
	label: string;
	links: NavLink[];
}

const navSections: NavSection[] = [
	{
		label: "control plane",
		links: [
			{
				href: "/",
				label: "services",
				icon: "M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10",
				matches: (path) =>
					path === "/" || path === "/projects" || path === "/apps",
			},
			{
				href: "/projects/new",
				label: "new service",
				icon: "M12 4v16m8-8H4",
				matches: (path) => path === "/projects/new" || path === "/apps/new",
			},
		],
	},
	{
		label: "infrastructure",
		links: [
			{
				href: "/databases",
				label: "databases",
				icon: "M12 3C7 3 4 5 4 8v8c0 3 3 5 8 5s8-2 8-5V8c0-3-3-5-8-5z",
				matches: (path) => path.startsWith("/databases"),
			},
			{
				href: "/queues",
				label: "queues",
				icon: "M6 8h12v8H6zm2-3h8v3H8z",
				matches: (path) => path.startsWith("/queues"),
			},
			{
				href: "/storage",
				label: "storage",
				icon: "M4 7h16M7 7V5h10v2m-9 4h8m-8 4h8m-8 4h8",
				matches: (path) => path.startsWith("/storage"),
			},
		],
	},
	{
		label: "settings",
		links: [
			{
				href: "/settings",
				label: "settings",
				icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z",
				matches: (path) => path.startsWith("/settings"),
			},
		],
	},
];

const accentOptions: ColorScheme[] = ["blue", "green", "orange", "red"];

const Layout: Component<{ children?: JSX.Element }> = (props) => {
	return (
		<AuthProvider>
			<LayoutContent>{props.children}</LayoutContent>
		</AuthProvider>
	);
};

const ThemePanel: Component = () => {
	const { theme, setColorScheme, setRoundness } = useTheme();

	return (
		<Card class="bg-[var(--muted)]/60">
			<CardContent class="space-y-4">
				<div>
					<p class="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--muted-foreground)]">
						theme
					</p>
					<p class="mt-2 text-sm text-[var(--muted-foreground)]">
						switch between the current sharp shell and a rounded variant.
					</p>
				</div>

				<div class="grid grid-cols-2 gap-2">
					<Button
						variant={theme().roundness === "none" ? "primary" : "outline"}
						size="sm"
						onClick={() => setRoundness("none")}
					>
						sharp
					</Button>
					<Button
						variant={theme().roundness === "medium" ? "primary" : "outline"}
						size="sm"
						onClick={() => setRoundness("medium")}
					>
						rounded
					</Button>
				</div>

				<div class="space-y-2">
					<p class="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--muted-foreground)]">
						accent
					</p>
					<div class="flex items-center gap-2">
						<For each={accentOptions}>
							{(scheme) => (
								<button
									type="button"
									aria-label={`switch accent to ${scheme}`}
									onClick={() => setColorScheme(scheme)}
									class="h-8 w-8 rounded-[calc(var(--radius)+4px)] border transition-transform hover:scale-105"
									style={{
										"background-color": colorSchemes[scheme].accent,
										"border-color":
											theme().colorScheme === scheme
												? "var(--foreground)"
												: "var(--border)",
									}}
								/>
							)}
						</For>
					</div>
				</div>
			</CardContent>
		</Card>
	);
};

const AppSidebar: Component<{
	onNavigate?: () => void;
}> = (props) => {
	const location = useLocation();
	const navigate = useNavigate();
	const { user, logout, isAuthenticated } = useAuth();

	const handleLogout = () => {
		logout();
		navigate("/login");
		props.onNavigate?.();
	};

	return (
		<>
			<SidebarHeader class="space-y-5">
				<div class="space-y-1">
					<p class="text-[11px] font-semibold uppercase tracking-[0.32em] text-[var(--muted-foreground)]">
						internal paas
					</p>
					<A href="/" class="block" onClick={() => props.onNavigate?.()}>
						<div class="font-serif text-2xl tracking-tight text-[var(--foreground)]">
							containr
						</div>
					</A>
				</div>
				<p class="mt-3 text-sm leading-6 text-[var(--muted-foreground)]">
					service-first control plane with grouped networking and managed
					runtimes.
				</p>
				<ThemePanel />
			</SidebarHeader>

			<SidebarContent>
				<For each={navSections}>
					{(section) => (
						<SidebarGroup>
							<SidebarGroupLabel>{section.label}</SidebarGroupLabel>
							<SidebarMenu>
								<For each={section.links}>
									{(link) => {
										const active = () => link.matches(location.pathname);

										return (
											<SidebarMenuItem>
												<SidebarMenuLink
													href={link.href}
													active={active()}
													onClick={() => props.onNavigate?.()}
												>
													<svg
														class="h-4 w-4"
														viewBox="0 0 24 24"
														fill="none"
														stroke="currentColor"
														stroke-width="1.6"
														stroke-linecap="round"
														stroke-linejoin="round"
													>
														<path d={link.icon} />
													</svg>
													<span class="font-medium">{link.label}</span>
												</SidebarMenuLink>
											</SidebarMenuItem>
										);
									}}
								</For>
							</SidebarMenu>
						</SidebarGroup>
					)}
				</For>
			</SidebarContent>

			<SidebarFooter>
				<Show
					when={isAuthenticated()}
					fallback={
						<A href="/login" onClick={() => props.onNavigate?.()}>
							<Button class="w-full">login</Button>
						</A>
					}
				>
					<div class="space-y-3">
						<div class="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] px-3 py-3 font-mono text-xs text-[var(--muted-foreground)]">
							{user()?.email}
						</div>
						<Button variant="outline" class="w-full" onClick={handleLogout}>
							logout
						</Button>
					</div>
				</Show>
			</SidebarFooter>
		</>
	);
};

const LayoutContent: Component<{ children?: JSX.Element }> = (props) => {
	const [sidebarOpen, setSidebarOpen] = createSignal(false);

	return (
		<div class="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
			<div class="flex min-h-screen">
				<Sidebar class="hidden lg:flex">
					<AppSidebar />
				</Sidebar>

				<Show when={sidebarOpen()}>
					<div class="fixed inset-0 z-50 lg:hidden">
						<button
							type="button"
							class="absolute inset-0 bg-black/70"
							onClick={() => setSidebarOpen(false)}
						/>
						<Sidebar class="relative h-full shadow-2xl lg:hidden">
							<AppSidebar onNavigate={() => setSidebarOpen(false)} />
						</Sidebar>
					</div>
				</Show>

				<SidebarInset>
					<header class="sticky top-0 z-30 border-b border-[var(--border)] bg-[rgba(9,9,11,0.88)] backdrop-blur lg:hidden">
						<div class="flex items-center justify-between px-4 py-4">
							<div class="flex items-center gap-3">
								<Button
									variant="outline"
									size="icon"
									onClick={() => setSidebarOpen(true)}
								>
									<svg
										class="h-4 w-4"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="1.6"
										stroke-linecap="round"
										stroke-linejoin="round"
									>
										<path d="M3 6h18M3 12h18M3 18h18" />
									</svg>
								</Button>
								<A href="/" class="font-serif text-xl tracking-tight">
									containr
								</A>
							</div>
							<A href="/projects/new">
								<Button size="sm">new service</Button>
							</A>
						</div>
					</header>

					<main class="flex-1">
						<div class="mx-auto w-full max-w-7xl px-5 py-8 lg:px-10 lg:py-10">
							{props.children}
						</div>
					</main>

					<footer class="border-t border-[var(--border)] bg-[rgba(10,12,18,0.88)]">
						<div class="mx-auto flex w-full max-w-7xl flex-col gap-3 px-5 py-5 text-sm text-[var(--muted-foreground)] lg:px-10 lg:flex-row lg:items-center lg:justify-between">
							<div class="font-serif text-base text-[var(--foreground)]">
								containr
							</div>
							<p class="text-xs uppercase tracking-[0.18em]">
								services, databases, queues, and storage from one control plane
							</p>
						</div>
					</footer>
				</SidebarInset>
			</div>
		</div>
	);
};

export default Layout;
