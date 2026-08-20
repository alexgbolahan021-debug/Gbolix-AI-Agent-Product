# Gbolix AI Agent Engine

Gbolix AI Agent is the standalone runtime behind configurable Gbolix digital workers. It provides tenant-scoped agents, business knowledge, conversations, bounded tool calling, website deployment tokens, API keys, usage events, and an admin observability surface.

The engine is intentionally separate from the Gbolix site. The site owns Clerk identity, workspaces, payments, subscriptions, and the authoritative credit ledger. The engine executes agents and reports usage back to the site.

## V1 capabilities

The first version supports agent creation and configuration, text knowledge sources, an agent playground/API message endpoint, safe `capture_contact` and `create_lead` tools, human handoff detection, website widget deployment, API-key generation, usage summaries, admin aggregates, local credit mode, and a Postgres-backed production mode.

## Local setup

```bash
cp .env.example .env
npm install
npm run typecheck
npm run dev
```

Without `DATABASE_URL` or `OPENAI_API_KEY`, the engine uses in-memory storage and a deterministic response adapter for local smoke tests. This mode is not suitable for production because data is lost when the process restarts.

With a Postgres database, run `npm run migrate` before `npm run start`. The service binds to `0.0.0.0` and uses `PORT` when supplied by the host.

## Authentication

Authenticated management requests use `Authorization: Bearer <signed-token>`. In production, configure either `AGENT_JWT_SECRET` for a shared HS256 token or `CLERK_JWKS_URL` to verify Clerk JWTs. The token should expose `sub`, `workspace_id` or `org_id`, and an optional `role` claim.

Website deployments use an opaque deployment token returned once when a deployment is created. API keys are returned only once and are stored as SHA-256 hashes. Public credentials must identify a single agent and never expose provider keys or workspace-wide secrets.

## Example API flow

Create an agent:

```bash
curl -X POST "$ENGINE_URL/v1/agents" \
  -H "Authorization: Bearer $IDENTITY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Favyy Assistant","instructions":"Help customers with products, delivery, and returns.","status":"active","enabledTools":["capture_contact"]}'
```

Add business knowledge:

```bash
curl -X POST "$ENGINE_URL/v1/agents/agent_123/knowledge" \
  -H "Authorization: Bearer $IDENTITY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Delivery policy","content":"Delivery to Lagos starts from ₦3,500 and takes 1–3 business days."}'
```

Run a message:

```bash
curl -X POST "$ENGINE_URL/v1/agents/agent_123/messages" \
  -H "Authorization: Bearer $IDENTITY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"How much is delivery to Lekki?","channel":"playground"}'
```

## Website deployment

`POST /v1/agents/{agentId}/deployments` returns a one-time token and an installation snippet similar to:

```html
<script src="https://agent.example.com/widget.js"
        data-gbolix-agent="agent_123"
        data-gbolix-token="deployment_token"
        async></script>
```

The widget calls `POST /v1/agents/{agentId}/messages`. The widget is only a presentation layer; agent instructions, knowledge, memory, tools, provider credentials, metering, and permissions remain in the engine.

## Credits and the Gbolix site

For production, set `CREDIT_MODE=platform`. Before a billable response, the engine calls the site’s internal credit-authorization endpoint. After a successful response, it sends an idempotent usage event. If the model or a tool fails, the engine releases the reservation and writes a zero-credit failed event.

The site must provide the internal endpoints described in `ARCHITECTURE.md`:

- `POST /api/internal/credit-authorizations`
- `POST /api/internal/credit-authorizations/{authorizationKey}/release`
- `POST /api/internal/usage-events`

The engine never mutates the site’s balance directly.

## Render deployment

Create a Render web service from this repository and use the included `render.yaml`. The blueprint provisions the Node service and a Postgres database. Set the provider, identity, credit-platform, CORS, and public URL environment variables in Render’s secret settings. The service health check is `/healthz`.

The site’s frontend needs `VITE_GBOLIX_AGENT_URL=https://<your-engine-domain>` and must pass an authenticated Clerk/site token to management routes. Customer pages must never embed the engine’s internal service token.

## Further design

The complete shared contract is in [`ARCHITECTURE.md`](./ARCHITECTURE.md). The product scope follows the user-provided blueprint: build the smallest useful core now, while keeping the widget/API/runtime boundaries ready for later channels and automations.
