import { createSignal } from "solid-js";

export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "containr-theme";

const readPreference = (): ThemePreference => {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === "light" || stored === "dark" || stored === "system") return stored;
	} catch {
		// storage can be unavailable (private mode); fall back to the default
	}
	return "dark";
};

const media = window.matchMedia("(prefers-color-scheme: dark)");

const [preference, setPreferenceSignal] = createSignal<ThemePreference>(readPreference());
const [resolved, setResolved] = createSignal<"light" | "dark">("dark");

const apply = () => {
	const pref = preference();
	const next = pref === "system" ? (media.matches ? "dark" : "light") : pref;
	setResolved(next);
	document.documentElement.classList.toggle("dark", next === "dark");
};

media.addEventListener("change", apply);
apply();

export const theme = {
	preference,
	resolved,
	set(next: ThemePreference) {
		setPreferenceSignal(next);
		try {
			localStorage.setItem(STORAGE_KEY, next);
		} catch {
			// ignore persistence failures
		}
		apply();
	},
	toggle() {
		theme.set(resolved() === "dark" ? "light" : "dark");
	},
};
