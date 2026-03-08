import { Component, JSX } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { AuthProvider, useAuth } from "../context/AuthContext";
import { Button } from "./ui/Button";

/**
 * main layout with navigation
 */
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

	const handleLogout = () => {
		logout();
		navigate("/login");
	};

	return (
		<div class="min-h-screen flex flex-col bg-white">
			{/* header */}
			<header class="border-b border-neutral-200">
				<div class="max-w-6xl mx-auto px-6">
					<div class="flex justify-between items-center h-14">
						{/* logo */}
						<A href="/" class="flex items-center gap-2">
							<span class="text-xl font-serif font-semibold text-black tracking-tight">
								containr
							</span>
						</A>

						{/* nav */}
						<nav class="flex items-center gap-8">
							<A
								href="/projects"
								class="text-neutral-500 hover:text-black transition-colors text-sm font-medium"
							>
								projects
							</A>
							<A
								href="/databases"
								class="text-neutral-500 hover:text-black transition-colors text-sm font-medium"
							>
								databases
							</A>
							<A
								href="/queues"
								class="text-neutral-500 hover:text-black transition-colors text-sm font-medium"
							>
								queues
							</A>
							<A
								href="/storage"
								class="text-neutral-500 hover:text-black transition-colors text-sm font-medium"
							>
								storage
							</A>
							<A
								href="/projects/new"
								class="text-neutral-500 hover:text-black transition-colors text-sm font-medium"
							>
								new project
							</A>
							<A
								href="/settings"
								class="text-neutral-500 hover:text-black transition-colors text-sm font-medium"
							>
								settings
							</A>
						</nav>

						{/* user menu */}
						<div class="flex items-center gap-4">
							{isAuthenticated() ? (
								<>
									<span class="text-neutral-500 text-sm font-mono">
										{user()?.email}
									</span>
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
				</div>
			</header>

			{/* main content */}
			<main class="flex-1">
				<div class="max-w-6xl mx-auto px-6 py-10">{props.children}</div>
			</main>

			{/* footer */}
			<footer class="border-t border-neutral-200 py-6">
				<div class="max-w-6xl mx-auto px-6">
					<p class="text-center text-neutral-400 text-sm font-serif italic">
						containr - deploy containers with ease
					</p>
				</div>
			</footer>
		</div>
	);
};

export default Layout;
