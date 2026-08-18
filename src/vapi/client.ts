import { requireEnv } from "../lib/env.js";

/**
 * Thin Vapi HTTP client (PRD 4.2: "Keep Vapi-specific code in a small
 * adapter/module rather than mixing it into extraction logic").
 *
 * Deliberately raw fetch rather than an SDK. The POC benefits from being able
 * to read exactly what is sent to Vapi and what comes back, and the surface we
 * use is three endpoints.
 */
const BASE_URL = "https://api.vapi.ai";

async function request<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${requireEnv("VAPI_API_KEY")}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();

  if (!response.ok) {
    // Vapi returns useful validation detail in the body; surface all of it,
    // because a rejected assistant payload is otherwise very hard to debug.
    throw new Error(`Vapi ${method} ${path} failed (${response.status}): ${text}`);
  }

  return (text ? JSON.parse(text) : {}) as T;
}

export const vapi = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
};

export interface VapiAssistant {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface VapiPhoneNumber {
  id: string;
  number?: string;
  provider?: string;
}

export interface VapiCall {
  id: string;
  status?: string;
  monitor?: { listenUrl?: string; controlUrl?: string };
}
