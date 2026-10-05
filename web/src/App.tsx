import { Navigate, Route } from "@solidjs/router";
import { type Component, lazy } from "solid-js";
import { AppShell } from "./components/layout/AppShell";
import Gate from "./pages/auth/Gate";
import GithubCallback from "./pages/auth/GithubCallback";
import Login from "./pages/auth/Login";
import Register from "./pages/auth/Register";
import Overview from "./pages/Overview";
import ServiceList from "./pages/services/ServiceList";

const ServiceLayout = lazy(() => import("./pages/services/ServiceLayout"));
const ServiceOverview = lazy(() => import("./pages/services/ServiceOverview"));
const ServiceDeployments = lazy(() => import("./pages/services/ServiceDeployments"));
const ServiceLogs = lazy(() => import("./pages/services/ServiceLogs"));
const ServiceMetrics = lazy(() => import("./pages/services/ServiceMetrics"));
const ServiceEnvironment = lazy(() => import("./pages/services/ServiceEnvironment"));
const ServiceNetworking = lazy(() => import("./pages/services/ServiceNetworking"));
const ServiceStorage = lazy(() => import("./pages/services/ServiceStorage"));
const ServiceConsole = lazy(() => import("./pages/services/ServiceConsole"));
const ServiceSettings = lazy(() => import("./pages/services/ServiceSettings"));
const NewService = lazy(() => import("./pages/new/NewService"));
const NewGit = lazy(() => import("./pages/new/NewGit"));
const NewImage = lazy(() => import("./pages/new/NewImage"));
const NewUpload = lazy(() => import("./pages/new/NewUpload"));
const NewDatabase = lazy(() => import("./pages/new/NewDatabase"));
const AppCatalog = lazy(() => import("./pages/apps/AppCatalog"));
const AppDeploy = lazy(() => import("./pages/apps/AppDeploy"));
const Projects = lazy(() => import("./pages/projects/Projects"));
const ProjectDetail = lazy(() => import("./pages/projects/ProjectDetail"));
const Buckets = lazy(() => import("./pages/storage/Buckets"));
const BucketDetail = lazy(() => import("./pages/storage/BucketDetail"));
const Monitoring = lazy(() => import("./pages/platform/Monitoring"));
const Server = lazy(() => import("./pages/platform/Server"));
const SettingsLayout = lazy(() => import("./pages/settings/SettingsLayout"));
const GeneralSettings = lazy(() => import("./pages/settings/GeneralSettings"));
const AccountSettings = lazy(() => import("./pages/settings/AccountSettings"));
const UsersSettings = lazy(() => import("./pages/settings/UsersSettings"));
const GithubSettings = lazy(() => import("./pages/settings/GithubSettings"));
const RegistriesSettings = lazy(() => import("./pages/settings/RegistriesSettings"));

const redirect =
	(href: string): Component =>
	() => <Navigate href={href} />;

const App: Component = () => (
	<>
		<Route path="/login" component={Login} />
		<Route path="/gate" component={Gate} />
		<Route path="/register" component={Register} />
		<Route path="/github/callback" component={() => <GithubCallback />} />
		<Route path="/github/install/callback" component={() => <GithubCallback install />} />
		<Route path="/" component={AppShell}>
			<Route path="/" component={Overview} />
			<Route path="/services" component={ServiceList} />
			<Route path="/services/new" component={redirect("/new")} />
			<Route path="/services/:id" component={ServiceLayout}>
				<Route path="/" component={ServiceOverview} />
				<Route path="/deployments" component={ServiceDeployments} />
				<Route path="/logs" component={ServiceLogs} />
				<Route path="/metrics" component={ServiceMetrics} />
				<Route path="/environment" component={ServiceEnvironment} />
				<Route path="/networking" component={ServiceNetworking} />
				<Route path="/storage" component={ServiceStorage} />
				<Route path="/console" component={ServiceConsole} />
				<Route path="/settings" component={ServiceSettings} />
			</Route>
			<Route path="/new" component={NewService} />
			<Route path="/new/git" component={NewGit} />
			<Route path="/new/image" component={NewImage} />
			<Route path="/new/upload" component={NewUpload} />
			<Route path="/new/database" component={NewDatabase} />
			<Route path="/apps" component={AppCatalog} />
			<Route path="/apps/:id" component={AppDeploy} />
			<Route path="/projects" component={Projects} />
			<Route path="/projects/:id" component={ProjectDetail} />
			<Route path="/storage" component={Buckets} />
			<Route path="/storage/:id" component={BucketDetail} />
			<Route path="/monitoring" component={Monitoring} />
			<Route path="/server" component={Server} />
			<Route path="/settings" component={SettingsLayout}>
				<Route path="/" component={GeneralSettings} />
				<Route path="/account" component={AccountSettings} />
				<Route path="/users" component={UsersSettings} />
				<Route path="/github" component={GithubSettings} />
				<Route path="/registries" component={RegistriesSettings} />
			</Route>
			<Route path="/dashboard" component={redirect("/")} />
			<Route path="/databases" component={redirect("/services?kind=data")} />
			<Route path="/queues" component={redirect("/services?kind=data")} />
			<Route path="*" component={redirect("/")} />
		</Route>
	</>
);

export default App;
