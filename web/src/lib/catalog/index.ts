import { randomSecret } from "../format";
import { apps as aiApps } from "./apps/ai";
import { apps as analyticsApps } from "./apps/analytics";
import { apps as automationApps } from "./apps/automation";
import { apps as businessApps } from "./apps/business";
import { apps as cmsApps } from "./apps/cms";
import { apps as databasesApps } from "./apps/databases";
import { apps as developerApps } from "./apps/developer";
import { apps as filesApps } from "./apps/files";
import { kanidm } from "./apps/kanidm";
import { apps as mediaApps } from "./apps/media";
import { apps as monitoringApps } from "./apps/monitoring";
import { ory } from "./apps/ory";
import { apps as otherApps } from "./apps/other";
import type { Template, TemplateContext, TemplateVariable } from "./types";

export * from "./types";

/** every one-click app, in catalog order */
export const TEMPLATES: Template[] = [
	...cmsApps,
	...analyticsApps,
	...automationApps,
	...monitoringApps,
	...developerApps,
	...databasesApps,
	...filesApps,
	...businessApps,
	...mediaApps,
	...aiApps,
	...kanidm,
	...ory,
	...otherApps,
];

/** a fresh random value in the variable's generated format */
export const generateValue = (variable: TemplateVariable): string => {
	if (variable.generate === "hex64") return randomHex(32);
	if (variable.generate === "laravel-key") return `base64:${randomBase64(32)}`;
	if (variable.generate === "password") return randomSecret(20);
	if (variable.generate === "key32") return randomSecret(32);
	return randomSecret(40);
};

/** fills in generated defaults for a template's variables */
export const initialValues = (
	template: Template,
	ctx: Omit<TemplateContext, "vars">,
): Record<string, string> => {
	const values: Record<string, string> = { version: template.version ?? "latest" };
	for (const variable of template.variables ?? []) {
		if (variable.generate) values[variable.id] = generateValue(variable);
		else if (typeof variable.default === "function")
			values[variable.id] = variable.default({ ...ctx, vars: values });
		else values[variable.id] = variable.default ?? "";
	}
	return values;
};

const randomBytes = (length: number) => {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
};

const randomHex = (length: number) =>
	Array.from(randomBytes(length), (byte) => byte.toString(16).padStart(2, "0")).join("");

const randomBase64 = (length: number) => btoa(String.fromCharCode(...randomBytes(length)));

export const findTemplate = (id: string) => TEMPLATES.find((template) => template.id === id);
