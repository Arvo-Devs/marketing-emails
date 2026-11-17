'use client';

// "Change schedule": how often, the day and the time emails go out, and
// whether new What's New posts become a roundup email on their own.
import { useState } from 'react';
import type { MarketingSettings } from '../shared/api';
import { describeSchedule, formatClock, SEND_TIMES, WEEKDAY_NAMES, type Cadence } from '../shared/schedule';
import { Button, Checkbox, Dialog, DialogContent, Field, InlineError, Select, Spinner } from '../ui/ui-deps';
import { useSaveSettings } from './api';

const CADENCE_ITEMS: { value: Cadence; label: string }[] = [
  { value: 'weekly', label: 'Every week' },
  { value: 'every_2_weeks', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Every month (the first one)' },
];

/** "Pacific Time" style name of the zone, else the zone itself. */
export function zoneName(timeZone: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'long' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
    return part?.value.replace(/ (Standard|Daylight) /, ' ') ?? timeZone;
  } catch {
    return timeZone;
  }
}

export function ScheduleDialog({ settings, whatsNew, onClose }: { settings: MarketingSettings; whatsNew: boolean; onClose: () => void }) {
  const [cadence, setCadence] = useState<Cadence>(settings.cadence);
  const [weekday, setWeekday] = useState(String(settings.weekday));
  const [time, setTime] = useState(settings.time);
  const [roundups, setRoundups] = useState(settings.roundups);
  const save = useSaveSettings();
  const preview = describeSchedule({ cadence, weekday: Number(weekday), time, firstSendOn: null, timeZone: settings.timeZone });

  return (
    <Dialog.Root open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent
        size="md"
        title="Change schedule"
        description="One email goes out each time, the first one in the line."
        footer={
          <>
            <Dialog.Close render={<Button variant="ghost" />}>Cancel</Dialog.Close>
            <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate({ cadence, weekday: Number(weekday), time, roundups }, { onSuccess: onClose })}>
              {save.isPending ? <Spinner /> : null}
              Save schedule
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="How often">
            <Select value={cadence} onValueChange={setCadence} items={CADENCE_ITEMS} className="w-full" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Day">
              <Select value={weekday} onValueChange={setWeekday} items={WEEKDAY_NAMES.map((name, i) => ({ value: String(i), label: name }))} className="w-full" />
            </Field>
            <Field label="Time" hint={zoneName(settings.timeZone)}>
              <Select value={time} onValueChange={setTime} items={SEND_TIMES.map((t) => ({ value: t, label: formatClock(t) }))} className="w-full" />
            </Field>
          </div>
          <p className="rounded-lg bg-muted/60 px-3 py-2 text-[13px] text-foreground">{preview}</p>
          {whatsNew ? (
            <Checkbox checked={roundups} onCheckedChange={setRoundups} description="Every live post on What's New waits for the next roundup, which joins the line on its own.">
              Turn What&apos;s New posts into a roundup email
            </Checkbox>
          ) : null}
          {save.error ? <InlineError error={save.error} /> : null}
        </div>
      </DialogContent>
    </Dialog.Root>
  );
}
