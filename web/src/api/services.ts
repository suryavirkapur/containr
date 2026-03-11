import { api, type components } from "./index";
import type { paths } from "./schema";

export type Service = components["schemas"]["InventoryServiceResponse"];
export type ServiceDeployment = components["schemas"]["DeploymentResponse"];
export type ServiceAction = "start" | "stop" | "restart";

type CreateServiceBody =
	paths["/api/services"]["post"]["requestBody"]["content"]["application/json"];
type DeploymentTriggerBody =
	paths["/api/services/{id}/deployments"]["post"]["requestBody"]["content"]["application/json"];
type DeploymentRollbackBody =
	paths["/api/services/{id}/deployments/{deployment_id}/rollback"]["post"]["requestBody"]["content"]["application/json"];

export const createService = async (body: CreateServiceBody): Promise<Service> => {
	const { data, error } = await api.POST("/api/services", { body });
	if (error) {
		throw error;
	}

	if (!data) {
		throw new Error("missing service response");
	}

	return data;
};

export const listServices = async (groupId?: string): Promise<Service[]> => {
	const { data, error } = groupId
		? await api.GET("/api/services", {
				params: {
					query: {
						group_id: groupId,
					},
				},
			})
		: await api.GET("/api/services");
	if (error) {
		throw error;
	}

	return data ?? [];
};

export const getService = async (id: string): Promise<Service> => {
	const { data, error } = await api.GET("/api/services/{id}", {
		params: { path: { id } },
	});
	if (error) {
		throw error;
	}

	if (!data) {
		throw new Error("missing service response");
	}

	return data;
};

export const getServiceLogs = async (id: string, tail = 200): Promise<string> => {
	const { data, error } = await api.GET("/api/services/{id}/logs", {
		params: {
			path: { id },
			query: { tail },
		},
	});
	if (error) {
		throw error;
	}

	return data?.logs ?? "";
};

export const runServiceAction = async (
	id: string,
	action: ServiceAction,
): Promise<Service> => {
	const { data, error } = await api.POST("/api/services/{id}/actions/{action}", {
		params: {
			path: {
				id,
				action,
			},
		},
	});
	if (error) {
		throw error;
	}

	if (!data) {
		throw new Error("missing service response");
	}

	return data;
};

export const deleteService = async (id: string): Promise<void> => {
	const { error } = await api.DELETE("/api/services/{id}", {
		params: { path: { id } },
	});
	if (error) {
		throw error;
	}
};

export const listServiceDeployments = async (
	id: string,
): Promise<ServiceDeployment[]> => {
	const { data, error } = await api.GET("/api/services/{id}/deployments", {
		params: { path: { id } },
	});
	if (error) {
		throw error;
	}

	return data ?? [];
};

export const triggerServiceDeployment = async (
	id: string,
	body?: DeploymentTriggerBody,
): Promise<ServiceDeployment> => {
	const { data, error } = await api.POST("/api/services/{id}/deployments", {
		params: { path: { id } },
		body: body ?? {},
	});
	if (error) {
		throw error;
	}

	if (!data) {
		throw new Error("missing deployment response");
	}

	return data;
};

export const rollbackServiceDeployment = async (
	id: string,
	deploymentId: string,
	body?: DeploymentRollbackBody,
): Promise<ServiceDeployment> => {
	const { data, error } = await api.POST(
		"/api/services/{id}/deployments/{deployment_id}/rollback",
		{
			params: {
				path: {
					id,
					deployment_id: deploymentId,
				},
			},
			body: body ?? {},
		},
	);
	if (error) {
		throw error;
	}

	if (!data) {
		throw new Error("missing deployment response");
	}

	return data;
};

export const getServiceDeploymentLogs = async (
	id: string,
	deploymentId: string,
	limit = 200,
	offset = 0,
): Promise<string[]> => {
	const { data, error } = await api.GET(
		"/api/services/{id}/deployments/{deployment_id}/logs",
		{
			params: {
				path: {
					id,
					deployment_id: deploymentId,
				},
				query: {
					limit,
					offset,
				},
			},
		},
	);
	if (error) {
		throw error;
	}

	return data ?? [];
};
