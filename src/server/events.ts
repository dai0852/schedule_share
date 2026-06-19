import { demoEvents } from "@/data/demo";
import { filterEvents, sortEvents, type EventFilters, type NormalizedEvent } from "@/domain/schedule";
import { getAdminFirestore, hasFirebaseAdminConfig } from "@/lib/firebase/admin";

export async function listEvents(filters: EventFilters): Promise<NormalizedEvent[]> {
  const useFirestore = process.env.USE_FIRESTORE === "true" && hasFirebaseAdminConfig();
  const events = useFirestore ? await listFirestoreEvents() : demoEvents;
  return sortEvents(filterEvents(events, filters));
}

async function listFirestoreEvents(): Promise<NormalizedEvent[]> {
  const snapshot = await getAdminFirestore().collection("events").get();
  return snapshot.docs.map((doc) => doc.data() as NormalizedEvent);
}
