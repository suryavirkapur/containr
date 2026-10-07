import type { ServiceInput } from "../../api/platform";

// one-click app catalog types. a template expands user answers into a stack
// of services that share a project network and reach each other by service
// name. see docs/one-click-apps.md.

export type TemplateVariable = {
	id: string;
	label: string;
	description?: string;
	default?: string | ((ctx: TemplateContext) => string);
	/** generated when the form opens; still editable */
	/** key32 is exactly 32 characters, for ciphers that need that length */
	generate?: "password" | "secret" | "key32" | "hex64" | "laravel-key";
	secret?: boolean;
	required?: boolean;
	placeholder?: string;
};

export type TemplateContext = {
	/** project/app name chosen by the user (lowercase, dns-safe) */
	app: string;
	/** public domain for the main service, may be empty */
	domain: string;
	/** https://domain or empty */
	url: string;
	vars: Record<string, string>;
};

export type Template = {
	id: string;
	name: string;
	description: string;
	category: Category;
	color: string;
	website: string;
	/** default docker image tag users can override */
	version?: string;
	variables?: TemplateVariable[];
	services: (ctx: TemplateContext) => ServiceInput[];
	/** shown after deploy */
	instructions?: (ctx: TemplateContext) => string;
	/** main service needs a public domain */
	web?: boolean;
	/** app only works behind its own domain, so the domain field is required */
	needsDomain?: boolean;
	tags?: string[];
};

export type Category =
	| "CMS & Blogs"
	| "Analytics"
	| "Automation"
	| "Monitoring"
	| "Developer tools"
	| "Identity"
	| "Databases"
	| "Files & Productivity"
	| "Media"
	| "AI"
	| "Business"
	| "Other";

export const CATEGORIES: Category[] = [
	"CMS & Blogs",
	"Analytics",
	"Automation",
	"Monitoring",
	"Developer tools",
	"Identity",
	"Databases",
	"Files & Productivity",
	"Business",
	"Media",
	"AI",
	"Other",
];
