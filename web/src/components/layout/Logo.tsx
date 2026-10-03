import { type Component, createUniqueId } from "solid-js";

export const LogoMark: Component<{ size?: number; class?: string }> = (props) => {
	const id = createUniqueId();
	return (
		<svg
			width={props.size ?? 24}
			height={props.size ?? 24}
			viewBox="0 0 32 32"
			fill="none"
			class={props.class}
			aria-hidden="true"
		>
			<defs>
				<linearGradient id={id} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
					<stop stop-color="#8b88ff" />
					<stop offset="1" stop-color="#4f46e5" />
				</linearGradient>
			</defs>
			<rect width="32" height="32" rx="8" fill={`url(#${id})`} />
			<rect x="8" y="8" width="16" height="4.5" rx="1.5" fill="#fff" />
			<rect x="8" y="13.75" width="9" height="4.5" rx="1.5" fill="#fff" fill-opacity=".72" />
			<rect x="8" y="19.5" width="16" height="4.5" rx="1.5" fill="#fff" />
		</svg>
	);
};

export const Logo: Component<{ class?: string }> = (props) => (
	<span class={`inline-flex items-center gap-2.5 ${props.class ?? ""}`}>
		<LogoMark />
		<span class="text-[15px] font-semibold tracking-[-0.02em]">containr</span>
	</span>
);
