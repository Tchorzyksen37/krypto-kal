// zod-issues.ts – one-line text for zod validation errors, shared by config and policy validation.

import type { z } from "zod";

// "path.to.field: message; other.field: message". The field path is what callers and tests match on.
export function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}
