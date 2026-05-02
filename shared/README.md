# shared/

Cross-cutting types and constants used by both `site/` (browser JS) and
`worker/` (Cloudflare Worker). Kept dependency-free so it can be imported
from either side without a build step.

Examples of what lives here:

- API request/response shapes (as JSDoc typedefs or plain JS objects).
- Endpoint path constants.
- Severity / complexity enums shared by the analyzer endpoints.
