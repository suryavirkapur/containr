import createClient from 'openapi-fetch';
import type { paths } from './schema';

const TOKEN_KEY = 'containr_token';

const readToken = () => localStorage.getItem(TOKEN_KEY);

export const api = createClient<paths>({
  baseUrl: '',
  headers: {
    'Content-Type': 'application/json',
  },
});

api.use({
  onRequest({ request }) {
    const token = readToken();
    if (token) {
      request.headers.set('Authorization', `Bearer ${token}`);
    }
    return request;
  },
  onResponse({ response }) {
    if (response.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      if (window.location.pathname !== '/login') {
        window.location.assign('/login');
      }
    }
    return response;
  },
});

export type { components, operations } from './schema';
