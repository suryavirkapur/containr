import { createContext, type JSX, useContext } from "solid-js";
import { createStore, type SetStoreFunction } from "solid-js/store";
import { listContainers as apiListContainers, type Container } from "../api/containers";
import {
	createService as apiCreateService,
	deleteService as apiDeleteService,
	runServiceAction as apiRunAction,
	triggerServiceDeployment as apiTriggerDeploy,
	updateService as apiUpdateService,
	type CreateServiceBody,
	type DeploymentTriggerBody,
	listServices,
	type Service,
	type ServiceAction,
	type UpdateServiceBody,
} from "../api/services";

interface AppState {
	services: Service[];
	containers: Container[];
	servicesLoading: boolean;
	containersLoading: boolean;
	servicesError: string | null;
	containersError: string | null;
	pendingServiceId: string | null;
	pollingServiceId: string | null;
}

interface AppStoreValue {
	state: AppState;
	set: SetStoreFunction<AppState>;
	loadServices: () => Promise<void>;
	loadContainers: () => Promise<void>;
	refreshAll: () => Promise<void>;
	runAction: (id: string, action: ServiceAction) => Promise<Service>;
	removeService: (id: string) => Promise<void>;
	updateService: (id: string, body: UpdateServiceBody) => Promise<Service>;
	triggerDeploy: (id: string, body?: DeploymentTriggerBody) => Promise<unknown>;
	createService: (body: CreateServiceBody) => Promise<Service>;
	upsertService: (service: Service) => void;
	removeServiceFromStore: (id: string) => void;
}

const initialState: AppState = {
	services: [],
	containers: [],
	servicesLoading: false,
	containersLoading: false,
	servicesError: null,
	containersError: null,
	pendingServiceId: null,
	pollingServiceId: null,
};

const AppStoreContext = createContext<AppStoreValue>();

let pollTimer: ReturnType<typeof setInterval> | null = null;

export const AppStoreProvider = (props: { children: JSX.Element }) => {
	const [state, set] = createStore<AppState>({ ...initialState });

	const loadServices = async () => {
		set("servicesLoading", true);
		set("servicesError", null);
		try {
			const data = await listServices();
			set("services", data);
		} catch (error) {
			set("servicesError", error instanceof Error ? error.message : "Failed to load services");
		} finally {
			set("servicesLoading", false);
		}
	};

	const loadContainers = async () => {
		set("containersLoading", true);
		set("containersError", null);
		try {
			const data = await apiListContainers();
			set("containers", data);
		} catch (error) {
			set("containersError", error instanceof Error ? error.message : "Failed to load containers");
		} finally {
			set("containersLoading", false);
		}
	};

	const refreshAll = async () => {
		await Promise.all([loadServices(), loadContainers()]);
	};

	const pollServiceStatus = (id: string) => {
		if (pollTimer) {
			clearInterval(pollTimer);
		}
		set("pollingServiceId", id);
		let attempts = 0;
		const maxAttempts = 7; // ~10.5s at 1.5s intervals
		pollTimer = setInterval(async () => {
			attempts++;
			try {
				const data = await listServices();
				set("services", data);
			} catch {
				// silent
			}
			if (attempts >= maxAttempts) {
				if (pollTimer) clearInterval(pollTimer);
				pollTimer = null;
				set("pollingServiceId", null);
			}
		}, 1500);
	};

	const upsertService = (service: Service) => {
		set("services", (prev) => {
			const idx = prev.findIndex((s) => s.id === service.id);
			if (idx === -1) return [...prev, service];
			const next = [...prev];
			next[idx] = service;
			return next;
		});
	};

	const removeServiceFromStore = (id: string) => {
		set("services", (prev) => prev.filter((s) => s.id !== id));
	};

	const runAction = async (id: string, action: ServiceAction): Promise<Service> => {
		set("pendingServiceId", id);
		try {
			const updated = await apiRunAction(id, action);
			upsertService(updated);
			pollServiceStatus(id);
			return updated;
		} finally {
			set("pendingServiceId", null);
		}
	};

	const removeService = async (id: string) => {
		set("pendingServiceId", id);
		try {
			await apiDeleteService(id);
			removeServiceFromStore(id);
		} finally {
			set("pendingServiceId", null);
		}
	};

	const updateServiceFn = async (id: string, body: UpdateServiceBody): Promise<Service> => {
		set("pendingServiceId", id);
		try {
			const updated = await apiUpdateService(id, body);
			upsertService(updated);
			return updated;
		} finally {
			set("pendingServiceId", null);
		}
	};

	const triggerDeploy = async (id: string, body?: DeploymentTriggerBody) => {
		set("pendingServiceId", id);
		try {
			const result = await apiTriggerDeploy(id, body);
			pollServiceStatus(id);
			return result;
		} finally {
			set("pendingServiceId", null);
		}
	};

	const createServiceFn = async (body: CreateServiceBody): Promise<Service> => {
		const created = await apiCreateService(body);
		upsertService(created);
		return created;
	};

	return (
		<AppStoreContext.Provider
			value={{
				state,
				set,
				loadServices,
				loadContainers,
				refreshAll,
				runAction,
				removeService,
				updateService: updateServiceFn,
				triggerDeploy,
				createService: createServiceFn,
				upsertService,
				removeServiceFromStore,
			}}
		>
			{props.children}
		</AppStoreContext.Provider>
	);
};

export const useAppStore = () => {
	const context = useContext(AppStoreContext);
	if (!context) {
		throw new Error("useAppStore must be used within AppStoreProvider");
	}
	return context;
};
