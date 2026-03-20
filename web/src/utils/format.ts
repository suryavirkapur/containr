export const describeError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'error' in error && typeof error.error === 'string') {
    return error.error;
  }
  return 'request failed';
};

export const formatDateTime = (value?: string | null): string => {
  if (!value) return 'n/a';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

export const formatList = (values?: Array<string | number> | null): string => {
  if (!values || values.length === 0) return 'none';
  return values.join(', ');
};

export const formatBytes = (bytes?: number | null): string => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let current = bytes;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current.toFixed(current >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
};

export const copyText = async (value: string) => {
  await navigator.clipboard.writeText(value);
};

export const formatUptime = (seconds?: number | null): string => {
  if (!seconds) return '0s';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  if (parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
};
