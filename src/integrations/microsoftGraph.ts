import { mapMicrosoftEvent, type EventOwnerContext, type MicrosoftGraphEvent } from "@/domain/schedule";

const GRAPH_SELECT =
  "id,subject,start,end,location,isOnlineMeeting,onlineMeetingProvider,lastModifiedDateTime,sensitivity";

export async function fetchMicrosoftCalendarView(params: {
  accessToken: string;
  userPrincipalName: string;
  start: string;
  end: string;
  owner: EventOwnerContext;
}) {
  const url = new URL(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(
      params.userPrincipalName,
    )}/calendarView`,
  );
  url.searchParams.set("startDateTime", params.start);
  url.searchParams.set("endDateTime", params.end);
  url.searchParams.set("$select", GRAPH_SELECT);
  url.searchParams.set("$top", "100");

  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${params.accessToken}`,
      prefer: 'outlook.timezone="Tokyo Standard Time"',
    },
  });
  if (!response.ok) throw new Error(`Microsoft Graph fetch failed: ${response.status}`);

  const body = (await response.json()) as { value?: MicrosoftGraphEvent[] };
  return (body.value ?? []).map((event) => mapMicrosoftEvent(event, params.owner));
}
