// The client entry of @arvo/marketing-emails. Mount them inside the app's
// own QueryClientProvider:
//
//   MarketingEmailsManager    Admin › Marketing emails' body
//   MarketingEmailsSetting    on the account settings page
//
// The calls go to /api/marketing-emails unless the basePath prop (or one
// MarketingEmailsProvider around them) says otherwise.

export { MarketingEmailsProvider } from './client/context';
export { MarketingEmailsManager, MarketingSkeleton } from './client/marketing';
export type { MarketingEmailsManagerProps } from './client/marketing';
export { MarketingEmailsSetting } from './client/setting';
export type { MarketingEmailsSettingProps } from './client/setting';
