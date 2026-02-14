# Role-Based Access Control (RBAC)

This document describes the roles, permissions, and enforcement points used across the Frame.dev reference apps and AgentOS integrations.

## Roles

- admin: Full administrative control within an organization. Can invite/remove members, change roles, manage seats, and publish marketplace listings on behalf of the organization.
- builder: Create and manage content (e.g., agents) within the organization. Cannot modify other members or publish publicly on behalf of the org unless explicitly elevated.
- viewer: Read-only access to organization resources.

## Enforcement Overview

- Organization membership and roles are persisted in organizations, organization_members, and organization_invites tables.
- Role and membership checks are enforced in the organization service and marketplace routes.
- Frontend UI gates team/organization features based on both platform capability and authenticated user context.

## Key Enforcement Points (Backend)

- backend/src/features/organization/organization.service.ts
  - Admin-only actions: invite and revoke invites, update organization details and member roles, remove other members.
  - Safety checks: preserve at least one active admin; enforce seat limits on role/seat changes and invite acceptance.
- backend/src/features/marketplace/marketplace.routes.ts
  - Listing creation/update: if a listing is owned by an organization, require membership; `admin` is required for publishing (`status=published`) or setting `visibility=public`.
- backend/middleware/auth.ts and backend/middleware/optionalAuth.ts
  - Strongly authenticated routes use authMiddleware. Public and semi-public routes use optionalAuthMiddleware.

## Capability Gating (Platform)

Some team and marketplace functions are cloud-only and require a multi-tenant database (PostgreSQL). The active storage adapter and its capabilities are exposed via:

- GET /api/system/storage-status

The frontend consumes this in a Pinia store (frontend/src/store/platform.store.ts) to conditionally show or hide organization/team management sections.

## Frontend Considerations

- Team Management UI is only shown when both of the following are true:
  - The user is authenticated, and
  - The platform store indicates organizations are supported (PostgreSQL).
- Marketplace publishing affordances should be shown only when the current user is an org admin for the listing’s organization.

## Auditing and Telemetry

- AgentOS emits structured telemetry events (`WORKFLOW_UPDATE`, `AGENCY_UPDATE`). The reference frontend captures these for export.
- Server-side telemetry (if enabled) should record user and organization context where appropriate for audits, while respecting privacy and retention policies.

## Extensibility

- Additional roles can be introduced by expanding the OrganizationRole union in backend/src/features/organization/organization.repository.ts and updating service logic accordingly.
- For granular permissions, consider adding a policy layer (e.g., canPublish, canManageMarketplace, canManageAgents) that maps to roles, then batch-enforce in route handlers.

