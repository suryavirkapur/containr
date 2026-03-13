import { api, type components } from './index';

export type Bucket = components['schemas']['BucketResponse'];
export type BucketConnection = components['schemas']['BucketConnectionResponse'];

export const listBuckets = async (): Promise<Bucket[]> => {
  const { data, error } = await api.GET('/api/buckets');
  if (error) throw error;
  return data ?? [];
};

export const createBucket = async (name: string): Promise<Bucket> => {
  const { data, error } = await api.POST('/api/buckets', { body: { name } });
  if (error) throw error;
  if (!data) throw new Error('missing bucket response');
  return data;
};

export const getBucket = async (id: string): Promise<Bucket> => {
  const { data, error } = await api.GET('/api/buckets/{id}', { params: { path: { id } } });
  if (error) throw error;
  if (!data) throw new Error('missing bucket response');
  return data;
};

export const getBucketConnection = async (id: string): Promise<BucketConnection> => {
  const { data, error } = await api.GET('/api/buckets/{id}/connection', { params: { path: { id } } });
  if (error) throw error;
  if (!data) throw new Error('missing bucket connection response');
  return data;
};

export const deleteBucket = async (id: string): Promise<void> => {
  const { error } = await api.DELETE('/api/buckets/{id}', { params: { path: { id } } });
  if (error) throw error;
};
