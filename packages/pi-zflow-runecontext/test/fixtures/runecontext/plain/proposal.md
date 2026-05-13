# Proposal: Add user authentication

This change adds user authentication to the API service.

## Motivation

Users need to be able to authenticate before accessing protected resources.

## Scope

- Backend: Add JWT-based authentication middleware
- No frontend changes required

## Success criteria

- All existing tests continue to pass
- New authentication tests cover login, token refresh, and logout flows
