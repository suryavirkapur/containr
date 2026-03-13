import type { HttpRequestLog, ServiceDeployment } from "../../api/services";

export type DetailBadgeVariant = "outline" | "success" | "warning" | "error";

export const describeError = (error: unknown): string => {
	if (error instanceof Error) {
		return error.message;
	}

	if (
		typeof error === "object" &&
		error !== null &&
		"error" in error &&
		typeof error.error === "string"
	) {
		return error.error;
	}

	return "request failed";
};

export const statusVariant = (status: string): DetailBadgeVariant => {
	switch (status) {
		case "running":
			return "success";
		case "starting":
		case "partial":
			return "warning";
		case "failed":
			return "error";
		default:
			return "outline";
	}
};

export const httpStatusVariant = (status: number): DetailBadgeVariant => {
	if (status >= 500) {
		return "error";
	}
	if (status >= 400) {
		return "warning";
	}
	if (status >= 200 && status < 400) {
		return "success";
	}
	return "outline";
};

export const certificateStatusVariant = (
	status: string,
): DetailBadgeVariant => {
	switch (status) {
		case "valid":
			return "success";
		case "pending":
		case "expiringsoon":
		case "expiring_soon":
			return "warning";
		case "expired":
		case "failed":
			return "error";
		default:
			return "outline";
	}
};

export const formatDate = (value?: string | null): string => {
	if (!value) {
		return "n/a";
	}

	return new Date(value).toLocaleString();
};

export const formatDeploymentStatus = (deployment: ServiceDeployment): string =>
	deployment.status.replaceAll("_", " ");

export const formatCertificateStatus = (status: string): string =>
	status.replaceAll("_", " ");

export const requestLabel = (request: HttpRequestLog): string =>
	`${request.method} ${request.path}`;
