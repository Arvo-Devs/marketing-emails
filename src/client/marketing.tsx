'use client';

// Admin › Marketing emails: what goes out and when. At the top, whether
// sending is on, the next email and how many people it reaches, the schedule,
// and New email. Then the email going out now (with Stop), and three tabs:
// Coming up (the line, each email on its slot), Sent (what each reached) and
// Ideas (how to write a good one, with examples).
import { ArrowDown, ArrowUp, CalendarClock, Mail, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { ManageEmailsAnswer, QueuedEmail } from '../shared/api';
import { formatSlot } from '../shared/schedule';
import {
  Button,
  Card,
  cn,
  ConfirmDialog,
  Dialog,
  DialogContent,
  EmptyState,
  ErrorState,
  formatNumber,
  InlineError,
  Skeleton,
  StatusDot,
  Switch,
  Tab,
  Table,
  TabList,
  Tabs,
  TBody,
  Td,
  Th,
  THead,
  Tip,
  Tr,
} from '../ui/ui-deps';
import { useEmailAction, useManageEmails, useSaveSettings, useSentEmail } from './api';
import { MarketingEmailsProvider } from './context';
import { draftOf, EmailEditor, EMPTY_DRAFT, type EmailDraft } from './email-editor';
import { EmailFrame } from './email-preview';
import { Ideas } from './ideas';
import { ScheduleDialog, zoneName } from './schedule-dialog';

export type MarketingEmailsManagerProps = Readonly<{ basePath?: string }>;

export function MarketingEmailsManager({ basePath }: MarketingEmailsManagerProps) {
  return (
    <MarketingEmailsProvider basePath={basePath}>
      <Marketing />
    </MarketingEmailsProvider>
  );
}

function emailTitle(email: Pick<QueuedEmail, 'kind' | 'subject' | 'posts'>, brandName: string): string {
  if (email.kind === 'roundup') return email.subject || (email.posts.length === 1 && email.posts[0] ? `New in ${brandName}: ${email.posts[0].title}` : `What's new in ${brandName}`);
  return email.subject || 'No subject yet';
}

function KindChip({ kind }: { kind: 'roundup' | 'feature' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
        kind === 'roundup' ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border bg-muted text-muted-foreground',
      )}
    >
      {kind === 'roundup' ? "What's New roundup" : 'Written email'}
    </span>
  );
}

export function MarketingSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading marketing emails">
      <Skeleton className="h-28 w-full rounded-xl" />
      <Skeleton className="h-10 w-80" />
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

type Editing = { id: string | null; draft: EmailDraft } | null;

function Marketing() {
  const query = useManageEmails();
  const [editing, setEditing] = useState<Editing>(null);
  const [schedule, setSchedule] = useState(false);
  const [confirmOn, setConfirmOn] = useState(false);
  const [tab, setTab] = useState<string>('coming');
  const settingsSave = useSaveSettings();

  if (query.isPending) return <MarketingSkeleton />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isRefetching} />;
  const data = query.data;
  const ready = data.missing.length === 0;
  const tz = data.settings.timeZone;
  const next = data.queue[0] ?? null;
  const people = data.audience.count;

  return (
    <div className="flex flex-col gap-5">
      <Card className="flex flex-wrap items-start justify-between gap-4 p-5">
        <div className="min-w-0 flex-1 basis-72">
          <div className="flex items-center gap-2">
            <StatusDot tone={!ready ? 'warn' : data.settings.sending ? 'ok' : 'neutral'} pulse={ready && data.settings.sending} />
            <p className="text-sm font-semibold text-foreground">{!ready ? 'Not set up yet' : data.settings.sending ? 'Sending is on' : 'Sending is off'}</p>
          </div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
            {data.settings.sending && next?.slotAt ? (
              <>
                Next: <span className="font-medium text-foreground">{emailTitle(next, data.brand.name)}</span> on {formatSlot(next.slotAt, tz)}
                {people !== null ? <>, to {formatNumber(people)} {people === 1 ? 'person' : 'people'}</> : null}.
              </>
            ) : data.settings.sending ? (
              data.whatsNew ? "Nothing is waiting. Write an email, or publish a post on What's New and a roundup joins the line." : 'Nothing is waiting. Write an email and it takes the next date.'
            ) : (
              <>Nothing goes out until you turn sending on.{people !== null ? <> {formatNumber(people)} {people === 1 ? 'person allows' : 'people allow'} marketing emails.</> : null}</>
            )}
          </p>
          <button
            type="button"
            onClick={() => setSchedule(true)}
            className="mt-2 inline-flex cursor-pointer items-center gap-1.5 text-[13px] font-medium text-primary outline-none hover:underline focus-visible:underline"
          >
            <CalendarClock className="size-3.5" aria-hidden />
            {data.scheduleText}, {zoneName(tz)}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[13px] font-medium text-foreground">
            <Switch
              label="Sending"
              checked={data.settings.sending}
              disabled={!ready || settingsSave.isPending}
              onCheckedChange={(on) => (on ? setConfirmOn(true) : settingsSave.mutate({ sending: false }))}
            />
            Sending
          </label>
          <Button variant="primary" onClick={() => setEditing({ id: null, draft: EMPTY_DRAFT })} disabled={!ready && data.missing[0]?.includes('not set up')}>
            <Plus aria-hidden />
            New email
          </Button>
        </div>
        {settingsSave.error ? <InlineError error={settingsSave.error} className="w-full" /> : null}
      </Card>

      {!ready ? (
        <div role="alert" className="rounded-xl border border-warning-border bg-warning-soft p-4 text-[13px] text-warning-strong">
          <p className="font-semibold">Before anything can go out, the app&apos;s setup needs:</p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
            {data.missing.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="mt-1.5 text-warning-strong/80">A developer adds these in the app&apos;s server file for What&apos;s New.</p>
        </div>
      ) : null}

      {data.sending ? <GoingOut email={data.sending} data={data} /> : null}

      <Tabs.Root value={tab} onValueChange={(value: unknown) => setTab(String(value))}>
        <TabList>
          <Tab value="coming">Coming up {data.queue.length ? `(${data.queue.length})` : ''}</Tab>
          <Tab value="sent">Sent {data.sent.length ? `(${data.sent.length})` : ''}</Tab>
          <Tab value="ideas">Ideas</Tab>
        </TabList>
      </Tabs.Root>

      {tab === 'coming' ? <ComingUp data={data} onEdit={(email) => setEditing({ id: email.id, draft: draftOf(email) })} onNew={() => setEditing({ id: null, draft: EMPTY_DRAFT })} /> : null}
      {tab === 'sent' ? <Sent data={data} /> : null}
      {tab === 'ideas' ? <Ideas brand={data.brand} whatsNew={data.whatsNew} onUse={(draft) => setEditing({ id: null, draft })} /> : null}

      {editing ? (
        <EmailEditor
          key={editing.id ?? 'new'}
          id={editing.id}
          initial={editing.draft}
          brand={data.brand}
          facts={data.facts}
          audiences={data.audiences}
          roundupPosts={data.roundupPosts}
          testTo={data.testTo}
          canSend={ready}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {schedule ? <ScheduleDialog settings={data.settings} whatsNew={data.whatsNew} onClose={() => setSchedule(false)} /> : null}
      <ConfirmDialog
        open={confirmOn}
        onOpenChange={setConfirmOn}
        title="Start sending marketing emails?"
        consequence={
          next?.slotAt
            ? `"${emailTitle(next, data.brand.name)}" goes out on ${formatSlot(next.slotAt, tz)}${people !== null ? ` to ${formatNumber(people)} ${people === 1 ? 'person' : 'people'}` : ''}. Then one email each time: ${data.scheduleText.toLowerCase()}. Turn it off any time.`
            : `Emails go out ${data.scheduleText.toLowerCase()}, one each time, to everyone who allows them. Nothing is waiting yet. Turn it off any time.`
        }
        confirmLabel="Start sending"
        pendingLabel="Starting…"
        pending={settingsSave.isPending}
        onConfirm={() => settingsSave.mutate({ sending: true }, { onSuccess: () => setConfirmOn(false) })}
      />
    </div>
  );
}

function GoingOut({ email, data }: { email: QueuedEmail; data: ManageEmailsAnswer }) {
  const action = useEmailAction();
  const [confirm, setConfirm] = useState(false);
  const done = email.progress?.sent ?? 0;
  const failed = email.progress?.failed ?? 0;
  const total = data.audience.count;
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Going out now</p>
          <p className="mt-1 text-sm font-semibold [overflow-wrap:anywhere] text-foreground">{emailTitle(email, data.brand.name)}</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {formatNumber(done)} sent{total ? ` of about ${formatNumber(total)}` : ''}
            {failed ? `, ${formatNumber(failed)} failed` : ''}
          </p>
        </div>
        <Button variant="danger" size="sm" onClick={() => setConfirm(true)}>
          Stop sending
        </Button>
      </div>
      {total ? (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${Math.min(100, Math.round(((done + failed) / total) * 100))}%` }} />
        </div>
      ) : null}
      {email.lastError ? (
        <div role="alert" className="mt-3 rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-[13px] text-warning-strong">
          <p className="font-medium">Paused: {email.lastError}</p>
          {email.retryAfter ? <p className="mt-0.5 text-warning-strong/80">It tries again at {formatSlot(email.retryAfter, data.settings.timeZone)}. Nobody is skipped while it waits.</p> : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        danger
        title="Stop this email?"
        consequence="Nobody it hasn't reached yet will get it. The people it already reached keep it. This can't be undone."
        confirmLabel="Stop sending"
        pendingLabel="Stopping…"
        pending={action.isPending}
        onConfirm={() => action.mutate({ id: email.id, action: 'stop' }, { onSuccess: () => setConfirm(false) })}
      >
        {action.error ? <InlineError error={action.error} /> : null}
      </ConfirmDialog>
    </Card>
  );
}

function ComingUp({ data, onEdit, onNew }: { data: ManageEmailsAnswer; onEdit: (email: QueuedEmail) => void; onNew: () => void }) {
  const action = useEmailAction();
  const [removing, setRemoving] = useState<QueuedEmail | null>(null);
  const tz = data.settings.timeZone;
  if (!data.queue.length) {
    return (
      <EmptyState
        icon={Mail}
        title="Nothing waiting to go out"
        action={
          <Button variant="primary" onClick={onNew}>
            <Plus aria-hidden />
            New email
          </Button>
        }
      >
        {data.whatsNew
          ? "Write an email about a feature, or publish a post on What's New: a roundup of the new posts joins the line on its own. Ideas has examples to start from."
          : 'Write an email about a feature, made with the prompt. Ideas has examples to start from.'}
      </EmptyState>
    );
  }
  return (
    <>
      {action.error ? <InlineError error={action.error} /> : null}
      <Table label="Emails waiting to go out">
        <THead>
          <Th>Goes out</Th>
          <Th>Email</Th>
          {data.audiences.length ? <Th>Who gets it</Th> : null}
          <Th align="right">
            <span className="sr-only">Actions</span>
          </Th>
        </THead>
        <TBody>
          {data.queue.map((email, i) => (
            <Tr key={email.id}>
              <Td className="text-[13px] whitespace-nowrap">
                {email.slotAt ? <span className={data.settings.sending ? 'text-foreground' : 'text-muted-foreground'}>{formatSlot(email.slotAt, tz)}</span> : <span className="text-muted-foreground">Later</span>}
                {!data.settings.sending ? <p className="text-xs text-muted-foreground/80">If sending is on</p> : null}
              </Td>
              <Td>
                <button type="button" onClick={() => onEdit(email)} className="flex min-w-0 cursor-pointer flex-col items-start gap-1 text-left outline-none focus-visible:underline">
                  <span className="font-medium [overflow-wrap:anywhere] text-foreground">{emailTitle(email, data.brand.name)}</span>
                  <span className="flex flex-wrap items-center gap-2">
                    <KindChip kind={email.kind} />
                    {email.kind === 'roundup' ? (
                      <span className="text-xs text-muted-foreground">
                        {email.posts.length} {email.posts.length === 1 ? 'post' : 'posts'} so far
                      </span>
                    ) : null}
                  </span>
                </button>
              </Td>
              {data.audiences.length ? (
                <Td className="text-[13px] text-muted-foreground">
                  {email.kind === 'roundup'
                    ? 'Each person gets their posts'
                    : email.audience.length
                      ? email.audience.map((key) => data.audiences.find((a) => a.key === key)?.label ?? key).join(', ')
                      : 'Everyone'}
                </Td>
              ) : null}
              <Td align="right">
                <div className="flex items-center justify-end gap-0.5">
                  <Tip content="Send it sooner">
                    <Button size="icon-sm" variant="ghost" aria-label="Move up" disabled={i === 0 || action.isPending} onClick={() => action.mutate({ id: email.id, action: 'up' })}>
                      <ArrowUp aria-hidden />
                    </Button>
                  </Tip>
                  <Tip content="Send it later">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Move down"
                      disabled={i === data.queue.length - 1 || action.isPending}
                      onClick={() => action.mutate({ id: email.id, action: 'down' })}
                    >
                      <ArrowDown aria-hidden />
                    </Button>
                  </Tip>
                  <Tip content="Edit">
                    <Button size="icon-sm" variant="ghost" aria-label="Edit" onClick={() => onEdit(email)}>
                      <Pencil aria-hidden />
                    </Button>
                  </Tip>
                  {email.kind === 'feature' ? (
                    <Tip content="Remove from the line">
                      <Button size="icon-sm" variant="ghost" aria-label="Remove" onClick={() => setRemoving(email)}>
                        <Trash2 aria-hidden />
                      </Button>
                    </Tip>
                  ) : null}
                </div>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
      <p className="text-xs text-muted-foreground">One email goes out each time, the first in the line. Use the arrows to change the order.</p>
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => (!open ? setRemoving(null) : undefined)}
        danger
        title="Remove this email?"
        consequence={removing ? `"${emailTitle(removing, data.brand.name)}" leaves the line and won't go out. This can't be undone.` : ''}
        confirmLabel="Remove"
        pendingLabel="Removing…"
        pending={action.isPending}
        onConfirm={() => removing && action.mutate({ id: removing.id, action: 'remove' }, { onSuccess: () => setRemoving(null) })}
      />
    </>
  );
}

function Sent({ data }: { data: ManageEmailsAnswer }) {
  const [viewing, setViewing] = useState<string | null>(null);
  const view = useSentEmail(viewing);
  if (!data.sent.length) {
    return (
      <EmptyState icon={Mail} title="Nothing has gone out yet">
        Each email shows here once it goes out, with how many people it reached.
      </EmptyState>
    );
  }
  return (
    <>
      <Table label="Emails that went out">
        <THead>
          <Th>Went out</Th>
          <Th>Email</Th>
          <Th align="right">Reached</Th>
          <Th align="right">Failed</Th>
          <Th align="right">Unsubscribed</Th>
        </THead>
        <TBody>
          {data.sent.map((email) => (
            <Tr key={email.id} interactive>
              <Td className="text-[13px] whitespace-nowrap text-muted-foreground">{email.slotAt ? formatSlot(email.slotAt, data.settings.timeZone) : ''}</Td>
              <Td>
                <button type="button" onClick={() => setViewing(email.id)} className="flex min-w-0 cursor-pointer flex-col items-start gap-1 text-left outline-none focus-visible:underline">
                  <span className="font-medium [overflow-wrap:anywhere] text-foreground">{email.subject || (email.kind === 'roundup' ? "What's New roundup" : 'No subject')}</span>
                  <span className="flex items-center gap-2">
                    <KindChip kind={email.kind} />
                    {email.status === 'stopped' ? <span className="text-xs font-medium text-danger-strong">Stopped part way</span> : null}
                  </span>
                </button>
              </Td>
              <Td align="right" className="tabular-nums">{formatNumber(email.sent)}</Td>
              <Td align="right" className={cn('tabular-nums', email.failed ? 'text-danger-strong' : 'text-muted-foreground')}>{formatNumber(email.failed)}</Td>
              <Td align="right" className="text-muted-foreground tabular-nums">{formatNumber(email.unsubscribed)}</Td>
            </Tr>
          ))}
        </TBody>
      </Table>
      {viewing ? (
        <Dialog.Root open onOpenChange={(open) => (!open ? setViewing(null) : undefined)}>
          <DialogContent size="lg" title={view.data?.subject ?? 'Email'} description="As it went out. Links and the unsubscribe link are off in this copy.">
            {view.isPending ? <Skeleton className="h-[520px] w-full rounded-xl" /> : view.isError ? <ErrorState compact error={view.error} /> : <EmailFrame html={view.data.html} title="Sent email" height={520} />}
          </DialogContent>
        </Dialog.Root>
      ) : null}
    </>
  );
}
