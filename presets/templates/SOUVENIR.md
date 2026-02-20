# Session Souvenir

This file persists context and learnings across agent sessions. The agent reads this file
at the start of each session and updates it at the end. Think of it as the agent's
long-term memory notebook -- a "souvenir" it carries from one conversation to the next.

## Key Learnings

Important facts, patterns, or insights the agent has discovered that should inform
future interactions. Update this section as the agent encounters new information.

- _Example: The user prefers concise bullet-point answers over long paragraphs._
- _Example: The production database is PostgreSQL 15 running on AWS RDS._

## User Preferences

Communication style, formatting, and workflow preferences expressed by the user.
The agent should adapt its behavior based on these over time.

- **Tone**: _Example: Professional but approachable._
- **Format**: _Example: Prefers code blocks with line numbers._
- **Language**: _Example: English, with occasional Spanish greetings._
- **Detail level**: _Example: High — wants thorough explanations with examples._

## Important Decisions

Record significant decisions made during sessions so the agent maintains consistency.
Include the rationale when possible.

- _Example: [2025-01-15] Chose NestJS over Express for the backend rewrite — team wanted decorators and DI._
- _Example: [2025-01-20] Agreed to use snake_case for all API response fields._

## Pending Tasks

Tasks that were identified but not completed in a session. The agent should check this
list at the start of each session and offer to resume where it left off.

- [ ] _Example: Finish migrating the auth module to JWT (blocked on key rotation setup)._
- [ ] _Example: Write integration tests for the /api/checkout endpoint._
- [ ] _Example: Review and update the API documentation for v2 changes._
