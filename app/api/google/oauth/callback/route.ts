import { after } from "next/server";

import { syncAllCalendars } from "@/server/calendarSync";
import { completeGoogleOAuth, getGoogleOAuthConfig } from "@/server/googleConnection";
import { createGoogleOAuthCallbackHandler } from "@/server/googleOAuthCallback";

export const GET = createGoogleOAuthCallbackHandler({
  completeOAuth: completeGoogleOAuth,
  getConfig: getGoogleOAuthConfig,
  syncCalendars: syncAllCalendars,
  scheduleAfter: (callback) => after(callback),
});
