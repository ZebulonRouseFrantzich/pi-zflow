# Design: Rate limiting middleware

## Architecture

Use a token bucket algorithm implemented as Express middleware.

## Components

- RateLimitMiddleware: Applies rate limits per route
- TokenBucket: Token bucket implementation
- RedisStore: Distributed rate limit state (optional)

## Data flow

1. Request arrives at middleware
2. Token bucket is checked for the client IP
3. If tokens available, request proceeds and token consumed
4. If no tokens, 429 Too Many Requests returned
