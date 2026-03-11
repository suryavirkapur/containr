import { Component, JSX, createContext, createEffect, createSignal, useContext } from "solid-js";

export type ColorScheme = "purple" | "blue" | "green" | "orange" | "red";
export type ColorMode = "dark" | "light";
export type Roundness = "none" | "slight" | "medium" | "full";

export interface ThemeConfig {
	colorMode: ColorMode;
	colorScheme: ColorScheme;
	roundness: Roundness;
}

const defaultTheme: ThemeConfig = {
	colorMode: "dark",
	colorScheme: "blue",
	roundness: "none",
};

const THEME_KEY = "containr_theme";

const loadTheme = (): ThemeConfig => {
	try {
		const stored = localStorage.getItem(THEME_KEY);
		if (stored) {
			const parsed = JSON.parse(stored);
			return { ...defaultTheme, ...parsed };
		}
	} catch {
		// ignore parse errors
	}
	return defaultTheme;
};

const saveTheme = (theme: ThemeConfig) => {
	localStorage.setItem(THEME_KEY, JSON.stringify(theme));
};

/// color scheme definitions
export const colorSchemes: Record<
	ColorScheme,
	{ accent: string; accentHover: string; accentBg: string; label: string }
> = {
	purple: {
		accent: "rgb(168 85 247)",
		accentHover: "rgb(147 51 234)",
		accentBg: "rgba(168, 85, 247, 0.15)",
		label: "purple",
	},
	blue: {
		accent: "rgb(59 130 246)",
		accentHover: "rgb(37 99 235)",
		accentBg: "rgba(59, 130, 246, 0.15)",
		label: "blue",
	},
	green: {
		accent: "rgb(34 197 94)",
		accentHover: "rgb(22 163 74)",
		accentBg: "rgba(34, 197, 94, 0.15)",
		label: "green",
	},
	orange: {
		accent: "rgb(249 115 22)",
		accentHover: "rgb(234 88 12)",
		accentBg: "rgba(249, 115, 22, 0.15)",
		label: "orange",
	},
	red: {
		accent: "rgb(239 68 68)",
		accentHover: "rgb(220 38 38)",
		accentBg: "rgba(239, 68, 68, 0.15)",
		label: "red",
	},
};

/// roundness values in px
export const roundnessValues: Record<Roundness, { value: string; label: string }> = {
	none: { value: "0px", label: "none" },
	slight: { value: "4px", label: "slight" },
	medium: { value: "8px", label: "medium" },
	full: { value: "12px", label: "full" },
};

interface ThemePalette {
	background: string;
	backgroundEnd: string;
	backgroundGlow: string;
	backgroundOverlay: string;
	foreground: string;
	card: string;
	cardForeground: string;
	muted: string;
	mutedForeground: string;
	surfaceMuted: string;
	border: string;
	borderStrong: string;
	input: string;
	foregroundSubtle: string;
	primary: string;
	primaryForeground: string;
	success: string;
	warning: string;
	destructive: string;
	selectionBg: string;
	selectionFg: string;
}

const modePalettes: Record<ColorMode, ThemePalette> = {
	dark: {
		background: "#09090b",
		backgroundEnd: "#0b0f16",
		backgroundGlow: "rgba(30, 41, 59, 0.28)",
		backgroundOverlay: "rgba(9, 9, 11, 0.88)",
		foreground: "#f5f7fa",
		card: "#101319",
		cardForeground: "#f5f7fa",
		muted: "#131720",
		mutedForeground: "#9ca3af",
		surfaceMuted: "#171b24",
		border: "#262b36",
		borderStrong: "#3b4352",
		input: "#12161f",
		foregroundSubtle: "#c8d0dc",
		primary: "#f5f7fa",
		primaryForeground: "#0b0d12",
		success: "#14532d",
		warning: "#78350f",
		destructive: "#7f1d1d",
		selectionBg: "#334155",
		selectionFg: "#f5f7fa",
	},
	light: {
		background: "#f4f7fb",
		backgroundEnd: "#ecf1f7",
		backgroundGlow: "rgba(59, 130, 246, 0.10)",
		backgroundOverlay: "rgba(244, 247, 251, 0.88)",
		foreground: "#101828",
		card: "#ffffff",
		cardForeground: "#101828",
		muted: "#eef2f8",
		mutedForeground: "#5b6678",
		surfaceMuted: "#e4ebf4",
		border: "#d7dfeb",
		borderStrong: "#b8c4d6",
		input: "#ffffff",
		foregroundSubtle: "#344054",
		primary: "#101828",
		primaryForeground: "#ffffff",
		success: "#166534",
		warning: "#b45309",
		destructive: "#b91c1c",
		selectionBg: "#bfdbfe",
		selectionFg: "#101828",
	},
};

interface ThemeContextValue {
	theme: () => ThemeConfig;
	setColorMode: (mode: ColorMode) => void;
	setColorScheme: (scheme: ColorScheme) => void;
	setRoundness: (roundness: Roundness) => void;
	accentColor: () => string;
	accentHover: () => string;
	accentBg: () => string;
}

const ThemeContext = createContext<ThemeContextValue>();

export const ThemeProvider: Component<{ children?: JSX.Element }> = (props) => {
	const [theme, setTheme] = createSignal<ThemeConfig>(loadTheme());

	// apply theme to document root as css variables
	createEffect(() => {
		const current = theme();
		const scheme = colorSchemes[current.colorScheme];
		const palette = modePalettes[current.colorMode];
		const radius = roundnessValues[current.roundness];
		const root = document.documentElement;

		root.style.setProperty("--background", palette.background);
		root.style.setProperty("--background-end", palette.backgroundEnd);
		root.style.setProperty("--background-glow", palette.backgroundGlow);
		root.style.setProperty("--background-overlay", palette.backgroundOverlay);
		root.style.setProperty("--foreground", palette.foreground);
		root.style.setProperty("--card", palette.card);
		root.style.setProperty("--card-foreground", palette.cardForeground);
		root.style.setProperty("--muted", palette.muted);
		root.style.setProperty("--muted-foreground", palette.mutedForeground);
		root.style.setProperty("--surface-muted", palette.surfaceMuted);
		root.style.setProperty("--border", palette.border);
		root.style.setProperty("--border-strong", palette.borderStrong);
		root.style.setProperty("--input", palette.input);
		root.style.setProperty("--foreground-subtle", palette.foregroundSubtle);
		root.style.setProperty("--primary", palette.primary);
		root.style.setProperty("--primary-foreground", palette.primaryForeground);
		root.style.setProperty("--success", palette.success);
		root.style.setProperty("--warning", palette.warning);
		root.style.setProperty("--destructive", palette.destructive);
		root.style.setProperty("--selection-bg", palette.selectionBg);
		root.style.setProperty("--selection-fg", palette.selectionFg);
		root.style.setProperty("--accent", scheme.accent);
		root.style.setProperty("--accent-hover", scheme.accentHover);
		root.style.setProperty("--accent-bg", scheme.accentBg);
		root.style.setProperty("--ring", scheme.accent);
		root.style.setProperty("--radius", radius.value);
		root.dataset.roundness = current.roundness === "none" ? "sharp" : "rounded";
		root.dataset.colorMode = current.colorMode;
		root.style.colorScheme = current.colorMode;

		saveTheme(current);
	});

	const setColorMode = (colorMode: ColorMode) => {
		setTheme((prev) => ({ ...prev, colorMode }));
	};

	const setColorScheme = (scheme: ColorScheme) => {
		setTheme((prev) => ({ ...prev, colorScheme: scheme }));
	};

	const setRoundness = (roundness: Roundness) => {
		setTheme((prev) => ({ ...prev, roundness }));
	};

	const accentColor = () => colorSchemes[theme().colorScheme].accent;
	const accentHover = () => colorSchemes[theme().colorScheme].accentHover;
	const accentBg = () => colorSchemes[theme().colorScheme].accentBg;

	return (
		<ThemeContext.Provider
			value={{
				theme,
				setColorMode,
				setColorScheme,
				setRoundness,
				accentColor,
				accentHover,
				accentBg,
			}}
		>
			{props.children}
		</ThemeContext.Provider>
	);
};

export const useTheme = () => {
	const ctx = useContext(ThemeContext);
	if (!ctx) {
		throw new Error("useTheme must be used within ThemeProvider");
	}
	return ctx;
};
