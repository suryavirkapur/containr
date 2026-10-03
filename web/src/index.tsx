/* @refresh reload */
import { Router } from "@solidjs/router";
import { render } from "solid-js/web";
import App from "./App";
import { GlobalOverlays } from "./components/layout/AppShell";
import { AppStoreProvider } from "./context/AppStore";
import { AuthProvider } from "./context/AuthContext";
import "./context/ThemeContext";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

render(
	() => (
		<AuthProvider>
			<AppStoreProvider>
				<Router>
					<App />
				</Router>
				<GlobalOverlays />
			</AppStoreProvider>
		</AuthProvider>
	),
	root,
);
