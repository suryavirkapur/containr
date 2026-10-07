import type { ServiceInput } from "../../../api/platform";
import {
	type CaddyRoute,
	caddyRouter,
	dbPassword,
	env,
	file,
	internal,
	postgres,
	shell,
	web,
} from "../helpers";
import type { Template, TemplateContext, TemplateVariable } from "../types";

// ory identity stack. kratos and hydra sit behind a caddy router so the
// self-service ui, kratos' public api and hydra's oauth2 endpoints share
// one domain, which keeps their cookies working. configs are mounted as
// files; secrets stay in secret env vars.

const ORY_VERSION = "v26.2.0";
const ORY_COLOR = "#5528ff";
const KRATOS_CONFIG = "/etc/config/kratos/kratos.yml";
const KRATOS_SCHEMA = "/etc/config/kratos/identity.schema.json";
const HYDRA_CONFIG = "/etc/config/hydra/hydra.yml";

/** turns off ory's usage telemetry */
const NO_TELEMETRY = { SQA_OPT_OUT: "true" };

const oryImage = (ctx: TemplateContext, name: string) =>
	`oryd/${name}:${ctx.vars.version || ORY_VERSION}`;

const names = (ctx: TemplateContext) => ({
	kratos: `${ctx.app}-kratos`,
	hydra: `${ctx.app}-hydra`,
	ui: `${ctx.app}-ui`,
	db: `${ctx.app}-db`,
});

const kratosVariables: TemplateVariable[] = [
	dbPassword,
	{ id: "cookie_secret", label: "Session cookie secret", generate: "secret", secret: true },
	{ id: "cipher_secret", label: "Cipher secret", generate: "key32", secret: true },
	{ id: "ui_secret", label: "UI cookie secret", generate: "secret", secret: true },
	{
		id: "smtp_uri",
		label: "SMTP connection URI",
		description:
			"Used for verification and recovery emails, e.g. smtps://user:pass@smtp.example.com:465. Leave empty to turn those flows off.",
		placeholder: "smtps://user:pass@smtp.example.com:465",
		secret: true,
	},
];

const identitySchema = `{
  "$id": "https://schemas.ory.sh/presets/kratos/identity.email.schema.json",
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Person",
  "type": "object",
  "properties": {
    "traits": {
      "type": "object",
      "properties": {
        "email": {
          "type": "string",
          "format": "email",
          "title": "Email",
          "ory.sh/kratos": {
            "credentials": { "password": { "identifier": true } },
            "recovery": { "via": "email" },
            "verification": { "via": "email" }
          }
        }
      },
      "required": ["email"],
      "additionalProperties": false
    }
  }
}
`;

const kratosConfig = (ctx: TemplateContext, withHydra: boolean) => {
	const url = ctx.url || "https://localhost";
	const mail = Boolean(ctx.vars.smtp_uri?.trim());
	const hydra = withHydra ? `\noauth2_provider:\n  url: http://${names(ctx).hydra}:4445\n` : "";
	return `version: ${ORY_VERSION}
serve:
  public:
    base_url: ${url}/
  admin:
    base_url: http://${names(ctx).kratos}:4434/
selfservice:
  default_browser_return_url: ${url}/
  allowed_return_urls:
    - ${url}
  methods:
    password:
      enabled: true
    code:
      enabled: ${mail}
  flows:
    error:
      ui_url: ${url}/error
    settings:
      ui_url: ${url}/settings
      privileged_session_max_age: 15m
    recovery:
      enabled: ${mail}
      ui_url: ${url}/recovery
    verification:
      enabled: ${mail}
      ui_url: ${url}/verification
    logout:
      after:
        default_browser_return_url: ${url}/login
    login:
      ui_url: ${url}/login
    registration:
      ui_url: ${url}/registration
      after:
        password:
          hooks:
            - hook: session
identity:
  default_schema_id: default
  schemas:
    - id: default
      url: file://${KRATOS_SCHEMA}
${hydra}`;
};

/** kratos, migrating its database before it serves */
const kratosService = (ctx: TemplateContext, withHydra: boolean): ServiceInput => {
	const n = names(ctx);
	const smtp = ctx.vars.smtp_uri?.trim() || "smtp://localhost:25/?disable_starttls=true";
	return internal(n.kratos, oryImage(ctx, "kratos"), 4433, {
		additional_ports: [4434],
		...shell(
			`kratos migrate sql -e --yes -c ${KRATOS_CONFIG} && exec kratos serve -c ${KRATOS_CONFIG}`,
		),
		env_vars: env(
			{
				DSN: `postgres://ory:${ctx.vars.db_password}@${n.db}:5432/kratos?sslmode=disable`,
				SECRETS_COOKIE: JSON.stringify([ctx.vars.cookie_secret]),
				SECRETS_CIPHER: JSON.stringify([ctx.vars.cipher_secret]),
				COURIER_SMTP_CONNECTION_URI: smtp,
				...NO_TELEMETRY,
			},
			["DSN", "SECRETS_COOKIE", "SECRETS_CIPHER", "COURIER_SMTP_CONNECTION_URI"],
		),
		files: [file(KRATOS_CONFIG, kratosConfig(ctx, withHydra)), file(KRATOS_SCHEMA, identitySchema)],
		depends_on: [n.db],
	});
};

/** ory's reference login, registration, settings and consent pages */
const uiService = (ctx: TemplateContext, withHydra: boolean): ServiceInput => {
	const n = names(ctx);
	return internal(
		n.ui,
		`oryd/kratos-selfservice-ui-node:${ctx.vars.version || ORY_VERSION}`,
		3000,
		{
			env_vars: env(
				{
					PORT: "3000",
					KRATOS_PUBLIC_URL: `http://${n.kratos}:4433/`,
					KRATOS_BROWSER_URL: `${ctx.url || "https://localhost"}/`,
					// no trailing slash: the ui appends /admin/...
					HYDRA_ADMIN_URL: withHydra ? `http://${n.hydra}:4445` : undefined,
					COOKIE_SECRET: ctx.vars.ui_secret,
					CSRF_COOKIE_NAME: "__Host-ory-csrf",
					CSRF_COOKIE_SECRET: ctx.vars.ui_secret,
				},
				["COOKIE_SECRET", "CSRF_COOKIE_SECRET"],
			),
			depends_on: [n.kratos],
		},
	);
};

/** kratos' public api paths; everything else is the ui */
const kratosRoutes = (ctx: TemplateContext): CaddyRoute => ({
	paths: ["/self-service/*", "/sessions/*", "/.well-known/ory/*", "/schemas", "/schemas/*"],
	upstream: `http://${names(ctx).kratos}:4433`,
});

const hydraRoutes = (ctx: TemplateContext): CaddyRoute => ({
	paths: ["/oauth2/*", "/.well-known/openid-configuration", "/.well-known/jwks.json", "/userinfo"],
	upstream: `http://${names(ctx).hydra}:4444`,
});

const hydraConfig = (ctx: TemplateContext) => {
	const url = ctx.url || "https://localhost";
	return `serve:
  cookies:
    same_site_mode: Lax
urls:
  self:
    issuer: ${url}/
  login: ${url}/login
  consent: ${url}/consent
  logout: ${url}/logout
  error: ${url}/error
oidc:
  subject_identifiers:
    supported_types:
      - public
`;
};

export const ory: Template[] = [
	{
		id: "ory-kratos",
		name: "Ory Kratos",
		description:
			"Identity and user management: sign-up, login, account settings and recovery with Ory's self-service UI.",
		category: "Identity",
		color: ORY_COLOR,
		website: "https://www.ory.sh/kratos",
		version: ORY_VERSION,
		web: true,
		needsDomain: true,
		tags: ["ory", "identity", "auth", "login", "users"],
		variables: kratosVariables,
		services: (ctx) => {
			const n = names(ctx);
			return [
				caddyRouter(
					ctx,
					[kratosRoutes(ctx)],
					{ upstream: `http://${n.ui}:3000` },
					{
						depends_on: [n.kratos, n.ui],
					},
				),
				uiService(ctx, false),
				kratosService(ctx, false),
				postgres(ctx, "kratos", "ory"),
			];
		},
		instructions: (ctx) =>
			`Create an account at ${ctx.url || "<url>"}/registration. Kratos' admin API (port 4434 on ${names(ctx).kratos}) is only reachable inside the project. Edit the identity schema and flows in the kratos service's Storage tab, then redeploy.`,
	},
	{
		id: "ory-hydra",
		name: "Ory Hydra",
		description:
			"OAuth2 and OpenID Connect provider, with Kratos for login and Ory's UI for consent. Add single sign-on to your apps.",
		category: "Identity",
		color: ORY_COLOR,
		website: "https://www.ory.sh/hydra",
		version: ORY_VERSION,
		web: true,
		needsDomain: true,
		tags: ["ory", "oauth2", "oidc", "sso", "identity", "auth"],
		variables: [
			...kratosVariables,
			{ id: "system_secret", label: "Hydra system secret", generate: "secret", secret: true },
		],
		services: (ctx) => {
			const n = names(ctx);
			const db = postgres(ctx, "kratos", "ory");
			// kratos and hydra both create tables like `networks`, so hydra
			// gets its own database, created on the first start
			db.files = [
				file("/docker-entrypoint-initdb.d/hydra.sql", "CREATE DATABASE hydra OWNER ory;\n"),
			];
			return [
				caddyRouter(
					ctx,
					[hydraRoutes(ctx), kratosRoutes(ctx)],
					{ upstream: `http://${n.ui}:3000` },
					{ depends_on: [n.kratos, n.hydra, n.ui] },
				),
				uiService(ctx, true),
				kratosService(ctx, true),
				internal(n.hydra, oryImage(ctx, "hydra"), 4444, {
					additional_ports: [4445],
					...shell(
						`hydra migrate sql up -e --yes -c ${HYDRA_CONFIG} && exec hydra serve all -c ${HYDRA_CONFIG}`,
					),
					env_vars: env(
						{
							DSN: `postgres://ory:${ctx.vars.db_password}@${n.db}:5432/hydra?sslmode=disable`,
							SECRETS_SYSTEM: JSON.stringify([ctx.vars.system_secret]),
							...NO_TELEMETRY,
						},
						["DSN", "SECRETS_SYSTEM"],
					),
					files: [file(HYDRA_CONFIG, hydraConfig(ctx))],
					depends_on: [n.db],
				}),
				db,
			];
		},
		instructions: (ctx) =>
			`OIDC discovery is at ${ctx.url || "<url>"}/.well-known/openid-configuration. Hydra's admin API (port 4445 on ${names(ctx).hydra}) is only reachable inside the project; create a client from the server with: docker exec $(docker ps -qf name=-${names(ctx).hydra}-0-) hydra create oauth2-client --endpoint http://localhost:4445 --name my-app --grant-type authorization_code,refresh_token --response-type code --scope openid,offline --redirect-uri https://my-app.example.com/callback`,
	},
	{
		id: "ory-keto",
		name: "Ory Keto",
		description:
			"Permission server based on Google Zanzibar: store relationships and check who can do what.",
		category: "Identity",
		color: ORY_COLOR,
		website: "https://www.ory.sh/keto",
		version: ORY_VERSION,
		tags: ["ory", "permissions", "authorization", "zanzibar", "rbac"],
		variables: [dbPassword],
		services: (ctx) => {
			const config = "/etc/config/keto/keto.yml";
			return [
				internal(ctx.app, oryImage(ctx, "keto"), 4466, {
					additional_ports: [4467],
					...shell(`keto migrate up -y -c ${config} && exec keto serve -c ${config}`),
					env_vars: env(
						{
							DSN: `postgres://keto:${ctx.vars.db_password}@${ctx.app}-db:5432/keto?sslmode=disable`,
							...NO_TELEMETRY,
						},
						["DSN"],
					),
					files: [
						file(
							config,
							`version: ${ORY_VERSION}
serve:
  read:
    host: 0.0.0.0
    port: 4466
  write:
    host: 0.0.0.0
    port: 4467
namespaces:
  - id: 0
    name: default
`,
						),
					],
					depends_on: [`${ctx.app}-db`],
				}),
				postgres(ctx, "keto", "keto"),
			];
		},
		instructions: (ctx) =>
			`Services in the same project or group reach the read API at http://${ctx.app}:4466 and the write API at http://${ctx.app}:4467. Add namespaces in the Storage tab's keto.yml, then redeploy.`,
	},
	{
		id: "ory-oathkeeper",
		name: "Ory Oathkeeper",
		description:
			"Identity and access proxy: authenticates and authorizes requests before they reach your app.",
		category: "Identity",
		color: ORY_COLOR,
		website: "https://www.ory.sh/oathkeeper",
		version: ORY_VERSION,
		web: true,
		tags: ["ory", "proxy", "zero trust", "auth"],
		variables: [
			{
				id: "upstream",
				label: "Upstream URL",
				description: "The app Oathkeeper forwards allowed requests to.",
				default: "http://my-app:3000",
				required: true,
			},
		],
		services: (ctx) => {
			const config = "/etc/config/oathkeeper/config.yml";
			const rules = "/etc/config/oathkeeper/rules.json";
			const allowAll = [
				{
					id: "allow-all",
					upstream: { url: ctx.vars.upstream, preserve_host: true },
					match: {
						url: "<.*>",
						methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
					},
					authenticators: [{ handler: "anonymous" }],
					authorizer: { handler: "allow" },
					mutators: [{ handler: "header" }],
				},
			];
			return [
				web(ctx, oryImage(ctx, "oathkeeper"), 4455, {
					additional_ports: [4456],
					command: ["serve", "-c", config],
					env_vars: env(NO_TELEMETRY),
					files: [
						file(
							config,
							`serve:
  proxy:
    port: 4455
  api:
    port: 4456
access_rules:
  matching_strategy: regexp
  repositories:
    - file://${rules}
authenticators:
  anonymous:
    enabled: true
    config:
      subject: guest
  noop:
    enabled: true
authorizers:
  allow:
    enabled: true
  deny:
    enabled: true
mutators:
  noop:
    enabled: true
  header:
    enabled: true
    config:
      headers:
        X-User: "{{ print .Subject }}"
errors:
  fallback:
    - json
  handlers:
    json:
      enabled: true
`,
						),
						file(rules, `${JSON.stringify(allowAll, null, 2)}\n`),
					],
				}),
			];
		},
		instructions: () =>
			"Every request is allowed and forwarded with an X-User header. Tighten the rules in rules.json on the Storage tab (add cookie_session or jwt authenticators), then redeploy.",
	},
];
