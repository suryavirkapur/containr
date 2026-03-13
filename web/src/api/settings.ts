import { api, type components } from './index';

export type Settings = components['schemas']['SettingsResponse'];
export type SystemStats = components['schemas']['SystemStats'];
export type GithubAppStatus = components['schemas']['GithubAppStatusResponse'];

type UpdateSettingsBody = components['schemas']['UpdateSettingsRequest'];

const readError = async (response: Response) => {
  try {
    const data = await response.json();
    if (data && typeof data.error === 'string') {
      return data.error;
    }
  } catch {
    // ignore parse failures and fall back to the status text
  }
  return response.statusText || 'request failed';
};

export const getSettings = async (): Promise<Settings> => {
  const { data, error } = await api.GET('/api/settings');
  if (error) throw error;
  if (!data) throw new Error('missing settings response');
  return data;
};

export const updateSettings = async (body: UpdateSettingsBody): Promise<Settings> => {
  const { data, error } = await api.PUT('/api/settings', { body });
  if (error) throw error;
  if (!data) throw new Error('missing updated settings response');
  return data;
};

export const issueDashboardCertificate = async () => {
  const { data, error } = await api.POST('/api/settings/certificate');
  if (error) throw error;
  if (!data) throw new Error('missing certificate response');
  return data;
};

export const getSystemStats = async (): Promise<SystemStats> => {
  const { data, error } = await api.GET('/api/system/stats');
  if (error) throw error;
  if (!data) throw new Error('missing system stats response');
  return data;
};

export const getGithubAppStatus = async (): Promise<GithubAppStatus> => {
  const { data, error } = await api.GET('/api/github/app');
  if (error) throw error;
  if (!data) {
    return { configured: false, app: null, installations: [] };
  }
  return data;
};

export const getGithubAppManifest = async (): Promise<string> => {
  const { data, error } = await api.GET('/api/github/app/manifest');
  if (error) throw error;
  return typeof data === 'string' ? data : JSON.stringify(data);
};

export const finishGithubAppSetup = async (code: string, token: string): Promise<void> => {
  const response = await fetch(`/api/github/app/callback?code=${encodeURIComponent(code)}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }
};

export const finishGithubAppInstall = async (
  installationId: string | null,
  setupAction: string | null,
  token: string,
): Promise<void> => {
  const params = new URLSearchParams();
  if (installationId) params.set('installation_id', installationId);
  if (setupAction) params.set('setup_action', setupAction);

  const response = await fetch(`/api/github/app/install/callback?${params.toString()}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }
};

export const deleteGithubApp = async (): Promise<void> => {
  const { error } = await api.DELETE('/api/github/app');
  if (error) throw error;
};
