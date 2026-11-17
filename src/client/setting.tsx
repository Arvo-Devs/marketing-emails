'use client';

// The switch for the app's account settings page: the signed-in person's own
// yes or no to marketing emails. It is the same list an email's Unsubscribe
// link changes, so the two always agree. It draws nothing in an app without
// marketing emails.
import { Mail } from 'lucide-react';
import { InlineError, Skeleton, Switch } from '../ui/ui-deps';
import { useMyEmails, useSetMyEmails } from './api';
import { MarketingEmailsProvider } from './context';

export type MarketingEmailsSettingProps = Readonly<{
  basePath?: string;
  /** "Product news and tips" by default. */
  label?: string;
  /** One line under it. */
  description?: string;
}>;

export function MarketingEmailsSetting({ basePath, label, description }: MarketingEmailsSettingProps) {
  return (
    <MarketingEmailsProvider basePath={basePath}>
      <Setting label={label} description={description} />
    </MarketingEmailsProvider>
  );
}

function Setting({ label = 'Product news and tips', description = 'New features and ideas for using them, by email. A few a month at most. Emails about your account always come.' }: { label?: string; description?: string }) {
  const mine = useMyEmails();
  const change = useSetMyEmails();
  if (mine.isPending) return <Skeleton className="h-14 w-full rounded-xl" />;
  if (mine.isError || !mine.data.available) return mine.isError ? <InlineError error={mine.error} when="load" /> : null;
  const on = change.isPending && change.variables !== undefined ? change.variables : mine.data.subscribed;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 gap-3">
          <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{label}</p>
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
          </div>
        </div>
        <Switch label={label} checked={on} disabled={change.isPending} onCheckedChange={(next) => change.mutate(next)} />
      </div>
      {change.error ? <InlineError error={change.error} /> : null}
    </div>
  );
}
