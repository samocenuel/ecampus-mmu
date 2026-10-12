// Thin fetch wrapper for the REST API. In development Vite proxies /api and
// /uploads to the backend; set VITE_API_URL to call a different server.
export const API_BASE: string = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || '';

const TOKEN_KEY = 'lms_token';

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let token: string | null = readToken();
let onUnauthorized: (() => void) | null = null;

export function setToken(t: string | null) {
  token = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable - keep the token in memory */
  }
}

export const getToken = () => token;
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

export class ApiError extends Error {
  status: number;
  data: any;
  constructor(status: number, data: any) {
    super(data?.error || `Request failed (${status})`);
    this.status = status;
    this.data = data || {};
  }
  /** The server asked the user to confirm an override (resend with `force: true`). */
  get needsConfirmation() {
    return this.status === 409 && Boolean(this.data?.requires_confirmation);
  }
}

type Options = { method?: string; body?: unknown; form?: FormData; signal?: AbortSignal };

export async function api<T = any>(path: string, { method = 'GET', body, form, signal }: Options = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(API_BASE + path, { method, headers, body: payload, signal });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, { error: 'Cannot reach the server. Check your connection.' });
  }
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : null;
  if (res.status === 401 && token && !path.startsWith('/api/auth/login')) onUnauthorized?.();
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

export const assetUrl = (p?: string | null) => (p ? (/^https?:/.test(p) ? p : API_BASE + p) : null);

/** Download a file from an authenticated endpoint. */
export async function download(path: string, fallbackName = 'download') {
  const res = await fetch(API_BASE + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    throw new ApiError(res.status, data);
  }
  const disposition = res.headers.get('content-disposition') || '';
  const name = disposition.match(/filename="?([^"]+)"?/)?.[1] || fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const qs = (params: Record<string, unknown>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};
