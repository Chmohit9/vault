// src/app/api/autopilot/status/route.ts
import { autopilotStatus } from "@/lib/autopilot/loop";
import { fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok({ ...autopilotStatus() });
  } catch (err) {
    return fail(err);
  }
}