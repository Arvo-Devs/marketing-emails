'use client';

// Every call the pages make, against the package's routes under the base
// path in effect (./context). Errors come back as { error: { message, hint },
// requestId } and are thrown as MarketingError, which ErrorState and
// InlineError show in plain words.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EmailInput, ImageAnswer, ImagesAnswer, ManageEmailsAnswer, MyEmailsAnswer, SettingsInput, TestAnswer } from '../shared/api';
import { errorFromBody, MarketingError } from '../ui/ui-deps';
import { usePaths } from './context';

/** Every query this package keeps is under this key, then the base path. */
export const QUERY_KEY = ['arvo-marketing-emails'] as const;

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, credentials: 'same-origin', headers: { accept: 'application/json', ...(init.headers ?? {}) } });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new MarketingError(0, { message: 'Could not reach the site. Check your connection and try again.' }, null);
  }
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw errorFromBody(response.status, body);
  return body as T;
}

function send<T>(url: string, body: unknown, method = 'POST'): Promise<T> {
  return call<T>(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

/** After any change: the page reads again. */
function useRefreshAll() {
  const { basePath } = usePaths();
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: [...QUERY_KEY, basePath] });
}

export function useUploadImage() {
  const { basePath } = usePaths();
  const client = useQueryClient();
  return useMutation<ImageAnswer, MarketingError, File>({
    mutationFn: (file) => call(`${basePath}/manage/images`, { method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream' } }),
    onSuccess: () => client.invalidateQueries({ queryKey: [...QUERY_KEY, basePath, 'manage', 'images'] }),
  });
}

/** The pictures uploaded so far, for the Pictures panel. */
export function useImages(enabled = true) {
  const { basePath } = usePaths();
  return useQuery<ImagesAnswer, MarketingError>({
    queryKey: [...QUERY_KEY, basePath, 'manage', 'images'],
    queryFn: ({ signal }) => call(`${basePath}/manage/images`, { signal }),
    enabled,
  });
}

export function useManageEmails() {
  const { basePath } = usePaths();
  return useQuery<ManageEmailsAnswer, MarketingError>({
    queryKey: [...QUERY_KEY, basePath, 'manage'],
    queryFn: ({ signal }) => call(`${basePath}/manage`, { signal }),
    // While an email is going out, its progress keeps moving.
    refetchInterval: (query) => (query.state.data?.sending ? 5000 : false),
  });
}

export function useSaveSettings() {
  const { basePath } = usePaths();
  const refresh = useRefreshAll();
  return useMutation<unknown, MarketingError, SettingsInput>({
    mutationFn: (input) => send(`${basePath}/manage/settings`, input),
    onSuccess: () => refresh(),
  });
}

export function useSaveEmail() {
  const { basePath } = usePaths();
  const refresh = useRefreshAll();
  return useMutation<{ id: string }, MarketingError, { id: string | null; input: EmailInput }>({
    mutationFn: ({ id, input }) => send(id ? `${basePath}/manage/emails/${id}` : `${basePath}/manage/emails`, input),
    onSuccess: () => refresh(),
  });
}

export function useEmailAction() {
  const { basePath } = usePaths();
  const refresh = useRefreshAll();
  return useMutation<void, MarketingError, { id: string; action: 'up' | 'down' | 'remove' | 'stop' }>({
    mutationFn: ({ id, action }) => {
      if (action === 'remove') return send(`${basePath}/manage/emails/${id}`, undefined, 'DELETE');
      if (action === 'stop') return send(`${basePath}/manage/emails/${id}/stop`, {});
      return send(`${basePath}/manage/emails/${id}/move`, { direction: action });
    },
    onSettled: () => refresh(),
  });
}

export function useSendTest() {
  const { basePath } = usePaths();
  return useMutation<TestAnswer, MarketingError, EmailInput>({
    mutationFn: (input) => send(`${basePath}/manage/test`, input),
  });
}

/** A sent email as it went out. */
export function useSentEmail(id: string | null) {
  const { basePath } = usePaths();
  return useQuery<{ subject: string; html: string }, MarketingError>({
    queryKey: [...QUERY_KEY, basePath, 'manage', 'emails', id, 'view'],
    queryFn: ({ signal }) => call(`${basePath}/manage/emails/${id}/view`, { signal }),
    enabled: Boolean(id),
    staleTime: Infinity,
  });
}

export function useMyEmails() {
  const { basePath } = usePaths();
  return useQuery<MyEmailsAnswer, MarketingError>({
    queryKey: [...QUERY_KEY, basePath, 'me', 'emails'],
    queryFn: ({ signal }) => call(`${basePath}/me/emails`, { signal }),
  });
}

export function useSetMyEmails() {
  const { basePath } = usePaths();
  const client = useQueryClient();
  return useMutation<MyEmailsAnswer, MarketingError, boolean>({
    mutationFn: (subscribed) => send(`${basePath}/me/emails`, { subscribed }),
    onSuccess: (answer) => client.setQueryData([...QUERY_KEY, basePath, 'me', 'emails'], answer),
  });
}
