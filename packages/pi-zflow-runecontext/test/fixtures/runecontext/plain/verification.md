# Verification

## Test cases

- Login with valid credentials returns token
- Login with invalid credentials returns 401
- Token refresh returns new token
- Expired token returns 401
- Missing Authorization header returns 401

## Security review

- Tokens must not contain sensitive data
- Token expiration must be enforced server-side
- Rate limiting on login endpoint
