// The prompt behind "Copy the prompt" on Admin › Marketing emails. Whoever
// writes an email runs it in the product's repo with the best AI model at
// the time, reads what it made, and pastes the HTML into the page. The page
// fills in the app's name and site.
import type { PromptFacts } from './api';

/** The prompt for a written marketing email. Ends with the line where the person names the feature or tip. */
export function emailPrompt(facts: PromptFacts): string {
  const site = facts.siteUrl || 'the live site';
  return `Make a marketing email for ${facts.appName}.

You're in ${facts.appName}'s repo. It goes to ${facts.appName}'s customers who allow marketing emails. Most of them read it on a phone, between other things.

1. One idea. The feature or tip I name at the end, and nothing else. Lead with the problem it solves for them, then what it does about it. 50 to 125 words. One button, named for what it does ("Set up saved replies", never "Click here"). Only claims you can back up: no made-up numbers, quotes or "trusted by thousands". No em dashes.

2. The subject and the preview text. A subject under 45 characters that says what they get, and a preview text (the grey line after the subject in the inbox) that finishes its thought. Give me both at the top of your reply, not in the HTML.

3. Email HTML, not web HTML. Gmail, Outlook and Apple Mail throw away most styling, so:
- One centered column, 600px wide at most, built from tables, with every style written inline on its element.
- No scripts, forms, video, SVG, web fonts or drawings made of HTML and CSS. Fonts: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif.
- Pictures are real images, only from links I give you from the Pictures panel. If the email needs a picture of a screen, draw it in HTML the way the real page looks (made-up names and numbers), take a screenshot of it at 1200px wide, and give me the PNG to add under Pictures. I'll send you back its link. Every picture has alt text.
- The button is a link inside a table cell with a background color.
- Links to ${facts.appName}'s pages are full addresses on ${site}.

4. Leave these out: the page adds them to every email. No unsubscribe link, no postal address, no "you're getting this because" line, no company footer.

5. Hand it over. Save it to my Downloads folder as email-<short-name>.html (don't overwrite a file that's already there) and copy the HTML to my clipboard. Then tell me in plain lines: the subject, the preview text, where the file is, and any picture I need to add. Don't send it anywhere yourself.

The email is about: `;
}
