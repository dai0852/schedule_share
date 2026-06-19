import { mapGoogleEvent, type EventOwnerContext, type GoogleCalendarEvent } from "@/domain/schedule";

const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

export function buildGoogleOAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_CALENDAR_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", params.state);
  return url.toString();
}

export async function fetchGoogleEvents(params: {
  accessToken: string;
  calendarId: string;
  timeMin: string;
  timeMax: string;
  syncToken?: string;
  owner: EventOwnerContext;
}) {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      params.calendarId,
    )}/events`,
  );
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("timeMin", params.timeMin);
  url.searchParams.set("timeMax", params.timeMax);
  if (params.syncToken) url.searchParams.set("syncToken", params.syncToken);

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${params.accessToken}` },
  });
  if (!response.ok) throw new Error(`Google Calendar fetch failed: ${response.status}`);

  const body = (await response.json()) as { items?: GoogleCalendarEvent[]; nextSyncToken?: string };
  return {
    events: (body.items ?? []).map((event) => mapGoogleEvent(event, params.owner)),
    nextSyncToken: body.nextSyncToken,
  };
}
