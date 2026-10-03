import type { Component } from "solid-js";
import type { Template } from "../../lib/catalog";

/** brand-coloured monogram tile; avoids loading third-party logos */
export const AppLogo: Component<{ template: Template; size?: number }> = (props) => {
	const size = () => props.size ?? 40;
	const initials = () =>
		props.template.name
			.replace(/[^A-Za-z0-9 ]/g, " ")
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((word) => word[0])
			.join("")
			.toUpperCase();
	return (
		<span
			class="inline-flex shrink-0 items-center justify-center rounded-[10px] font-semibold tracking-[-0.02em] text-white"
			style={{
				width: `${size()}px`,
				height: `${size()}px`,
				"font-size": `${Math.round(size() * 0.36)}px`,
				background: `linear-gradient(135deg, color-mix(in srgb, ${props.template.color} 78%, white), ${props.template.color})`,
				"box-shadow": `inset 0 0 0 1px rgb(255 255 255 / 0.12), 0 1px 2px rgb(0 0 0 / 0.2)`,
			}}
			aria-hidden="true"
		>
			{initials()}
		</span>
	);
};
