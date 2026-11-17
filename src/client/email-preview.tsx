'use client';

// An email as it arrives, drawn from the same HTML that goes out, in a
// sealed frame (no scripts, no forms, no links that leave). Phone and
// Computer switch the width, because most people read it on a phone.
import { useState } from 'react';
import { Segmented } from '../ui/ui-deps';

export function InboxLine({ from, subject, preheader }: { from: string; subject: string; preheader: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/15 text-xs font-semibold text-primary">{from.slice(0, 1).toUpperCase()}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold text-foreground">{from}</p>
        <p className="truncate text-[13px] text-foreground">
          {subject || <span className="text-muted-foreground">No subject yet</span>}
          {preheader ? <span className="text-muted-foreground"> · {preheader}</span> : null}
        </p>
      </div>
    </div>
  );
}

export function EmailFrame({ html, title, height = 560 }: { html: string; title: string; height?: number }) {
  const [width, setWidth] = useState<'phone' | 'computer'>('phone');
  // Links open nowhere: the frame may not open tabs, and a link must never load a page inside the preview.
  const sealed = html.replace('<head>', '<head><base target="_blank">');
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Segmented
        label="Preview width"
        value={width}
        onValueChange={setWidth}
        items={[
          { value: 'phone', label: 'Phone' },
          { value: 'computer', label: 'Computer' },
        ]}
        className="w-fit"
      />
      <div className="overflow-hidden rounded-xl border border-border bg-[#f4f4f5]">
        <iframe
          title={title}
          srcDoc={sealed}
          sandbox=""
          className="mx-auto block border-0 bg-[#f4f4f5] transition-[width] duration-200"
          style={{ width: width === 'phone' ? 'min(390px, 100%)' : '100%', height }}
        />
      </div>
    </div>
  );
}
