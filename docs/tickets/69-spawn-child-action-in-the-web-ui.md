# 69 - Spawn-child action in the web UI

**Status:** Open, ready-for-agent.
**GitHub:** Pending - will mirror the created issue.

The last missing trigger surface from the design tree: a human starts a
Manual child from the web UI, no CLI needed. A live Parent run (liveness
from ticket 65) gains a "spawn child" action in its siblings view (ticket
66): it takes an agent and a prompt, POSTs to the existing BFF endpoint,
and shows the accepted request id and status - the same shape
`e spawn --parent` prints. Rejections (not live, depth, empty prompt)
surface as the endpoint's 400 with the message. The action is only offered
for runs whose liveness is true, so the UI never offers what the host
would refuse.

**Blocked by:** 65 (broker liveness in the index) and 66 (siblings view).

- [ ] A live Parent run offers the spawn-child action; a run without a live broker does not.
- [ ] POSTing with agent + prompt shows the accepted id and status from the response on success.
- [ ] Endpoint rejections show the BFF's error message and the request is not offered again until the parent is live.
- [ ] The UI surfaces loading, success and failure states for the action.
