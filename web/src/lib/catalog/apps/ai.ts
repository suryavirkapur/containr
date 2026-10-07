import { adminPassword, env, internal, volume, web } from "../helpers";
import type { Template } from "../types";

// ai apps
export const apps: Template[] = [
	{
		id: "open-webui",
		name: "Open WebUI",
		description: "ChatGPT-style interface for Ollama and OpenAI-compatible APIs.",
		category: "AI",
		color: "#000000",
		website: "https://openwebui.com",
		version: "main",
		web: true,
		variables: [{ id: "secret", label: "Session secret", generate: "secret", secret: true }],
		services: (ctx) => [
			web(ctx, `ghcr.io/open-webui/open-webui:${ctx.vars.version}`, 8080, {
				env_vars: env({ WEBUI_SECRET_KEY: ctx.vars.secret }, ["WEBUI_SECRET_KEY"]),
				mounts: [volume(`${ctx.app}-data`, "/app/backend/data")],
			}),
		],
		instructions: () =>
			"The first account you create becomes the admin. Point it at an Ollama service in the same project.",
	},
	{
		id: "ollama",
		name: "Ollama",
		description: "Run Llama, Mistral, Gemma and other open models locally behind an API.",
		category: "AI",
		color: "#333333",
		website: "https://ollama.com",
		version: "latest",
		services: (ctx) => [
			internal(ctx.app, `ollama/ollama:${ctx.vars.version}`, 11434, {
				mounts: [volume(`${ctx.app}-models`, "/root/.ollama")],
			}),
		],
		instructions: (ctx) =>
			`Reach the API at http://${ctx.app}:11434 from the same project. Pull models from the Console tab: ollama pull llama3.2`,
	},
	{
		id: "flowise",
		name: "Flowise",
		description: "Build LLM apps and agents with a drag-and-drop UI.",
		category: "AI",
		color: "#4f46e5",
		website: "https://flowiseai.com",
		version: "latest",
		web: true,
		variables: [
			{ id: "admin_user", label: "Username", default: "admin" },
			adminPassword("Password"),
		],
		services: (ctx) => [
			web(ctx, `flowiseai/flowise:${ctx.vars.version}`, 3000, {
				env_vars: env(
					{ FLOWISE_USERNAME: ctx.vars.admin_user, FLOWISE_PASSWORD: ctx.vars.admin_password },
					["FLOWISE_PASSWORD"],
				),
				mounts: [volume(`${ctx.app}-data`, "/root/.flowise")],
			}),
		],
	},
	{
		id: "searxng",
		name: "SearXNG",
		description: "Privacy-respecting metasearch engine.",
		category: "AI",
		color: "#3050ff",
		website: "https://docs.searxng.org",
		version: "latest",
		web: true,
		variables: [{ id: "secret", label: "Secret key", generate: "secret", secret: true }],
		services: (ctx) => [
			web(ctx, `searxng/searxng:${ctx.vars.version}`, 8080, {
				env_vars: env(
					{
						SEARXNG_BASE_URL: ctx.url ? `${ctx.url}/` : undefined,
						SEARXNG_SECRET: ctx.vars.secret,
					},
					["SEARXNG_SECRET"],
				),
				mounts: [volume(`${ctx.app}-config`, "/etc/searxng")],
			}),
		],
	},
];
