import { A, Navigate, useLocation, useNavigate } from "@solidjs/router";
import Activity from "lucide-solid/icons/activity";
import Boxes from "lucide-solid/icons/boxes";
import ChevronRight from "lucide-solid/icons/chevron-right";
import ChevronsUpDown from "lucide-solid/icons/chevrons-up-down";
import Database from "lucide-solid/icons/database";
import FolderKanban from "lucide-solid/icons/folder-kanban";
import GitBranch from "lucide-solid/icons/git-branch";
import HardDrive from "lucide-solid/icons/hard-drive";
import LayoutGrid from "lucide-solid/icons/layout-grid";
import LogOut from "lucide-solid/icons/log-out";
import Menu from "lucide-solid/icons/menu";
import Monitor from "lucide-solid/icons/monitor";
import Moon from "lucide-solid/icons/moon";
import Package from "lucide-solid/icons/package";
import Plus from "lucide-solid/icons/plus";
import Search from "lucide-solid/icons/search";
import Server from "lucide-solid/icons/server";
import Settings from "lucide-solid/icons/settings";
import Store from "lucide-solid/icons/store";
import Sun from "lucide-solid/icons/sun";
import UserIcon from "lucide-solid/icons/user";
import X from "lucide-solid/icons/x";
import {
	type Component,
	createEffect,
	createSignal,
	ErrorBoundary,
	For,
	type JSX,
	Match,
	onCleanup,
	onMount,
	type ParentComponent,
	Show,
	Switch,
} from "solid-js";
import { errorMessage } from "../../api/http";
import { useAppStore } from "../../context/AppStore";
import { useAuth } from "../../context/AuthContext";
import { theme } from "../../context/ThemeContext";
import { Button, cx, Notice, Spinner } from "../ui";
import { ConfirmHost, DropdownMenu, Toaster } from "../ui/overlay";
import { crumbs } from "./breadcrumbs";
import { CommandPalette, openCommandPalette, type PaletteCommand } from "./CommandPalette";
import { Logo, LogoMark } from "./Logo";

type NavLink = {
	href: string;
	label: string;
	icon: () => JSX.Element;
	match?: (path: string) => boolean;
};

const workspaceNav: NavLink[] = [
	{ href: "/", label: "Overview", icon: () => <LayoutGrid />, match: (path) => path === "/" },
	{
		href: "/services",
		label: "Services",
		icon: () => <Boxes />,
		match: (path) => path.startsWith("/services"),
	},
	{ href: "/projects", label: "Projects", icon: () => <FolderKanban /> },
	{ href: "/apps", label: "One-Click Apps", icon: () => <Store /> },
	{ href: "/storage", label: "Storage", icon: () => <Package /> },
];

const platformNav: NavLink[] = [
	{ href: "/monitoring", label: "Monitoring", icon: () => <Activity /> },
	{ href: "/server", label: "Server", icon: () => <Server /> },
	{ href: "/settings", label: "Settings", icon: () => <Settings /> },
];

const NavSection: Component<{ title?: string; links: NavLink[]; onNavigate?: () => void }> = (
	props,
) => {
	const location = useLocation();
	const isActive = (link: NavLink) =>
		link.match ? link.match(location.pathname) : location.pathname.startsWith(link.href);
	return (
		<div class="space-y-0.5">
			<Show when={props.title}>
				<div class="px-2.5 pt-1 pb-1.5 text-[11.5px] font-medium text-fg-faint">{props.title}</div>
			</Show>
			<For each={props.links}>
				{(link) => (
					<A
						href={link.href}
						class={cx("nav-item", isActive(link) && "active")}
						onClick={() => props.onNavigate?.()}
						end
					>
						{link.icon()}
						{link.label}
					</A>
				)}
			</For>
		</div>
	);
};

const Sidebar: Component<{ onNavigate?: () => void }> = (props) => {
	const auth = useAuth();
	const navigate = useNavigate();

	const logout = () => {
		auth.logout();
		navigate("/login");
	};

	return (
		<div class="flex h-full flex-col">
			<div class="flex h-14 items-center px-4">
				<A href="/" onClick={() => props.onNavigate?.()}>
					<Logo />
				</A>
			</div>
			<div class="px-3 pb-3">
				<button
					type="button"
					onClick={() => {
						props.onNavigate?.();
						openCommandPalette();
					}}
					class="flex h-8 w-full items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg-faint shadow-sm transition-colors hover:border-border-strong hover:text-fg-subtle"
				>
					<Search width={14} height={14} />
					<span class="flex-1 text-left">Search…</span>
					<span class="kbd">⌘K</span>
				</button>
			</div>
			<nav class="flex-1 space-y-5 overflow-y-auto px-3 py-1">
				<NavSection links={workspaceNav} onNavigate={props.onNavigate} />
				<NavSection title="Platform" links={platformNav} onNavigate={props.onNavigate} />
			</nav>
			<div class="border-t border-border p-3">
				<DropdownMenu
					class="w-full"
					align="start"
					placement="top"
					trigger={(trigger) => (
						<button
							type="button"
							{...trigger}
							class="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left transition-colors hover:bg-surface-hover"
						>
							<span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent-soft-fg uppercase">
								{(auth.user()?.github_username ?? auth.user()?.email ?? "?").slice(0, 1)}
							</span>
							<span class="min-w-0 flex-1">
								<span class="block truncate text-[13px] font-medium">
									{auth.user()?.github_username ?? auth.user()?.email}
								</span>
								<span class="block text-[11.5px] text-fg-faint">
									{auth.user()?.is_admin ? "Administrator" : "Member"}
								</span>
							</span>
							<ChevronsUpDown width={14} height={14} class="text-fg-faint" />
						</button>
					)}
					items={[
						{
							label: "Account",
							icon: <UserIcon />,
							onSelect: () => {
								props.onNavigate?.();
								navigate("/settings/account");
							},
						},
						{
							label: theme.resolved() === "dark" ? "Light theme" : "Dark theme",
							icon: theme.resolved() === "dark" ? <Sun /> : <Moon />,
							onSelect: () => theme.toggle(),
						},
						{
							label: "Match system theme",
							icon: <Monitor />,
							onSelect: () => theme.set("system"),
						},
						{ separator: true },
						{ label: "Sign out", icon: <LogOut />, onSelect: logout, danger: true },
					]}
				/>
			</div>
		</div>
	);
};

const TopBar: Component<{ onMenu: () => void }> = (props) => {
	const navigate = useNavigate();
	return (
		<header class="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-bg/80 px-4 backdrop-blur-md lg:px-8">
			<button
				type="button"
				class="btn btn-ghost btn-icon lg:hidden"
				onClick={props.onMenu}
				aria-label="Open menu"
			>
				<Menu />
			</button>
			<A href="/" class="lg:hidden">
				<LogoMark size={22} />
			</A>
			<nav class="flex min-w-0 flex-1 items-center gap-1.5 text-[13px]" aria-label="Breadcrumb">
				<For each={crumbs()}>
					{(crumb, index) => (
						<>
							<Show when={index() > 0}>
								<ChevronRight width={14} height={14} class="shrink-0 text-fg-faint" />
							</Show>
							<Show
								when={crumb.href && index() < crumbs().length - 1}
								fallback={<span class="truncate font-medium text-fg">{crumb.label}</span>}
							>
								<A href={crumb.href ?? "/"} class="truncate text-fg-subtle hover:text-fg">
									{crumb.label}
								</A>
							</Show>
						</>
					)}
				</For>
			</nav>
			<button
				type="button"
				class="btn btn-ghost btn-icon"
				onClick={() => theme.toggle()}
				aria-label="Toggle theme"
			>
				<Show when={theme.resolved() === "dark"} fallback={<Moon />}>
					<Sun />
				</Show>
			</button>
			<DropdownMenu
				trigger={(trigger) => (
					<Button variant="primary" size="sm" {...trigger}>
						<Plus />
						<span class="hidden sm:inline">New</span>
					</Button>
				)}
				items={[
					{ label: "Service from Git", icon: <GitBranch />, onSelect: () => navigate("/new/git") },
					{ label: "Docker image", icon: <Package />, onSelect: () => navigate("/new/image") },
					{
						label: "Dockerfile or upload",
						icon: <Boxes />,
						onSelect: () => navigate("/new/upload"),
					},
					{ separator: true },
					{ label: "Database", icon: <Database />, onSelect: () => navigate("/new/database") },
					{ label: "One-click app", icon: <Store />, onSelect: () => navigate("/apps") },
					{
						label: "Storage bucket",
						icon: <HardDrive />,
						onSelect: () => navigate("/storage?new=1"),
					},
				]}
			/>
		</header>
	);
};

export const AppShell: ParentComponent = (props) => {
	const auth = useAuth();
	const store = useAppStore();
	const navigate = useNavigate();
	const location = useLocation();
	const [drawer, setDrawer] = createSignal(false);

	createEffect(() => {
		location.pathname;
		setDrawer(false);
	});

	onMount(() => {
		if (auth.isAuthenticated()) void store.loadServices();
		// keep statuses fresh everywhere (sidebar search, overview, lists)
		const timer = setInterval(() => {
			if (auth.isAuthenticated() && document.visibilityState === "visible")
				void store.loadServices(true);
		}, 10000);
		onCleanup(() => clearInterval(timer));
	});

	const commands = (): PaletteCommand[] => [
		...[...workspaceNav, ...platformNav].map((link) => ({
			id: `nav:${link.href}`,
			label: link.label,
			group: "Navigate",
			icon: link.icon(),
			run: () => navigate(link.href),
		})),
		{
			id: "new:git",
			label: "New service from Git",
			group: "Create",
			icon: <GitBranch />,
			run: () => navigate("/new/git"),
		},
		{
			id: "new:image",
			label: "Deploy a Docker image",
			group: "Create",
			icon: <Package />,
			run: () => navigate("/new/image"),
		},
		{
			id: "new:upload",
			label: "Deploy a Dockerfile or tarball",
			group: "Create",
			icon: <Boxes />,
			run: () => navigate("/new/upload"),
		},
		{
			id: "new:db",
			label: "New database",
			group: "Create",
			icon: <Database />,
			keywords: "postgres redis mysql mariadb",
			run: () => navigate("/new/database"),
		},
		{
			id: "new:app",
			label: "Browse one-click apps",
			group: "Create",
			icon: <Store />,
			keywords: "marketplace template",
			run: () => navigate("/apps"),
		},
		{
			id: "settings:domain",
			label: "Root domain & HTTPS",
			group: "Settings",
			icon: <Settings />,
			run: () => navigate("/settings"),
		},
		{
			id: "settings:registries",
			label: "Container registries",
			group: "Settings",
			icon: <Settings />,
			run: () => navigate("/settings/registries"),
		},
		{
			id: "settings:github",
			label: "GitHub integration",
			group: "Settings",
			icon: <GitBranch />,
			run: () => navigate("/settings/github"),
		},
		{
			id: "settings:users",
			label: "Users",
			group: "Settings",
			icon: <UserIcon />,
			run: () => navigate("/settings/users"),
		},
		{
			id: "server:cleanup",
			label: "Disk cleanup",
			group: "Server",
			icon: <HardDrive />,
			run: () => navigate("/server"),
		},
		{
			id: "theme",
			label: "Toggle theme",
			group: "Preferences",
			icon: <Moon />,
			run: () => theme.toggle(),
		},
		{
			id: "logout",
			label: "Sign out",
			group: "Preferences",
			icon: <LogOut />,
			run: () => {
				auth.logout();
				navigate("/login");
			},
		},
	];

	return (
		<Switch>
			<Match when={!auth.ready()}>
				<main class="flex min-h-screen items-center justify-center">
					<Spinner size={20} />
				</main>
			</Match>
			<Match when={!auth.isAuthenticated()}>
				<Navigate href="/login" />
			</Match>
			<Match when={true}>
				<div class="min-h-screen">
					<aside class="fixed inset-y-0 left-0 z-40 hidden w-[240px] border-r border-border bg-bg-subtle lg:block">
						<Sidebar />
					</aside>
					<Show when={drawer()}>
						<div class="fixed inset-0 z-50 lg:hidden">
							<div
								role="presentation"
								class="animate-fade-in absolute inset-0 bg-black/50"
								onClick={() => setDrawer(false)}
							/>
							<aside class="animate-slide-in absolute inset-y-0 left-0 w-[260px] border-r border-border bg-bg-subtle shadow-lg">
								<button
									type="button"
									class="btn btn-ghost btn-icon absolute top-3 right-3"
									onClick={() => setDrawer(false)}
									aria-label="Close menu"
								>
									<X />
								</button>
								<Sidebar onNavigate={() => setDrawer(false)} />
							</aside>
						</div>
					</Show>
					<div class="lg:pl-[240px]">
						<TopBar onMenu={() => setDrawer(true)} />
						<main class="mx-auto w-full max-w-[1240px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
							<ErrorBoundary
								fallback={(error, reset) => (
									<div class="space-y-3">
										<Notice tone="danger" title="This page failed to load">
											{errorMessage(error)}
										</Notice>
										<Button onClick={reset}>Try again</Button>
									</div>
								)}
							>
								{props.children}
							</ErrorBoundary>
						</main>
					</div>
					<CommandPalette commands={commands} />
				</div>
			</Match>
		</Switch>
	);
};

/** global overlays that must exist outside the authenticated shell too */
export const GlobalOverlays: Component = () => (
	<>
		<Toaster />
		<ConfirmHost />
	</>
);
