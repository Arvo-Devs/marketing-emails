'use client';

// The email editor: a pop-up in the middle of the screen with the form on
// the left and, on the right, the inbox line and the email exactly as it
// goes out, footer and all (the same drawing the sender uses). A written
// email is the HTML the prompt made, with its subject and preview text. A
// roundup only takes its words: its posts come from What's New. "Send me a
// test" sends what is in the form to the person editing, without saving it.
import { useMemo, useState } from 'react';
import type { Audience, EmailBrand, EmailInput, PostView, PromptFacts, QueuedEmail } from '../shared/api';
import { campaignName, previewText, renderEmail, roundupHeadline, roundupSubject, type EmailContent } from '../shared/email';
import { LIMITS } from '../shared/limits';
import { emailPrompt } from '../shared/prompts';
import { Button, Checkbox, Dialog, DialogContent, Field, InlineError, Input, Spinner, Textarea } from '../ui/ui-deps';
import { useSaveEmail, useSendTest } from './api';
import { EmailFrame, InboxLine } from './email-preview';
import { HtmlField } from './html-field';
import { PicturesButton } from './pictures';
import { PromptButton } from './prompt-dialog';

function Counter({ value, max }: { value: string; max: number }) {
  return <span className={value.length > max ? 'font-medium text-danger-strong' : undefined}>{value.length}/{max}</span>;
}

export type EmailDraft = Readonly<{
  kind: 'feature' | 'roundup';
  subject: string;
  preheader: string;
  /** A roundup's own words. */
  headline: string;
  body: string;
  /** A written email's HTML. */
  html: string;
  audience: readonly string[];
}>;

export function draftOf(email: QueuedEmail): EmailDraft {
  return { kind: email.kind, subject: email.subject, preheader: email.preheader, headline: email.headline, body: email.body, html: email.html, audience: email.audience };
}

export const EMPTY_DRAFT: EmailDraft = { kind: 'feature', subject: '', preheader: '', headline: '', body: '', html: '', audience: [] };

export function EmailEditor({
  id,
  initial,
  brand,
  facts,
  audiences,
  roundupPosts,
  testTo,
  canSend,
  onClose,
}: {
  /** The waiting email being changed, or null for a new one. */
  id: string | null;
  initial: EmailDraft;
  brand: EmailBrand;
  facts: PromptFacts;
  audiences: readonly Audience[];
  /** The posts the roundup carries now. */
  roundupPosts: readonly PostView[];
  testTo: string | null;
  /** False until the setup is complete: tests can't go out. */
  canSend: boolean;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<EmailDraft>(initial);
  const save = useSaveEmail();
  const test = useSendTest();
  const set = <K extends keyof EmailDraft>(key: K, value: EmailDraft[K]) => setDraft((now) => ({ ...now, [key]: value }));
  const roundup = draft.kind === 'roundup';
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const prompt = useMemo(() => emailPrompt(facts), [facts]);

  const input: EmailInput = roundup
    ? { kind: 'roundup', subject: draft.subject, preheader: draft.preheader, headline: draft.headline, body: draft.body }
    : { kind: 'feature', subject: draft.subject, preheader: draft.preheader, html: draft.html, audience: draft.audience };

  const content: EmailContent = roundup
    ? { kind: 'roundup', subject: draft.subject, preheader: draft.preheader, headline: draft.headline, body: draft.body, posts: roundupPosts }
    : { kind: 'feature', subject: draft.subject, preheader: draft.preheader, html: draft.html };
  const rendered = useMemo(
    () => (roundup || draft.html.trim() ? renderEmail(content, brand, { unsubscribeUrl: '#', campaign: campaignName(content, new Date()) }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(content), brand],
  );
  const shownSubject = draft.subject.trim() || (roundup ? roundupSubject(brand, roundupPosts) : '');

  const error = save.error;
  const errorFor = (name: string) => (error?.param === name ? error.message : undefined);

  return (
    <Dialog.Root open disablePointerDismissal={dirty} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent
        size="xl"
        className="sm:max-w-[1180px]"
        title={roundup ? "What's New roundup" : id ? 'Edit email' : 'New email'}
        description={
          roundup
            ? "Made from What's New posts on its own. Write a subject or a line at the top if you like."
            : 'Make it with the prompt and paste it here. It joins the end of the line and goes out in its turn. The unsubscribe link and the postal address are added for you.'
        }
        footerStart={
          <Button onClick={() => test.mutate(input)} disabled={test.isPending || !testTo || !canSend}>
            {test.isPending ? <Spinner /> : null}
            {test.isSuccess ? `Sent to ${test.data.to}` : 'Send me a test'}
          </Button>
        }
        footer={
          <>
            <Dialog.Close render={<Button variant="ghost" />}>Cancel</Dialog.Close>
            <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate({ id, input }, { onSuccess: onClose })}>
              {save.isPending ? <Spinner /> : null}
              {id ? 'Save' : 'Add to the line'}
            </Button>
          </>
        }
      >
        <div className="grid gap-6 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            {!roundup ? (
              <div className="flex flex-wrap gap-2">
                <PromptButton
                  prompt={prompt}
                  title="The prompt for a marketing email"
                  steps="Run it in the product's repo with the best AI model at the time. Add what the email is about at the end. It gives you the subject, the preview text and the HTML: paste them here."
                />
                <PicturesButton />
              </div>
            ) : null}
            <Field
              label="Subject"
              optional={roundup}
              error={errorFor('subject')}
              hint={
                <>
                  <Counter value={draft.subject} max={LIMITS.subject} />
                  {draft.subject.length > LIMITS.subjectShort ? ' · Phones show about 45 characters.' : ''}
                </>
              }
            >
              <Input value={draft.subject} onChange={(e) => set('subject', e.target.value)} placeholder={roundup ? roundupSubject(brand, roundupPosts) : 'Stop typing the same answer twice'} />
            </Field>
            <Field label="Preview text" optional error={errorFor('preheader')} hint="The grey line after the subject in the inbox. Finish the subject's thought.">
              <Input value={draft.preheader} onChange={(e) => set('preheader', e.target.value)} placeholder={roundup ? 'Three things got easier this month.' : 'Saved replies are here. Set one up in a minute.'} />
            </Field>
            {roundup ? (
              <>
                <Field label="Headline" optional error={errorFor('headline')}>
                  <Input value={draft.headline} onChange={(e) => set('headline', e.target.value)} placeholder={roundupHeadline(roundupPosts)} />
                </Field>
                <Field label="A line at the top" optional error={errorFor('body')} hint="A blank line starts a new paragraph; **two stars** make words bold.">
                  <Textarea value={draft.body} onChange={(e) => set('body', e.target.value)} rows={3} placeholder="A few things got easier this month." />
                </Field>
                <div className="rounded-xl border border-border p-4">
                  <p className="text-[13px] font-medium text-foreground">It carries {roundupPosts.length === 1 ? 'this post' : `these ${roundupPosts.length} posts`}</p>
                  {roundupPosts.length ? (
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-muted-foreground">
                      {roundupPosts.map((post) => (
                        <li key={post.id}>{post.title}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-[13px] text-muted-foreground">No posts are waiting yet.</p>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground/80">Each shows its title, its one line and its picture for the email. Posts published before it goes out join it.</p>
                </div>
              </>
            ) : (
              <>
                <HtmlField value={draft.html} onChange={(html) => set('html', html)} error={errorFor('html')} hint="Pictures go in by link from Pictures." />
                {audiences.length ? (
                  <fieldset className="flex flex-col gap-2">
                    <legend className="mb-1 text-[13px] font-medium text-foreground">Who gets it</legend>
                    {audiences.map((a) => (
                      <Checkbox
                        key={a.key}
                        checked={draft.audience.includes(a.key)}
                        onCheckedChange={(checked) => set('audience', checked ? [...draft.audience, a.key] : draft.audience.filter((k) => k !== a.key))}
                      >
                        {a.label}
                      </Checkbox>
                    ))}
                    <p className="text-xs text-muted-foreground/80">{draft.audience.length ? 'Only the groups ticked get it.' : 'None ticked: everyone who allows marketing emails gets it.'}</p>
                  </fieldset>
                ) : null}
              </>
            )}
            {error && (!error.param || error.param === 'audience' || error.param === 'kind') ? <InlineError error={error} /> : null}
            {test.isError ? <InlineError error={test.error} /> : null}
            {!testTo ? <p className="text-xs text-muted-foreground">Your account has no email address, so tests can&apos;t reach you.</p> : null}
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">In the inbox</p>
            <InboxLine from={brand.name} subject={shownSubject} preheader={rendered ? previewText(content) : draft.preheader} />
            <p className="mt-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Opened</p>
            {rendered ? (
              <EmailFrame html={rendered.html} title="Email preview" />
            ) : (
              <div className="rounded-xl border border-dashed border-border px-6 py-20 text-center text-sm text-muted-foreground">Paste the HTML and the email shows here, footer and all, the way it arrives.</div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog.Root>
  );
}
