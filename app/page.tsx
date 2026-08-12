import { ScheduleApp } from "@/components/ScheduleApp";
import { isDemoAuthAllowed } from "@/server/auth";

export const dynamic = "force-dynamic";

export default function Home() {
  return <ScheduleApp allowDemoAuth={isDemoAuthAllowed()} />;
}
