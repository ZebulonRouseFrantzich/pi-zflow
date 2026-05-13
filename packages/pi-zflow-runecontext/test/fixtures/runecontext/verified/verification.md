# Verification

## Test cases

- Requests under limit succeed (200)
- Requests over limit return 429
- Rate limit headers are present (X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset)
- Different routes have different limits
- Configuration values are validated
