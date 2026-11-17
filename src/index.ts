// @arvo/marketing-emails on the server. createMarketingEmails(config) reads
// the app's config once and gives back what the app wires up: the route
// handlers under basePath, sendDue for the app's worker to call every minute
// (startSending only for an app with no worker yet), and forgetAccount for
// the app's delete-account code. Keep one per process (README.md, "One
// server file").
//
// Server only: it uses Node's crypto. The pages are in ./client.
import { normalizeConfig, type MarketingEmailsConfig, type MarketingUser } from './config';
import { createRouteHandlers, type MarketingRouteHandlers } from './server/routes';
import { createSender, type SendDueResult, type Sleeper } from './server/sender';

export type MarketingEmails = Readonly<{
  /** GET, POST and DELETE for one catch-all route file at basePath. */
  routeHandlers: MarketingRouteHandlers;
  /**
   * One pass: sends whatever is due now. The standard install calls it from
   * the app's pg-boss worker every minute (README, "Sending on its own").
   * A pass stops after about 50 seconds (budgetMs) and the next one carries
   * on. Nothing goes out unless the server runs in production (NODE_ENV) or
   * sendOutsideProduction is set. Never throws.
   */
  sendDue: (options?: Readonly<{ budgetMs?: number }>) => Promise<SendDueResult>;
  /**
   * Only for an app with no worker yet, and only where the CTO agrees: a
   * pass every minute inside this server, from instrumentation.ts, until the
   * returned function stops it.
   */
  startSending: (options?: Readonly<{ everyMs?: number }>) => () => void;
  /**
   * Removes everything kept for one account: its unsubscribe and the record
   * of the emails it got. Call it from the app's delete-account code. True
   * when it went through; never throws (a failure is logged and answers
   * false, so the caller can try again later).
   */
  forgetAccount: (userId: string) => Promise<boolean>;
}>;

/** Never throws, whatever the config: what is missing is logged and shown on the page. */
export function createMarketingEmails<User extends MarketingUser = MarketingUser>(
  input: MarketingEmailsConfig<User>,
  internal: Readonly<{ sleep?: Sleeper }> = {},
): MarketingEmails {
  const config = normalizeConfig(input);
  const sender = createSender(config, internal.sleep);
  return {
    routeHandlers: createRouteHandlers(config, sender),
    sendDue: (options) => sender.sendDue({ budgetMs: options?.budgetMs }),
    startSending: (options) => sender.startSending(options),
    forgetAccount: async (userId) => {
      try {
        if (typeof userId !== 'string' || !userId) return true;
        const sql = await config.db();
        if (!sql) return false;
        await sql.begin(async (tx) => {
          await tx`delete from marketing_unsubscribes where user_id = ${userId}`;
          await tx`delete from marketing_deliveries where user_id = ${userId}`;
        });
        return true;
      } catch (error) {
        config.log("[Marketing emails] an account's rows were not removed", error);
        return false;
      }
    },
  };
}

export type { MarketingEmailsConfig, MarketingLog, MarketingRecipient, MarketingSql, MarketingUser, OutgoingEmail } from './config';
export type { Audience } from './shared/api';
export type { SendDueResult } from './server/sender';
export { renderEmail } from './shared/email';
