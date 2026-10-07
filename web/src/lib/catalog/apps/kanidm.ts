import { caddyRouter, env, internal, oneShot, sharedVolume } from "../helpers";
import type { Template } from "../types";

// kanidm identity server; hand-written because kanidm only serves https
export const kanidm: Template[] = [
	{
		id: "kanidm",
		name: "Kanidm",
		description: "Identity management server with OAuth2/OIDC single sign-on, passkeys and LDAP.",
		category: "Identity",
		color: "#ff7f2a",
		website: "https://kanidm.com",
		version: "1.11.2",
		web: true,
		needsDomain: true,
		tags: ["sso", "oidc", "oauth2", "ldap", "identity", "auth"],
		services: (ctx) => {
			// kanidm only serves https and its image has no shell, so a one-shot
			// worker writes a self-signed certificate into the shared data volume
			// and caddy forwards the proxy's plain http to kanidm's https port.
			const server = `${ctx.app}-server`;
			const certs = `${ctx.app}-certs`;
			const kanidmEnv = env({
				KANIDM_DOMAIN: ctx.domain,
				KANIDM_ORIGIN: ctx.url,
				KANIDM_BINDADDRESS: "0.0.0.0:8443",
				KANIDM_DB_PATH: "/data/kanidm.db",
				KANIDM_TLS_CHAIN: "/data/chain.pem",
				KANIDM_TLS_KEY: "/data/key.pem",
			});
			const data = sharedVolume(`${ctx.app}-data`, "/data");
			const image = `kanidm/server:${ctx.vars.version}`;
			return [
				caddyRouter(
					ctx,
					[],
					{ upstream: `https://${server}:8443`, insecureTls: true },
					{ depends_on: [server] },
				),
				internal(server, image, 8443, {
					env_vars: kanidmEnv,
					mounts: [data],
					depends_on: [certs],
				}),
				oneShot(certs, image, {
					command: ["/sbin/kanidmd", "cert-generate"],
					env_vars: kanidmEnv,
					mounts: [data],
					notes:
						"Creates the self-signed certificate Kanidm serves internally, then exits. It keeps an existing certificate.",
				}),
			];
		},
		instructions: (ctx) =>
			`Kanidm can take a few seconds to come up while its certificate is created. Then set the idm_admin password on the server: docker exec -it $(docker ps -qf name=-${ctx.app}-server-0-) kanidmd recover-account idm_admin. Sign in at ${ctx.url || "<url>"} as idm_admin. Keep the domain: changing it later breaks passkeys and OAuth2 clients.`,
	},
];
