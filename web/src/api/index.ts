import createClient from "openapi-fetch";
import type { paths } from "./schema";

const getToken = () => localStorage.getItem("znskr_token");

export const api = createClient<paths>({
  baseUrl: "",
  headers: {
    "Content-Type": "application/json",
  },
});

api.use({
  onRequest({ request }) {
    const token = getToken();
    if (token) {
      request.headers.set("Authorization", `Bearer ${token}`);
    }
    return request;
  },
  onResponse({ response }) {
    if (response.status === 401) {
      localStorage.removeItem("znskr_token");
      window.location.href = "/login";
    }
    return response;
  },
});

export type { components, operations } from "./schema";
