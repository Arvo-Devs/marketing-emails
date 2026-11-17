'use client';

// Where the routes are mounted, for every call the pages make. The default
// matches the server's; MarketingEmailsProvider (or each component's
// basePath prop) moves it.
import { createContext, use, type ReactNode } from 'react';

export const DEFAULT_BASE_PATH = '/api/marketing-emails';

const BasePathContext = createContext<string>(DEFAULT_BASE_PATH);

/** Put it once around the pages when the app mounts the routes somewhere else. */
export function MarketingEmailsProvider({ basePath, children }: { basePath?: string; children: ReactNode }) {
  const outer = use(BasePathContext);
  // No slash at the end, so the calls can add theirs.
  const value = basePath === undefined ? outer : basePath.replace(/\/+$/, '') || DEFAULT_BASE_PATH;
  return <BasePathContext value={value}>{children}</BasePathContext>;
}

export function usePaths(): Readonly<{ basePath: string }> {
  return { basePath: use(BasePathContext) };
}
