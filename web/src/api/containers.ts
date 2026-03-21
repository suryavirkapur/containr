import { api, type components } from "./index";

export type ContainerStatus = components["schemas"]["ContainerStatusResponse"];

export const getContainerStatus = async (id: string): Promise<ContainerStatus> => {
	const { data, error } = await api.GET("/api/containers/{id}/status", {
		params: { path: { id } },
	});
	if (error) throw error;
	if (!data) throw new Error("missing container status response");
	return data;
};
