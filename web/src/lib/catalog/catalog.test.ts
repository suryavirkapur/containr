// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ServiceInput } from "../../api/platform";
import { CATEGORIES, initialValues, TEMPLATES, type Template } from "./index";

// expands every one-click app the way the deploy page does and checks the
// stack is something containr's api accepts and can wire together.

const DNS_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MOUNT_NAME = /^[A-Za-z0-9_-]+$/;

const expand = (template: Template): ServiceInput[] => {
	const app = "demo";
	const domain = template.web || template.needsDomain ? "demo.example.com" : "";
	const base = { app, domain, url: domain ? `https://${domain}` : "" };
	const vars = initialValues(template, base);
	for (const variable of template.variables ?? []) {
		if (variable.required && !vars[variable.id]) vars[variable.id] = "you@example.com";
	}
	return template.services({ ...base, vars });
};

describe("one-click app catalog", () => {
	it("has unique ids in known categories", () => {
		const ids = TEMPLATES.map((template) => template.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const template of TEMPLATES) {
			expect(CATEGORIES, template.id).toContain(template.category);
		}
	});

	describe.each(TEMPLATES.map((template) => [template.id, template] as const))(
		"%s",
		(_id, template) => {
			const services = expand(template);
			const names = services.map((service) => service.name);

			it("expands to services with unique dns-safe names", () => {
				expect(services.length).toBeGreaterThan(0);
				expect(new Set(names).size).toBe(names.length);
				for (const name of names) expect(name).toMatch(DNS_NAME);
				if (template.web) expect(names[0]).toBe("demo");
			});

			it("only depends on services in the stack", () => {
				for (const service of services) {
					for (const dependency of service.depends_on ?? []) {
						expect(names, `${service.name} -> ${dependency}`).toContain(dependency);
					}
				}
			});

			it("gives every service an image and a valid port", () => {
				for (const service of services) {
					expect(service.image, service.name).toBeTruthy();
					const worker =
						service.service_type === "background_worker" || service.service_type === "cron_job";
					if (!worker) expect(service.port, service.name).toBeGreaterThan(0);
					if (service.domains?.length) expect(service.service_type).toBe("web_service");
				}
			});

			it("uses valid volumes and config files", () => {
				for (const service of services) {
					const targets = new Set<string>();
					for (const mount of service.mounts ?? []) {
						expect(mount.name, service.name).toMatch(MOUNT_NAME);
						expect(mount.target.startsWith("/"), mount.target).toBe(true);
						expect(targets.has(mount.target), mount.target).toBe(false);
						targets.add(mount.target);
					}
					const paths = new Set<string>();
					for (const file of service.files ?? []) {
						expect(file.path.startsWith("/"), file.path).toBe(true);
						expect(paths.has(file.path), file.path).toBe(false);
						paths.add(file.path);
						for (const target of targets) {
							expect(file.path.startsWith(`${target}/`), `${file.path} in ${target}`).toBe(false);
						}
					}
				}
			});

			it("fills in every variable", () => {
				for (const service of services) {
					for (const variable of service.env_vars ?? []) {
						expect(variable.key, service.name).toMatch(/^[A-Za-z_][A-Za-z0-9_.-]*$/);
						expect(variable.value, `${service.name} ${variable.key}`).not.toMatch(/undefined/);
					}
					for (const file of service.files ?? []) {
						expect(file.content, file.path).not.toMatch(/undefined/);
					}
				}
			});
		},
	);
});
