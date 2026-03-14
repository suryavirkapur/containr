import { api } from './index';
import type { paths } from './schema';

export type GithubAppRepo =
  paths['/api/github/app/repos']['get']['responses']['200']['content']['application/json']['repos'][number];

export const listGithubAppRepos = async (): Promise<GithubAppRepo[]> => {
  const { data, error } = await api.GET('/api/github/app/repos');
  if (error) throw error;
  return data?.repos ?? [];
};
