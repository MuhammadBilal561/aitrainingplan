# aitrainingplan.app — Adaptive Training Demo

Interactive training-plan demo built for the We The Flywheel Agentic Engineer assessment.

## What I built

The main feature is a **"Missed a Workout?"** interaction that demonstrates how a training plan can adapt when a workout is missed.

The demo includes:

- A 7-day running plan
- Easy, key, and rest sessions
- Missed-workout adaptation
- Rescheduling of key sessions to a later rest day when possible
- Fallback behavior when no suitable rest day exists
- Next-week carry-over when a session cannot be rescheduled
- Missed easy-session handling
- Missed rest-day handling
- Clear explanations of how the plan changed

## Adaptation logic

The adaptation engine is intentionally deterministic.

It does not pretend to be an AI training model. Instead, it applies explicit rules to demonstrate the product idea of an adaptive training plan.

Examples:

- A missed key session moves to the next suitable rest day.
- If there is no suitable rest day, it falls back to an easier available day.
- If no later slot exists, the session is carried into the following week.
- A missed easy session becomes rest.
- A missed rest day does not change the plan.

## UI

The original 7-day layout was too compressed at narrower widths, so the interface was refined during development.

The final UI includes:

- Responsive weekly plan layout
- Equal-height workout cards
- Clear session-type styling
- Visible missed/rescheduled states
- Interval strips for structured sessions
- Adaptive performance-curve visualization
- Weekly load coverage indicator
- Responsive behavior across desktop and mobile sizes
- Reduced visual crowding and shadow overlap

## Testing

The plan logic is covered by unit tests for:

- Weekly plan generation
- Weekly statistics
- Key-session rescheduling
- Fallback behavior
- Next-week carry-over
- Easy-session handling
- Rest-day handling
- Invalid day handling
- Deterministic adaptation

The browser/E2E tests cover:

- App startup
- Seven-day rendering
- Initial plan state
- Workout interactions
- Adapted-plan behavior
- Performance visualization
- Interval rendering
- Weekly load indicator
- Responsive layout behavior

Current test run:

```text
12 unit tests passing
39 E2E checks passing
