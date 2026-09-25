// src/app/api/autopilot/start/route.ts
import { startAutopilot } from "@/lib/autopilot/loop";
import { fail, ok } from "@/lib/http";

export async function POST() {
  try {
    startAutopilot();
    return ok({ status: "started" });
  } catch (err) {
    return fail(err);
  }
}