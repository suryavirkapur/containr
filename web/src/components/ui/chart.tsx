import { type Component, createMemo, createSignal, createUniqueId, For, Show } from "solid-js";

export type Series = {
	label: string;
	color: string;
	values: number[];
};

type ChartProps = {
	series: Series[];
	height?: number;
	/** fixed y maximum (e.g. 100 for percentages); auto-scales when omitted */
	max?: number;
	format?: (value: number) => string;
	/** seconds between samples, used for the hover label */
	interval?: number;
	class?: string;
	hideScale?: boolean;
};

const WIDTH = 600;

const niceMax = (value: number) => {
	if (value <= 0) return 1;
	const exponent = 10 ** Math.floor(Math.log10(value));
	const fraction = value / exponent;
	const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
	return nice * exponent;
};

/** time-series area chart: smooth, hover crosshair, no dependencies */
export const AreaChart: Component<ChartProps> = (props) => {
	const id = createUniqueId();
	const height = () => props.height ?? 160;
	const [hover, setHover] = createSignal<number | null>(null);

	const length = createMemo(() =>
		Math.max(2, ...props.series.map((series) => series.values.length)),
	);
	const yMax = createMemo(() => {
		if (props.max !== undefined) return props.max;
		const highest = Math.max(0, ...props.series.flatMap((series) => series.values));
		return niceMax(highest * 1.1);
	});

	const x = (index: number, count: number) => {
		// right-align so new samples enter from the right
		const offset = length() - count;
		return ((index + offset) / (length() - 1)) * WIDTH;
	};
	const y = (value: number) => {
		const pad = 4;
		return pad + (1 - Math.min(value, yMax()) / yMax()) * (height() - pad * 2);
	};

	const path = (values: number[]) => {
		if (values.length === 0) return "";
		const points = values.map((value, index) => [x(index, values.length), y(value)] as const);
		let d = `M${points[0][0]},${points[0][1]}`;
		for (let i = 1; i < points.length; i++) {
			const [px, py] = points[i - 1];
			const [cx, cy] = points[i];
			const mid = (px + cx) / 2;
			d += ` C${mid},${py} ${mid},${cy} ${cx},${cy}`;
		}
		return d;
	};

	const area = (values: number[]) => {
		if (values.length === 0) return "";
		const first = x(0, values.length);
		const last = x(values.length - 1, values.length);
		return `${path(values)} L${last},${height()} L${first},${height()} Z`;
	};

	const format = (value: number) => (props.format ? props.format(value) : value.toFixed(1));

	const onMove = (event: MouseEvent) => {
		const rect = (event.currentTarget as SVGElement).getBoundingClientRect();
		const ratio = (event.clientX - rect.left) / rect.width;
		setHover(Math.round(ratio * (length() - 1)));
	};

	const hoverValues = createMemo(() => {
		const index = hover();
		if (index === null) return null;
		return props.series.map((series) => {
			const offset = length() - series.values.length;
			return { ...series, value: series.values[index - offset] };
		});
	});

	return (
		<div class={`relative ${props.class ?? ""}`}>
			<svg
				viewBox={`0 0 ${WIDTH} ${height()}`}
				preserveAspectRatio="none"
				class="block w-full overflow-visible"
				style={{ height: `${height()}px` }}
				onMouseMove={onMove}
				onMouseLeave={() => setHover(null)}
				role="img"
			>
				<title>{props.series.map((series) => series.label).join(", ") || "Chart"}</title>
				<defs>
					<For each={props.series}>
						{(series, index) => (
							<linearGradient id={`${id}-${index()}`} x1="0" x2="0" y1="0" y2="1">
								<stop offset="0%" stop-color={series.color} stop-opacity="0.28" />
								<stop offset="100%" stop-color={series.color} stop-opacity="0" />
							</linearGradient>
						)}
					</For>
				</defs>
				<For each={[0.25, 0.5, 0.75]}>
					{(fraction) => (
						<line
							x1="0"
							x2={WIDTH}
							y1={height() * fraction}
							y2={height() * fraction}
							stroke="var(--border)"
							stroke-dasharray="3 4"
							vector-effect="non-scaling-stroke"
						/>
					)}
				</For>
				<For each={props.series}>
					{(series, index) => (
						<>
							<path d={area(series.values)} fill={`url(#${id}-${index()})`} />
							<path
								d={path(series.values)}
								fill="none"
								stroke={series.color}
								stroke-width="1.75"
								vector-effect="non-scaling-stroke"
								stroke-linejoin="round"
							/>
						</>
					)}
				</For>
				<Show when={hover() !== null}>
					<line
						x1={x(hover() ?? 0, length())}
						x2={x(hover() ?? 0, length())}
						y1="0"
						y2={height()}
						stroke="var(--fg-faint)"
						vector-effect="non-scaling-stroke"
					/>
				</Show>
			</svg>
			<Show when={!props.hideScale}>
				<div class="pointer-events-none absolute top-0 right-0 text-[10.5px] text-fg-faint">
					{format(yMax())}
				</div>
			</Show>
			<Show when={hoverValues()}>
				{(values) => (
					<div
						class="pointer-events-none absolute top-1 z-10 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11.5px] shadow-md"
						style={{
							left: `${Math.min(80, Math.max(0, ((hover() ?? 0) / (length() - 1)) * 100))}%`,
						}}
					>
						<Show when={props.interval}>
							<div class="mb-0.5 text-fg-faint">
								{Math.round(((length() - 1 - (hover() ?? 0)) * (props.interval ?? 0)) as number)}s
								ago
							</div>
						</Show>
						<For each={values()}>
							{(item) => (
								<div class="flex items-center gap-2 whitespace-nowrap">
									<span class="h-2 w-2 rounded-full" style={{ background: item.color }} />
									<span class="text-fg-subtle">{item.label}</span>
									<span class="ml-auto font-medium tabular-nums">
										{item.value === undefined ? "–" : format(item.value)}
									</span>
								</div>
							)}
						</For>
					</div>
				)}
			</Show>
		</div>
	);
};

export const Sparkline: Component<{
	values: number[];
	color?: string;
	height?: number;
	max?: number;
}> = (props) => (
	<AreaChart
		series={[{ label: "", color: props.color ?? "var(--chart-1)", values: props.values }]}
		height={props.height ?? 36}
		max={props.max}
		hideScale
	/>
);

/** keeps a fixed-size rolling window of samples */
export const createRollingSeries = (size: number) => {
	const [values, setValues] = createSignal<number[]>([]);
	return {
		values,
		push(value: number) {
			setValues((previous) => {
				const next = [...previous, Number.isFinite(value) ? value : 0];
				return next.length > size ? next.slice(next.length - size) : next;
			});
		},
		reset() {
			setValues([]);
		},
	};
};
