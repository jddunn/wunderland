# Security policy

## Supported versions

Security fixes ship in a new release of the latest published version of `wunderland`. Older versions are not patched.

## Reporting a vulnerability

Report it privately through GitHub: open the [security advisory form](https://github.com/jddunn/wunderland/security/advisories/new), or email team@frame.dev. Do not open a public issue, pull request or chat message about a vulnerability.

## Response

A maintainer acknowledges a report within 5 business days and sends an assessment and a plan within 14 days.

## Disclosure

A fix ships before details are published, and the reporter is credited unless they decline. At 90 days from the report an advisory is published with the fix or, when no fix exists, with mitigations, unless the reporter and a maintainer agree a later date.

## Scope

In scope: defects in this repository's code, including how it stores and uses API keys and OAuth tokens, how the agent server and the channel adapters handle incoming messages, how it runs tools for an agent, and the security tiers and approval checks. Out of scope: a flaw in AgentOS itself or in an extension pack, which belongs in the [agentos](https://github.com/framerslab/agentos/security/policy) or [agentos-extensions](https://github.com/framerslab/agentos-extensions/security/policy) repository; a flaw that exists only in a third-party service; and a flaw that exists only in a deployment's own configuration. Model output, tool results, channel messages, retrieved documents and web content are untrusted input; the security tiers are described in the [README](https://github.com/jddunn/wunderland/blob/master/README.md#security-tiers).
