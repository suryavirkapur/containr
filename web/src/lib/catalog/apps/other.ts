import { volume, web } from "../helpers";
import type { Template } from "../types";

// other apps
export const apps: Template[] = [
	{
		id: "nginx",
		name: "Static site (nginx)",
		description: "Serve static files with nginx. Upload files from the Storage tab.",
		category: "Other",
		color: "#009639",
		website: "https://nginx.org",
		version: "alpine",
		web: true,
		services: (ctx) => [
			web(ctx, `nginx:${ctx.vars.version}`, 80, {
				mounts: [volume(`${ctx.app}-html`, "/usr/share/nginx/html")],
			}),
		],
	},
	{
		id: "whoami",
		name: "whoami",
		description: "Tiny web server that echoes request details. Handy to test domains and HTTPS.",
		category: "Other",
		color: "#24a1c1",
		website: "https://github.com/traefik/whoami",
		version: "latest",
		web: true,
		services: (ctx) => [web(ctx, `traefik/whoami:${ctx.vars.version}`, 80)],
	},
];
