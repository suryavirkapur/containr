import type { Service } from '../api/services';

export type ServiceGroup = {
  key: string;
  id: string | null;
  label: string;
  filterLabel: string;
  networkName: string;
  appService: Service | null;
  services: Service[];
  runningCount: number;
  managedCount: number;
};

const byName = (left: string, right: string) => left.localeCompare(right);

const shortNetworkName = (value: string) => value.replace(/^containr-/, '');

export const humanize = (value: string | null | undefined): string => {
  if (!value) return 'n/a';
  return value.replace(/_/g, ' ');
};

export const groupKeyFor = (service: Service): string =>
  service.group_id ?? `isolated:${service.network_name}`;

export const groupLabelFor = (service: Service): string =>
  service.project_name?.trim() || 'isolated';

export const groupFilterLabelFor = (service: Service): string => {
  if (service.group_id) {
    return groupLabelFor(service);
  }
  return `isolated / ${shortNetworkName(service.network_name)}`;
};

export const sortServices = (rows: Service[]): Service[] =>
  [...rows].sort((left, right) => {
    if (left.resource_kind !== right.resource_kind) {
      return left.resource_kind === 'app_service' ? -1 : 1;
    }
    return byName(left.name, right.name);
  });

export const groupServices = (rows: Service[]): ServiceGroup[] => {
  const groups = new Map<string, ServiceGroup>();

  for (const service of sortServices(rows)) {
    const key = groupKeyFor(service);
    const existing = groups.get(key);

    if (existing) {
      existing.services.push(service);
      existing.runningCount += service.running_instances;
      if (service.resource_kind !== 'app_service') {
        existing.managedCount += 1;
      }
      if (!existing.appService && service.resource_kind === 'app_service') {
        existing.appService = service;
      }
      continue;
    }

    groups.set(key, {
      key,
      id: service.group_id ?? null,
      label: groupLabelFor(service),
      filterLabel: groupFilterLabelFor(service),
      networkName: service.network_name,
      appService: service.resource_kind === 'app_service' ? service : null,
      services: [service],
      runningCount: service.running_instances,
      managedCount: service.resource_kind === 'app_service' ? 0 : 1,
    });
  }

  return [...groups.values()].sort((left, right) => {
    const leftIsolated = left.id === null;
    const rightIsolated = right.id === null;
    if (leftIsolated !== rightIsolated) return leftIsolated ? 1 : -1;
    return byName(left.label, right.label);
  });
};

export const listAttachableGroups = (rows: Service[]) => {
  const options = new Map<string, { id: string; label: string; networkName: string; serviceCount: number }>();

  for (const service of rows) {
    if (service.resource_kind !== 'app_service' || !service.group_id) continue;

    const current = options.get(service.group_id);
    if (current) {
      current.serviceCount += 1;
      continue;
    }

    options.set(service.group_id, {
      id: service.group_id,
      label: groupLabelFor(service),
      networkName: service.network_name,
      serviceCount: 1,
    });
  }

  return [...options.values()].sort((left, right) => byName(left.label, right.label));
};
