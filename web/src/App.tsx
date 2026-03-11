import { Navigate, Route } from "@solidjs/router";
import { type Component, lazy, Suspense } from "solid-js";
import Layout from "./components/Layout";
import Loading from "./components/Loading";

const Login = lazy(() => import("./pages/Login"));
const Register = lazy(() => import("./pages/Register"));
const Services = lazy(() => import("./pages/services"));
const ServiceDetail = lazy(() => import("./pages/service-detail"));
const AppDetail = lazy(() => import("./pages/AppDetail"));
const CreateFlow = lazy(() => import("./pages/CreateFlow"));
const CreateRepo = lazy(() => import("./pages/CreateRepo"));
const CreateConfigure = lazy(() => import("./pages/CreateConfigure"));
const CreateTemplate = lazy(() => import("./pages/CreateTemplate"));
const Settings = lazy(() => import("./pages/Settings"));
const DatabaseDetail = lazy(() => import("./pages/DatabaseDetail"));
const QueueDetail = lazy(() => import("./pages/QueueDetail"));
const Storage = lazy(() => import("./pages/Storage"));
const BucketDetail = lazy(() => import("./pages/BucketDetail"));
const GithubCallback = lazy(() => import("./pages/GithubCallback"));
const GithubInstallCallback = lazy(() => import("./pages/GithubInstallCallback"));

const RedirectToServices: Component = () => <Navigate href="/services" />;
const RedirectToServicesNew: Component = () => <Navigate href="/services/new" />;

const App: Component = () => {
	return (
		<Suspense fallback={<Loading />}>
			<Route path="/login" component={Login} />
			<Route path="/register" component={Register} />
			<Route path="/github/callback" component={GithubCallback} />
			<Route path="/github/install/callback" component={GithubInstallCallback} />
			<Route path="/" component={Layout}>
				<Route path="/" component={RedirectToServices} />
				<Route path="/services" component={Services} />
				<Route path="/services/new" component={CreateFlow} />
				<Route path="/services/new/repo" component={CreateRepo} />
				<Route path="/services/new/configure" component={CreateConfigure} />
				<Route path="/services/new/template" component={CreateTemplate} />
				<Route path="/services/:id" component={ServiceDetail} />
				<Route path="/apps" component={RedirectToServices} />
				<Route path="/projects" component={RedirectToServices} />
				<Route path="/projects/new" component={RedirectToServicesNew} />
				<Route path="/projects/:id" component={AppDetail} />
				<Route path="/apps/new" component={RedirectToServicesNew} />
				<Route path="/apps/:id" component={AppDetail} />
				<Route path="/databases/new" component={RedirectToServicesNew} />
				<Route path="/databases" component={RedirectToServices} />
				<Route path="/databases/:id" component={DatabaseDetail} />
				<Route path="/queues/new" component={RedirectToServicesNew} />
				<Route path="/queues" component={RedirectToServices} />
				<Route path="/queues/:id" component={QueueDetail} />
				<Route path="/storage" component={Storage} />
				<Route path="/storage/:id" component={BucketDetail} />
				<Route path="/settings" component={Settings} />
			</Route>
		</Suspense>
	);
};

export default App;
