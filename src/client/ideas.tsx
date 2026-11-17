'use client';

// The Ideas tab: what makes a good marketing email, and examples to start
// from. The examples are for a made-up product called "Your app", so none
// carries a real brand. "Use this" opens a new email with the example drawn
// in the app's own name and color, to rewrite (by hand or with the prompt).
import { useState } from 'react';
import type { EmailBrand } from '../shared/api';
import { renderEmail } from '../shared/email';
import { EMAIL_EXAMPLES, EMAIL_TIPS, EXAMPLE_BRAND, exampleContent, type EmailExample } from '../shared/examples';
import { Button, Card, Dialog, DialogContent } from '../ui/ui-deps';
import { EMPTY_DRAFT, type EmailDraft } from './email-editor';
import { EmailFrame, InboxLine } from './email-preview';

/** An example as a new email for this app. */
export function draftFromExample(example: EmailExample, brand: Pick<EmailBrand, 'name' | 'logoUrl' | 'color'>): EmailDraft {
  const content = exampleContent(example, brand);
  if (content.kind === 'roundup') return { ...EMPTY_DRAFT, kind: 'roundup' };
  return { ...EMPTY_DRAFT, subject: content.subject, preheader: content.preheader, html: content.html };
}

function preview(example: EmailExample) {
  return renderEmail(exampleContent(example, EXAMPLE_BRAND), EXAMPLE_BRAND, { unsubscribeUrl: '#', campaign: 'example' });
}

export function Ideas({ brand, whatsNew, onUse }: { brand: EmailBrand; whatsNew: boolean; onUse: (draft: EmailDraft) => void }) {
  const [open, setOpen] = useState<EmailExample | null>(null);
  return (
    <div className="flex flex-col gap-6">
      <Card className="p-5">
        <h2 className="text-sm font-semibold text-foreground">What makes a good one</h2>
        <ol className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {EMAIL_TIPS.map((tip, i) => (
            <li key={tip.title} className="flex gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/12 text-xs font-semibold text-primary">{i + 1}</span>
              <span className="min-w-0 text-[13px] leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">{tip.title}.</span> {tip.detail}
              </span>
            </li>
          ))}
        </ol>
      </Card>

      <div>
        <h2 className="text-sm font-semibold text-foreground">Examples to start from</h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">Written for a made-up product called &quot;Your app&quot;. Use one as a start, then make every word true for this app.</p>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          {EMAIL_EXAMPLES.map((example) => {
            const drawn = preview(example);
            return (
              <Card key={example.key} className="flex flex-col p-4">
                <p className="text-sm font-semibold text-foreground">{example.title}</p>
                <p className="mt-1 flex-1 text-[13px] leading-relaxed text-muted-foreground">{example.why}</p>
                <div className="mt-3">
                  <InboxLine from={EXAMPLE_BRAND.name} subject={drawn.subject} preheader={example.feature?.preheader ?? 'Export any list to a spreadsheet · Dark mode · …'} />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setOpen(example)}>
                    See it
                  </Button>
                  {example.feature ? (
                    <Button size="sm" variant="primary" onClick={() => onUse(draftFromExample(example, brand))}>
                      Use this
                    </Button>
                  ) : (
                    <span className="self-center text-xs text-muted-foreground">{whatsNew ? "Made for you from What's New posts." : "Comes with What's New, which this app doesn't have."}</span>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      </div>

      {open ? (
        <Dialog.Root open onOpenChange={(next) => (!next ? setOpen(null) : undefined)}>
          <DialogContent
            size="lg"
            title={open.title}
            description={open.why}
            footer={
              open.feature ? (
                <Button
                  variant="primary"
                  onClick={() => {
                    const example = open;
                    setOpen(null);
                    onUse(draftFromExample(example, brand));
                  }}
                >
                  Use this
                </Button>
              ) : (
                <Dialog.Close render={<Button variant="primary" />}>Got it</Dialog.Close>
              )
            }
          >
            <EmailFrame html={preview(open).html} title={`${open.title} example`} height={520} />
          </DialogContent>
        </Dialog.Root>
      ) : null}
    </div>
  );
}
