import { requirePageUser } from "@/lib/server/auth";
import { NotificationsWorkspace } from "@/components/notifications-workspace";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  await requirePageUser();
  return <NotificationsWorkspace />;
}
