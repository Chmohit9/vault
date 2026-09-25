// src/app/api/repair/scrub/route.ts
import { scrubCluster } from "@/lib/repair/scrub";
import { fail, ok } from "@/lib/http";

export async function POST() {
  try {
    return ok({ ...(await scrubCluster()) });
  } catch (err) {
    return fail(err);
  }
}