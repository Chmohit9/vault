// src/app/api/autopilot/stop/route.ts
import { stopAutopilot } from "@/lib/autopilot/loop";
import { fail, ok } from "@/lib/http";

export async function POST() {
  try {
    stopAutopilot();
    return ok({ status: "stopped" });
  } catch (err) {
    return fail(err);
  }
}