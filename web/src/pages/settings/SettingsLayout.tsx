import { A, useLocation } from "@solidjs/router";
import { For, type ParentComponent } from "solid-js";
import { useBreadcrumbs } from "../../components/layout/breadcrumbs";
import { cx, PageHeader } from "../../components/ui";
import { useAuth } from "../../context/AuthContext";

const TABS = [
	{ href: "/settings", label: "General", admin: true },
	{ href: "/settings/account", label: "Account" },
	{ href: "/settings/users", label: "Users", admin: true },
	{ href: "/settings/github", label: "GitHub", admin: true },
	{ href: "/settings/registries", label: "Registries" },
];

const SettingsLayout: ParentComponent = (props) => {
	const auth = useAuth();
	const location = useLocation();
	useBreadcrumbs(() => [{ label: "Settings" }]);
	const tabs = () => TABS.filter((tab) => !tab.admin || auth.user()?.is_admin);
	return (
		<div class="animate-fade-in">
			<PageHeader title="Settings" description="Configure this containr server and your account." />
			<nav class="tabs mb-6">
				<For each={tabs()}>
					{(tab) => (
						<A href={tab.href} class={cx("tab", location.pathname === tab.href && "active")} end>
							{tab.label}
						</A>
					)}
				</For>
			</nav>
			<div class="max-w-4xl">{props.children}</div>
		</div>
	);
};

export default SettingsLayout;
