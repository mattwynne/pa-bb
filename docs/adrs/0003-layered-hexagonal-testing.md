# 3. Adopt a hexagonal (ports-and-adapters) architecture for all plugins

Date: 2026-11-01

Status: accepted.

Applies to all current and future plugins. Examples illustrate the decision;
they do not limit plugins' domains, capabilities or technologies.

## Context

Coupling business logic to external systems makes plugins harder to change and
test. Too many tests start SDK hosts, databases and processes to check behaviour that
does not need them. This slows feedback and duplicates setup. We need fast tests
of business behaviour alongside separate tests of real system connections.

## Decision

**Adopt a hexagonal (ports-and-adapters) architecture for all plugins.**

All business logic and domain modelling belong inside the inner hexagon,
covered by fast tests. Adapters stay as thin as possible.

The inner hexagon is the application core: its models and all behaviour built on
them, including calculations, transformations, policies, use cases, verification
and recovery decisions. Document elements and editing operations, calendar
recurrence and file-sync conflict decisions are examples—not an exhaustive list.

The core defines interfaces—ports—for its external dependencies. Adapters
implement them, translating formats, performing I/O and reporting results or
failures. Business decisions belong in the core, not adapters. Dependencies point
inward: the core does not import adapters or their SDK and database types. Add
ports at real boundaries, not around every function; no new framework is required.

### Testing

Test all domain models and business logic with fast tests, independently of
external systems. Substitute external dependencies, not the behaviour being
tested. Gherkin can call application services directly.

Adapter tests can also be fast: run the real adapter while stubbing HTTP calls or
CLI execution, for example. Check the requests or commands it produces and how
it handles responses and failures. These tests verify the adapter's behaviour,
not the external system itself.

Use separate integration tests for behaviour that needs real systems, such as
persistence, process execution and BB wiring. Retain coverage of every public
entry point and important ownership, permission and approval boundaries without
repeating every core example.

Use independently derived expectations and both successful and failing examples.
Test substitutes and real adapters against shared contracts. Verify guarantees
that substitutes cannot establish with real systems; SDK-harness tests still use
a real database. Record what each test actually exercised: a passing core test is
not proof of native invocation, durable storage or a live provider change.

Run affected fast and adapter tests while editing; run full relevant checks at
feature review, substantial shared-interface changes and delivery. Independent
reviewers probe changed behaviour rather than mechanically repeat every author
command. When impact is unclear, test more broadly.

### Adoption

New plugins follow this architecture; existing plugins adopt it incrementally
through reviewed migration plans. Before retiring tests, show
that replacements preserve required coverage and catch relevant faults; measure
the improvement. This changes [plan 025's real-adapter requirement](../plans/025-google-docs-semantic-api/semantic-api-plan.md#harness-and-discovery),
but existing test and review requirements remain until a migration is accepted.

Feature scope, approval and permission checks, uncertain-write protections, old
evidence and required rendered/runtime reviews remain unchanged. This decision
authorizes no live actions. The [delivery workflow](../plans/021-git-first-pa-updates.md)
and [observability standards](../o11y-standards.md) still apply.

## Consequences

- Faster feedback, clearer failure locations and less repeated setup and review.
- Core models, format translations and faithful test substitutes need maintenance.
- Migration takes work; coverage must remain complete across test layers.
- Real integration tests remain necessary and relatively expensive.
