/* @refresh reload */
import { Router } from "@solidjs/router";
import { render } from "solid-js/web";

import App from "./App";
import { ThemeProvider } from "./context/ThemeContext";
import "./index.css";

const root = document.getElementById("root");

render(
	() => (
		<ThemeProvider>
			<Router>
				<App />
			</Router>
		</ThemeProvider>
	),
	root!,
);
