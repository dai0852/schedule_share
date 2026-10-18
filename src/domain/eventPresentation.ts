const SERVICE_ONLY_LOCATIONS = new Set([
  "microsoftteams会議",
  "microsoftteamsmeeting",
  "teamsmeeting",
  "teams会議",
  "microsoftteams",
  "teams",
  "googlemeet",
  "googlemeet会議",
  "googlemeetmeeting",
  "googlecalendar",
  "googleカレンダー",
  "microsoftoutlook",
  "outlook",
  "google",
  "microsoft",
]);

/** Hide provider-generated place placeholders only in compact calendar cards. */
export function getCompactEventLocation(location: string): string {
  const normalized = location.normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase("en");
  if (!normalized || SERVICE_ONLY_LOCATIONS.has(normalized)) return "";
  return location;
}
