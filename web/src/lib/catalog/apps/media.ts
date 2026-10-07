import { env, volume, web } from "../helpers";
import type { Template } from "../types";

// media apps
export const apps: Template[] = [
	{
		id: "jellyfin",
		name: "Jellyfin",
		description: "Free software media system to stream your movies, shows and music.",
		category: "Media",
		color: "#aa5cc3",
		website: "https://jellyfin.org",
		version: "latest",
		web: true,
		services: (ctx) => [
			web(ctx, `jellyfin/jellyfin:${ctx.vars.version}`, 8096, {
				mounts: [
					volume(`${ctx.app}-config`, "/config"),
					volume(`${ctx.app}-cache`, "/cache"),
					volume(`${ctx.app}-media`, "/media"),
				],
			}),
		],
	},
	{
		id: "navidrome",
		name: "Navidrome",
		description: "Modern music server and streamer compatible with Subsonic clients.",
		category: "Media",
		color: "#0084ff",
		website: "https://www.navidrome.org",
		version: "latest",
		web: true,
		services: (ctx) => [
			web(ctx, `deluan/navidrome:${ctx.vars.version}`, 4533, {
				mounts: [volume(`${ctx.app}-data`, "/data"), volume(`${ctx.app}-music`, "/music")],
			}),
		],
	},
	{
		id: "minecraft",
		name: "Minecraft server",
		description: "Java Edition server. Publishes port 25565 directly on the server.",
		category: "Media",
		color: "#62b47a",
		website: "https://github.com/itzg/docker-minecraft-server",
		version: "latest",
		variables: [
			{ id: "mc_version", label: "Minecraft version", default: "LATEST" },
			{ id: "memory", label: "Server memory", default: "2G" },
		],
		services: (ctx) => [
			{
				name: ctx.app,
				image: `itzg/minecraft-server:${ctx.vars.version}`,
				service_type: "background_worker",
				port: 25565,
				expose_http: false,
				restart_policy: "always",
				env_vars: env({ EULA: "TRUE", VERSION: ctx.vars.mc_version, MEMORY: ctx.vars.memory }),
				mounts: [volume(`${ctx.app}-data`, "/data")],
				port_mappings: [{ host_port: 25565, container_port: 25565, protocol: "tcp" }],
			},
		],
		instructions: () => "Players connect to this server's IP on port 25565.",
	},
];
