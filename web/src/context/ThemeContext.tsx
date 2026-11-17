import { createSignal } from "solid-js";

export type ThemePreference = "light" | "dark" | "system";
export type ThemePalette = "default" | "gruvbox" | "tokyonight";

export interface PalettePreview {
	bg: string;
	surface: string;
	fg: string;
	accent: string;
}

export interface PaletteOption {
	id: ThemePalette;
	label: string;
	light: PalettePreview;
	dark: PalettePreview;
}

/** palettes selectable in settings; preview colors feed the theme picker swatches */
export const palettes: PaletteOption[] = [
	{
		id: "default",
		label: "Containr",
		light: { bg: "#fafafa", surface: "#ffffff", fg: "#09090b", accent: "#4f46e5" },
		dark: { bg: "#09090b", surface: "#111114", fg: "#f4f4f5", accent: "#6d6afe" },
	},
	{
		id: "gruvbox",
		label: "Gruvbox",
		light: { bg: "#fbf1c7", surface: "#f9f5d7", fg: "#3c3836", accent: "#d65d0e" },
		dark: { bg: "#282828", surface: "#32302f", fg: "#ebdbb2", accent: "#fabd2f" },
	},
	{
		id: "tokyonight",
		label: "Tokyo Night",
		light: { bg: "#e1e2e7", surface: "#f5f6f9", fg: "#3760bf", accent: "#2e7de9" },
		dark: { bg: "#1a1b26", surface: "#1f2335", fg: "#c0caf5", accent: "#7aa2f7" },
	},
];

const THEME_KEY = "containr-theme";
const PALETTE_KEY = "containr-palette";

const readPreference = (): ThemePreference => {
	try {
		const stored = localStorage.getItem(THEME_KEY);
		if (stored === "light" || stored === "dark" || stored === "system") return stored;
	} catch {
		// storage can be unavailable (private mode); fall back to the default
	}
	return "dark";
};

const readPalette = (): ThemePalette => {
	try {
		const stored = localStorage.getItem(PALETTE_KEY);
		if (stored === "gruvbox" || stored === "tokyonight" || stored === "default") return stored;
	} catch {
		// storage can be unavailable (private mode); fall back to the default
	}
	return "default";
};

const media = window.matchMedia("(prefers-color-scheme: dark)");

const [preference, setPreferenceSignal] = createSignal<ThemePreference>(readPreference());
const [palette, setPaletteSignal] = createSignal<ThemePalette>(readPalette());
const [resolved, setResolved] = createSignal<"light" | "dark">("dark");

const apply = () => {
	const pref = preference();
	const next = pref === "system" ? (media.matches ? "dark" : "light") : pref;
	setResolved(next);
	const root = document.documentElement;
	root.classList.toggle("dark", next === "dark");
	const p = palette();
	if (p === "default") delete root.dataset.theme;
	else root.dataset.theme = p;
};

media.addEventListener("change", apply);
apply();

export const theme = {
	preference,
	palette,
	resolved,
	set(next: ThemePreference) {
		setPreferenceSignal(next);
		try {
			localStorage.setItem(THEME_KEY, next);
		} catch {
			// ignore persistence failures
		}
		apply();
	},
	setPalette(next: ThemePalette) {
		setPaletteSignal(next);
		try {
			localStorage.setItem(PALETTE_KEY, next);
		} catch {
			// ignore persistence failures
		}
		apply();
	},
	toggle() {
		theme.set(resolved() === "dark" ? "light" : "dark");
	},
};
