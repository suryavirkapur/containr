import type { Service as ServiceFormValue } from "../ServiceForm";
import type { EditableEnvVar } from "../../utils/projectEditor";

export type SettingsFormState = {
	githubUrl: string;
	branch: string;
	rolloutStrategy: string;
	envVars: EditableEnvVar[];
	service: ServiceFormValue;
	autoDeployEnabled: boolean;
	autoDeployWatchPathsText: string;
	cleanupStaleDeployments: boolean;
	webhookPath: string;
	regenerateWebhookToken: boolean;
};

export type MetadataRow = {
	label: string;
	value: string;
};
