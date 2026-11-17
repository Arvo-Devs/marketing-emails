// The Ideas tab on the Marketing emails page: what makes a good marketing
// email, and examples to start from. The examples are for a made-up product
// called "Your app", so they never carry a real brand, a real number or a real
// customer. "Use this" starts a new email from one, drawn with the app's own
// name and color, for the app to rewrite.
import type { EmailBrand } from './api';
import { featureHtml, type EmailContent, type RoundupPost } from './email';

export const EXAMPLE_BRAND: EmailBrand = {
  name: 'Your app',
  logoUrl: null,
  color: '#4f46e5',
  siteUrl: 'https://example.com',
  postalAddress: '123 Example Street, Anytown, CA 90000',
  pageUrl: 'https://example.com/whats-new',
};

export type EmailTip = Readonly<{ title: string; detail: string }>;

export const EMAIL_TIPS: readonly EmailTip[] = [
  { title: 'One idea per email', detail: "Two things to say is two emails, or a post each in the What's New roundup." },
  { title: 'Lead with the problem, then the fix', detail: '"Tired of typing the same answer? Save it once." beats "Introducing saved replies".' },
  { title: 'A subject that says what they get', detail: 'Under 45 characters, so phones show all of it. No ALL CAPS, no "!!!", no fake "Re:".' },
  { title: 'Preview text that finishes the thought', detail: 'It is the grey line after the subject in the inbox. Left empty, it shows the first words of the email.' },
  { title: 'Short', detail: '50 to 125 words. Most people read it on a phone, between other things.' },
  { title: 'One button, named for what it does', detail: '"Set up saved replies", never "Click here" or "Learn more".' },
  { title: 'Show it working, as a real picture', detail: 'Email apps throw away drawings made in HTML. Draw it, take a screenshot, add it under Pictures, and use its link.' },
  { title: 'Only what you can back up', detail: 'No made-up numbers, quotes or "trusted by thousands". It goes out under the brand\'s name.' },
  { title: 'Read the test on your phone', detail: 'Send me a test, open it on your phone, tap the button. Then let it take its turn.' },
];

export const POST_TIPS: readonly EmailTip[] = [
  { title: 'Make it with the prompt', detail: 'Copy the prompt, run it in the product\'s repo with the best AI model at the time, and paste what it makes.' },
  { title: 'Say what people can do now', detail: '"Export any list to a spreadsheet", not "Export improvements".' },
  { title: 'Draw the change working', detail: 'Drawn in HTML from the real page, with made-up names and numbers. Never a real customer\'s data.' },
  { title: 'A button that goes straight there', detail: 'Name it for the action: "Open exports".' },
];

export type ExampleFeature = Readonly<{
  subject: string;
  preheader: string;
  headline: string;
  body: string;
  imageUrl: string | null;
  buttonLabel: string | null;
  buttonUrl: string | null;
}>;

const SAMPLE_POSTS: readonly RoundupPost[] = [
  { id: 'example-1', title: 'Export any list to a spreadsheet', summary: 'Every list now has an Export button, with the columns you see.', coverUrl: null },
  { id: 'example-2', title: 'Dark mode', summary: 'Easier on the eyes at night. Turn it on in Settings, or let it follow your device.', coverUrl: null },
  { id: 'example-3', title: 'Search finds people as well as pages', summary: 'Type a name and jump straight to that person.', coverUrl: null },
];

export type EmailExample = Readonly<{ key: string; title: string; why: string; feature: ExampleFeature | null }>;

export const EMAIL_EXAMPLES: readonly EmailExample[] = [
  {
    key: 'problem-first',
    title: 'Lead with the problem',
    why: 'Names something people already find annoying, then shows the feature that ends it. The strongest kind of feature email.',
    feature: {
      subject: 'Stop typing the same answer twice',
      preheader: 'Saved replies are here. Set one up in a minute.',
      headline: 'Answer your most common questions in one click',
      body:
        'If you type the same few answers every day, you can now save them once and send them with one click.\n\n' +
        '- Save any message as a reply\n- Pick it from the list when you answer\n- Change it once, and every reply after uses the new words\n\n' +
        'Most people set up their first three in a few minutes.',
      imageUrl: null,
      buttonLabel: 'Set up saved replies',
      buttonUrl: '/settings/replies',
    },
  },
  {
    key: 'roundup',
    title: "The What's New roundup",
    why: "Made for you from What's New posts: each post's title, its one line and its picture, with a link to read it. Add a line at the top if you like.",
    feature: null,
  },
  {
    key: 'hidden-feature',
    title: 'The feature people miss',
    why: 'Not everything has to be new. A useful feature most people never found is news to them.',
    feature: {
      subject: 'The shortcut most people never find',
      preheader: 'Press / anywhere to search.',
      headline: 'Press / to jump anywhere',
      body:
        "You don't have to click through menus to find something. Press the **/** key on any page, start typing, and pick where you want to go.\n\n" +
        'It finds pages, people and settings, and it remembers what you open most.',
      imageUrl: null,
      buttonLabel: 'Try it now',
      buttonUrl: '/',
    },
  },
  {
    key: 'you-asked',
    title: 'You asked, we built it',
    why: 'Shows people they are heard. Only send it for something people really asked for.',
    feature: {
      subject: 'You asked for it: scheduled reports',
      preheader: 'Your numbers in your inbox every Monday.',
      headline: 'Your weekly numbers, in your inbox',
      body:
        'Many of you asked for a way to stop opening the dashboard every Monday just to copy the same numbers. Now they can come to you.\n\n' +
        'Pick the numbers and the day, and we email them to you and anyone on your team. Stop it any time.',
      imageUrl: null,
      buttonLabel: 'Schedule a report',
      buttonUrl: '/reports',
    },
  },
];

/** An example as an email, drawn for a brand: "Your app" on the Ideas tab, the app's own when it is used. */
export function exampleContent(example: EmailExample, brand: Pick<EmailBrand, 'name' | 'logoUrl' | 'color'>): EmailContent {
  if (!example.feature) return { kind: 'roundup', subject: '', preheader: '', headline: '', body: 'A few things got easier this month.', posts: SAMPLE_POSTS };
  return { kind: 'feature', subject: example.feature.subject, preheader: example.feature.preheader, html: featureHtml(example.feature, brand) };
}
