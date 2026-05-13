# Proposal: Add rate limiting

Implement rate limiting on API endpoints to prevent abuse.

## Motivation

The API has been receiving increasing traffic and we need to protect against DoS.

## Scope

- Global rate limit: 100 req/min per IP
- Auth endpoint: 10 req/min per IP
- Configuration via environment variables

## Success criteria

- Rate limits are enforced
- Rate limit headers are returned
- Configuration is documented
