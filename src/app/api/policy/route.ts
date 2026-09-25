import { DEFAULT_POLICY, failureDomainForNode, isStrongQuorum, requiredWriteAcks, validatePolicy } from "@/config/policy";
import { fail, ok } from "@/lib/http";

export async function GET() {
  try {
    const validationError = validatePolicy(DEFAULT_POLICY);
    if (validationError) throw new Error(validationError);
    return ok({
      policy: DEFAULT_POLICY,
      requiredWriteAcks: requiredWriteAcks(DEFAULT_POLICY),
      strongQuorum: isStrongQuorum(DEFAULT_POLICY),
      failureDomains: {
        "node-1": failureDomainForNode("node-1"),
        "node-2": failureDomainForNode("node-2"),
        "node-3": failureDomainForNode("node-3"),
        "node-4": failureDomainForNode("node-4"),
        "node-5": failureDomainForNode("node-5"),
        "node-6": failureDomainForNode("node-6"),
      },
    });
  } catch (err) {
    return fail(err);
  }
}
