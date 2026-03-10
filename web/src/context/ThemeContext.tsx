import {
	Component,
	JSX,
	createContext,
	createEffect,
	createSignal,
	useContext,
} from "solid-js";

export type ColorScheme = "purple" | "blue" | "green" | "orange" | "red";
export type Roundness = "none" | "slight" | "medium" | "full";

export interface ThemeConfig {
	colorScheme: ColorScheme;
	roundness: Roundness;
}

const defaultTheme: ThemeConfig = {
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
export const roundnessValues: Record<
	Roundness,
	{ value: string; label: string }
> = {
	none: { value: "0px", label: "none" },
	slight: { value: "4px", label: "slight" },
	medium: { value: "8px", label: "medium" },
	full: { value: "12px", label: "full" },
};

interface ThemeContextValue {
	theme: () => ThemeConfig;
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
		const radius = roundnessValues[current.roundness];
		const root = document.documentElement;

		root.style.setProperty("--accent", scheme.accent);
		root.style.setProperty("--accent-hover", scheme.accentHover);
		root.style.setProperty("--accent-bg", scheme.accentBg);
		root.style.setProperty("--ring", scheme.accent);
		root.style.setProperty("--radius", radius.value);
		root.dataset.roundness = current.roundness === "none" ? "sharp" : "rounded";

		saveTheme(current);
	});

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
