# Changelog

This file lists what changed for people using AI Workflow, newest first.
Entries are written in the pull request that ships the change and collected
automatically from `changelog/unreleased/` once a day; see `changelog/README.md`.

## 2026-09-18

- A note about one repository now speaks about that one repository, and after "you decide" a repository nobody has enabled is no longer described as something the run may still take: you are told who can enable it instead.
- When your answer to a repository question leaves out every repository the run could use, the run stops and tells you which ones your answer left out and how to bring one back, rather than asking you about those same repositories in other words.
- When a run stops, the whole reason arrives: the ticket comment, the run's result and the dashboard carry the sentence entire, including the repository it names and the way forward it offers.
- A repository question closes where it was asked. Cancelling a run, or moving its ticket out of the AI column while the question waits, posts that the question is closed and takes back the "needs clarification" label, so the ticket reads true.
- A repository named in a ticket that a run cannot use is named back to you with the reason it cannot: it is not enabled on the Repositories page, this workflow's pin does not cover it, or the provider offers nothing to check out. Each repository gets one such line, on the agent's prompt, the finished run's comment and the halt reason alike.
- When a repository was excluded on a piece of work and the ticket names it anyway, the run says which repository, who excluded it and on what day before it asks its question, and tells that person alone how to put it back.
- Your answer to a repository question is read once, when it arrives, and both the record and the run act on that one reading. "No. None of these.", "none", "none of the above", "neither", "Yes, please" and "żadne z nich" are understood now. So are "ok" and "sounds good" as the answer to a question about one repository, and "skip it" too when you answer on the dashboard or through an MCP client. On a ticket, a bare refusal such as "skip it" or "no" records nothing, because nothing ties a ticket comment to the question it answers, and the note posted there says what to write instead. A "yes" about a single repository no longer means one thing to the record and another to the run.
- When we cannot tell what an answer decided, nothing is recorded and the run is not resumed. You get a note saying what we read and asking for a yes or for the repository names, in the place you answered, and the question stays open so your next reply is read against it. A ticket you moved into the AI column with that answer goes back to the backlog column, so the board shows it waiting on you rather than on the AI; reply and move it to AI again, as you did the first time.
- When your answer names a repository the question did not list, it is taken as your choice when this deployment holds it, beside the one the question did list, and the run works on both. It is taken as well when the same reply turns the listed one down: "no, but take github:acme/web as well" leaves out the one you were asked about and takes the one you named, on a ticket too. A repository the Repositories page has not enabled is recorded as your choice too, and you are told it cannot be used until somebody enables it there. A name that matches no repository here records nothing, and you are told so, with what to check: that it is written as a full path, and that a repository this deployment does not have yet has to be added on the repositories screen first.
- "whatever you think is best", "you decide" or "rób jak uważasz" is an answer now. The run picks from the repositories the question listed, in that order, up to three, records them as its own choice made because you asked, and carries on. You are told which ones it took, which it left open, that this run or a later one may still take those if the work needs them, and how to change the choice in this work's repository list. A reply that also rules one out, like "you decide, but not the fixture one", is still read as unclear and asked again.
- A repository answer written as a Jira comment is read as the words in the comment, without the author name the ticket shows beside it, so the note we post back is about your reply and never about your name. An answer typed on the dashboard or sent through an MCP client is read exactly as you typed it, colons included.
- A failure reason too long for the space it is shown in is shortened between sentences where it can be, and between words otherwise, so every word you read is whole.
- Every ticket, pull request and webhook now keeps a record of the repositories its work uses: which ones were chosen, which were left out and why, and who decided. The MCP tools `work_scope.get` and `work_scope.edit` read it and change it, and the agent starting the next run reads the same record.
- A repository question a person has already answered is not put to them again on a later run, and putting an excluded repository back into the record is enough for the next run to use it.
- Saying no to a repository question leaves the record holding that decision: every repository the question named and the answer did not take is kept out of this work from then on, which is what the question itself promises. Writing "do not touch github:acme/api" on a ticket keeps that repository out of the work rather than naming it.
- Every answer to a repository question is answered back in the channel it came from. A person who answers on the ticket, in the dashboard or through MCP reads what the answer recorded, or why it recorded nothing, and the routes named are only the ones that work for that question.
- Text taken from a ticket, such as a title with curly braces or a GitHub Actions snippet in its description, reaches Slack messages, ticket and pull request comments, and the agent's instructions exactly as it was written.

## 2026-09-15

- Planning moves on with the repositories already in the workspace instead of asking for them again: when every repository the planner names is already attached the run goes straight to planning, a reply of "none" or "no more repositories" to a repository question settles it for the rest of the run, and every repository question a run asks accepts the same answer format.
- When planning asks for a repository the run cannot use, the question now says so plainly: enable it on the Repositories page and start a new run, name another repository to add, or reply "none" to continue without it, and the run stops if the agent cannot plan without it. A run asks a person about each such repository once, and a "none" posted as a Jira comment settles it.
- A pasted GitHub or GitLab link in the answer picks the repository on that provider: a link to a GitHub repository is never matched to a GitLab repository of the same name, and the person is asked instead.
- A run carries its workflow identity from the moment it is claimed, so the dashboard runs list, the trace header and `runs.get` name the workflow while the run is still in progress.
- `completionPending` on `runs.get`, `runs.result` and `tickets.list_runs` now covers the whole window between a run reaching success and its cost, phases and pull requests being recorded, so an integration polling through MCP waits for the pull request data instead of reading a finished run that reports none.
- A finished run now says whether its cost, phases and pull requests have been recorded yet: `runs.get`, `runs.result` and `tickets.list_runs` carry `completionPending`, `runs.result` waits for that data before reporting success and tells the caller when to poll again, `runs.diagnose` names the state, and the trace header in the dashboard labels the duration while the data is still pending.
- `runs.cancel` on a run that has already finished answers `already_terminal` and frees its ticket for the next run, so an integration can clean up after a finished run through MCP without waiting for the scheduled sweep.
- Right after a run finishes, `runs.cancel` answers with a retryable conflict for a short moment while the run wraps up, and a retry with the same idempotency key completes the call.
- When a finished run's ticket or claim cannot be cleaned up yet, `runs.cancel` answers with a retryable conflict that says the run has finished and nothing was changed, instead of reporting a run that is done as still live.

## 2026-09-14

- Run capacity limits now apply no matter how a run starts: from the dashboard, a trigger, or an MCP tool.
- The dashboard, API and MCP now show why a repository suggestion could not complete.

## 2026-09-13

- Run capacity, timeouts, block limits and other operational settings now live entirely on the dashboard Settings page.
- Harness profiles now set their own provider and model, and are validated against that provider before a workflow can use them.
- Repositories can now declare relationships to each other with a fixed set of kinds, and each repository's rules and description can be written and edited from the dashboard, with unknown variables rejected on save.

## 2026-09-12

- The dashboard has a new Settings page for operational controls such as run capacity, timeouts and block limits.
- The dashboard has a new Repositories page: import a repository from your provider, add a description, and see suggested profiles for it.
- New MCP tools cover the repository catalog and settings: list, read and update them the same way the dashboard does.

## 2026-09-09

- A run waiting on a clarification is now cancelled automatically once its ticket no longer exists.
- After an answer, a run gets a limited number of automatic resume attempts, then a clear status explains that a new run is needed.
