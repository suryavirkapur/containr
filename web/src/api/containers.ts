import { api, type components } from './index';
import type { paths } from './schema';

const TOKEN_KEY = 'containr_token';

export type Container = components['schemas']['ContainerListItem'];
export type ContainerStatus = components['schemas']['ContainerStatusResponse'];
export type ContainerMount = components['schemas']['ContainerMountResponse'];
export type VolumeEntry = components['schemas']['VolumeEntry'];
export type ExecToken = components['schemas']['ExecTokenResponse'];

type FilesQuery = { mount: string; path?: string | null };
type LogsQuery =
  paths['/api/containers/{id}/logs']['get']['parameters']['query'];

const readToken = () => localStorage.getItem(TOKEN_KEY);

export const listContainers = async (): Promise<Container[]> => {
  const { data, error } = await api.GET('/api/containers');
  if (error) throw error;
  return data ?? [];
};

export const getContainerStatus = async (id: string): Promise<ContainerStatus> => {
  const { data, error } = await api.GET('/api/containers/{id}/status', {
    params: { path: { id } },
  });
  if (error) throw error;
  if (!data) throw new Error('missing container status');
  return data;
};

export const getContainerLogs = async (
  id: string,
  query: LogsQuery = {},
): Promise<string> => {
  const { data, error } = await api.GET('/api/containers/{id}/logs', {
    params: { path: { id }, query },
  });
  if (error) throw error;
  return data?.logs ?? '';
};

export const getContainerMounts = async (id: string): Promise<ContainerMount[]> => {
  const { data, error } = await api.GET('/api/containers/{id}/mounts', {
    params: { path: { id } },
  });
  if (error) throw error;
  return data ?? [];
};

export const listContainerFiles = async (
  id: string,
  query: FilesQuery,
): Promise<VolumeEntry[]> => {
  const { data, error } = await api.GET('/api/containers/{id}/files', {
    params: {
      path: { id },
      query: {
        mount: query.mount,
        path: query.path ?? undefined,
      },
    },
  });
  if (error) throw error;
  return data ?? [];
};

export const deleteContainerFile = async (
  id: string,
  query: FilesQuery,
): Promise<void> => {
  const { error } = await api.DELETE('/api/containers/{id}/files', {
    params: {
      path: { id },
      query: {
        mount: query.mount,
        path: query.path ?? undefined,
      },
    },
  });
  if (error) throw error;
};

export const createContainerDirectory = async (
  id: string,
  mount: string,
  path: string,
): Promise<void> => {
  const { error } = await api.POST('/api/containers/{id}/files/mkdir', {
    params: {
      path: { id },
      query: { mount, path },
    },
  });
  if (error) throw error;
};

export const uploadContainerFiles = async (
  id: string,
  mount: string,
  files: FileList | File[],
  path?: string | null,
): Promise<void> => {
  const form = new FormData();
  for (const file of Array.from(files)) {
    form.append('files', file, file.name);
  }

  const params = new URLSearchParams({ mount });
  if (path) params.set('path', path);

  const token = readToken();
  const response = await fetch(`/api/containers/${encodeURIComponent(id)}/files/upload?${params.toString()}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });

  if (!response.ok) {
    let message = response.statusText || 'request failed';
    try {
      const data = await response.json();
      if (data && typeof data.error === 'string') {
        message = data.error;
      }
    } catch {
      // ignore
    }
    throw new Error(message);
  }
};

export const downloadContainerFile = async (
  id: string,
  query: FilesQuery,
): Promise<void> => {
  const params = new URLSearchParams({ mount: query.mount });
  if (query.path) params.set('path', query.path);

  const token = readToken();
  const response = await fetch(`/api/containers/${encodeURIComponent(id)}/files/download?${params.toString()}`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });

  if (!response.ok) {
    let message = response.statusText || 'request failed';
    try {
      const data = await response.json();
      if (data && typeof data.error === 'string') {
        message = data.error;
      }
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const filename =
    response.headers.get('content-disposition')?.match(/filename=\"?([^"]+)\"?/)?.[1] ??
    query.path?.split('/').pop() ??
    'download';
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(href);
};

export const issueContainerExecToken = async (id: string): Promise<ExecToken> => {
  const { data, error } = await api.POST('/api/containers/{id}/exec/token', {
    params: { path: { id } },
  });
  if (error) throw error;
  if (!data) throw new Error('missing exec token');
  return data;
};

export const buildContainerExecWebSocketUrl = (
  id: string,
  token: string,
  shell = '/bin/sh',
  cols = 120,
  rows = 32,
): string => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({
    token,
    shell,
    cols: String(cols),
    rows: String(rows),
  });
  return `${protocol}//${window.location.host}/api/containers/${encodeURIComponent(id)}/exec/ws?${params.toString()}`;
};
