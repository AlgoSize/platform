// POST /api/fix — generate a concrete remediation for ONE finding.
//
// Thin HTTP shell over analyzers/fixgen.js; auth and rate limiting are the
// router's job (requireAuth + analyzeRateLimit — see index.js for why quota
// is deliberately not applied here).

import { validateFixInput, generateFix } from "../analyzers/fixgen.js";
import { captureException } from "../observability.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export async function generateFixHandler(request, env, ctx) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json", message: "request body must be valid JSON" }, 400); }

  const v = validateFixInput(body);
  if (!v.ok) return json({ error: v.error, message: v.message }, 400);

  let result;
  try {
    result = await generateFix(v.value, env);
  } catch (err) {
    await captureException(env, ctx, err, {
      request,
      userId: request.user && request.user.userId,
      tags: { source: "analyzer", analyzer: "fix", kind: v.value.kind },
    });
    return json({ error: "fix_generation_failed", message: "could not generate a fix" }, 500);
  }

  if (!result.ok) {
    return json({ error: result.error, message: result.message }, result.status);
  }
  return json({ kind: v.value.kind, fix: result.fix }, 200);
}
