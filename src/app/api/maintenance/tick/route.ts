// src/app/api/maintenance/tick/route.ts
// Runs one heartbeat + failure-detection cycle on demand (the background loop does this automatically).
import { runFailureDetectionCycle } from "@/lib/nodes/failureDetector";
import { fail, ok } from "@/lib/http";

export async function POST() {
  try {
    return ok(await runFailureDetectionCycle());
  } catch (err) {
    return fail(err);
  }
}