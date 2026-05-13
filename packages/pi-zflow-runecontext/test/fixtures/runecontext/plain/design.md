# Design: Authentication middleware

## Architecture

Use a middleware-based approach with JWT tokens.

## Components

- AuthMiddleware: Validates JWT on each request
- TokenService: Issues and refreshes tokens
- UserStore: Validates credentials

## Data flow

1. Client sends POST /auth/login with credentials
2. TokenService validates and returns JWT
3. Subsequent requests include JWT in Authorization header
4. AuthMiddleware validates token before passing to handler
