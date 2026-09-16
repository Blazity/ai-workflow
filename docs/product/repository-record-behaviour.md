Status: draft
Last-verified: 2026-09-16

# The repository record: what a person can do, and what happens in every case

Every subject of work (a ticket, a pull request, a webhook delivery) carries one
durable record of which repositories that work touches. Each entry names a
repository, a state, where the decision came from, who made it, when, and in
which run.

This document is the behaviour the code is measured against. The
[plan](../plans/2026-09-15-repository-work-scope.md) says what is being built
and in what order; this says what a person may do and what they get back. Where
the two disagree, this one is about behaviour and wins on behaviour.

A case marked **held** has a guard in the suite. A case marked **open** is known
and not closed yet. A case marked **deferred** is a decision to do it later, not
an oversight. Nothing here may be marked held on a report; only on a test that
fails when the behaviour is broken.

**As of 2026-09-16 the row-by-row pass has covered the seven rules and all four
sections.** It ties each held row to the test that guards it, and it does not
take an executor's report for one. It was worth running: it found two rows
stating the OPPOSITE of the code (A5 and A7), one row understating what a
refusal costs the person (B4), two cases that were done and still marked in
delivery (A3b and A16), and three behaviours with a guard in the suite and no
row at all, of which one is the way back from an exclusion (B4b, B5b and C10).

What a held row still does NOT promise is that the behaviour has been seen in
production. That is the campaign at the end of the plan, and until it has run,
held means guarded by a test, not observed by a person.

## The seven rules every case resolves to

1. **A repeated question is a cost. A fabricated decision is a defect. A run
   that hangs or dies is worse than both.** Whenever a case is ambiguous, pay the
   cost rather than write the defect, and never pay either with the run's life.
2. **Silence is not selection.** Not answering says nothing about anything.
3. **A person decided about a repository only if the question put its name in
   front of them, or they named it themselves.** This governs SUPPRESSION only.
   It never withholds a repository somebody typed.
4. **Every recorded decision is reversible in the same delivery.** "Open a new
   ticket" is not a remedy. If a person can be told a decision is final, there
   must be a way to take it back, and they must be told what it is.
5. **A decision is attributed to whoever actually made it, or to nobody.** An
   answer we cannot attribute writes no entry, and the trail still records that
   an answer arrived.
6. **A remedy we offer has to work when the person does it.** Every sentence
   telling somebody what to write is checked against the channel it will be read
   in. Telling a person to reply into a question that is already closed is worse
   than saying nothing, because they do it, nothing happens, and now they also
   distrust the next thing we tell them. What works today: a full repository path
   written in an ordinary ticket comment is read by the next run, because that
   run reads the ticket with its comments. What does not: any keyword replied
   after the question has been answered.
7. **The agent's instruction channel is not the person's channel.** What the
   system PLACES in the agent's prompts (the questions, the memory file's
   "Human decisions" section) is separate from what the agent READS as ticket
   history (the ticket's comments). A lever for reversing somebody's decision
   may appear in the second and never in the first.

## What a person can do

| They want to | They do it by | Reaches |
|---|---|---|
| Answer a repository question | Commenting on the ticket | The record, before the run wakes |
| Answer a repository question | The dashboard's answer screen | The record, before the run wakes |
| Answer a repository question | `runs_answer_clarification` over MCP | The record, before the run wakes |
| See what was decided and why | Reading the record over MCP or the API | The record, unchanged |
| Add a repository to the work | Editing the record (API or MCP) | The record directly, no run needed |
| Take back an exclusion | Editing the record (API or MCP) | The record directly, no run needed |
| Undecide, so the next run asks again | Removing the entry (API or MCP) | The record directly, no run needed |
| Name a repository without being asked | Writing its full path in a ticket comment | The next run's text scan |

Two things are deliberately NOT available yet: a screen for the record
(deferred to stage 7, and the owner was told), and any way to tell an agent's
edit from a person's once it is written (deferred, and recorded as a gap below).

## A. Answering a repository question

| # | The person | What must happen | Why | Status |
|---|---|---|---|---|
| A1 | Names one repository that is enabled and reachable | Selected, origin person. The question does not come back | They decided, and we can act on it | held |
| A2 | Names several | All of them selected, origin person | Same | held |
| A3 | Names a repository by a bare or partial name we cannot resolve | Nothing recorded, and the person is told to write the full path in a comment, which the next run reads | Spelled out, that name may well resolve, so the remedy is true for them | held |
| A3b | Names a FULL path this deployment does not hold | Nothing recorded, and the person is told we have no repository by that name, to check it, and that somebody with access to the repositories screen can add it | Telling this person to write the path again is a dead end: the next run's matcher will not resolve it either. Offering a remedy that cannot work is the failure rule 6 exists to prevent, and it is worse than saying less | held |
| A4 | Names one repository we resolve and one we do not, in the same sentence | Their words still reach the next reader, and they are told which name failed | Withholding the whole answer loses the half that was good, and the run then asks the identical question with nothing said | open |
| A5 | Names a repository that exists but is disabled | Recorded as their decision, exactly as if it were enabled. The run refuses it at start, says why, and that reason rides the next question they see. If somebody enables it later, the run attaches it without asking them again | Rule 3 cuts both ways: what a person typed is never dropped. Being enabled is a deployment fact that can change, and their decision outlives it | held |
| A6 | Names a repository that is enabled but the run cannot fetch (renamed, archived, empty default branch) | The selection is honoured as their decision AND the question is not suppressed, because a suppression here strands the work forever | The rule "do not ask somebody who already chose" must read reachability, or the person never gets asked again and nothing is ever attached | held |
| A7 | Refuses and names the subject ("none", "none of these", "żaden") | Every repository the question NAMED is recorded as their decision to leave it out. A repository the question counted but never spelled out is recorded as nothing. The question does not come back | They declined the names they saw, and only those | held |
| A8 | Refuses without naming the subject ("no", "nie", "skip it") in a ticket comment | Nothing recorded. The clarification stays answered, the ticket transition is untouched, the run continues, and the person is told what to write | Nothing threads a ticket comment to our question, so the same word may have been answering the comment above ours | held |
| A9 | The same words on the dashboard or over MCP | Recorded as a decline, exactly as before | There the question is on the screen in front of them, so a bare "no" answers it and nothing else | held |
| A10 | Answers with no words at all ("...", a thumbs up) on the ticket | Nothing is dropped, because a ticket comment always carries its author's name in front of it, so the text is never wordless. The person is told their answer recorded nothing | A reaction is not a sentence, and a thumbs up usually means approval, so silence about it is the worst outcome | held, but its premise is unguarded: no test pins the author prefix on a single comment, so a tidy-up that drops it would turn this row into A10b in production without a red line |
| A10b | The same on the dashboard or over MCP, where the raw reaction is stored | The run proceeds WITHOUT the repositories the question asked about, and the person is told exactly that before anything else | There the emoji is the whole answer, the run acts on it, and the person has no way of knowing that from the screen | held |
| A11 | Writes prose we cannot read | Nothing recorded, the person is told, the question returns | Better asked twice than recorded wrongly | held |
| A12 | Two people answer, and both comments arrive in one delivery | No entry is written, the trail records that an answer arrived, and the people are told | We cannot sign one decision with two names, and picking one of them is a fabrication | held |
| A13 | An automation rule comments under a person's name | Treated as that person, and it is a known limit | The payload says a person wrote it, and we have no evidence to the contrary | open, documented in code |
| A14 | Answers after the run has already died | The record keeps the answer, and the NEXT run reads the record rather than the sentence | This is the defect the record exists to end: a run that dies seconds after an answer used to lose it | held |
| A15 | Answers a question that listed no repository | Naming a path is recorded. Refusing records nothing, and the words offered back are paths, never "none of these", which would mean nothing | Never send a person to a vocabulary the question in front of them did not offer | held |
| A16 | Answers a question that asked them to narrow a set whose size they were told and whose names they were not shown | What they named is the whole answer for that subject, nothing is written about a name they never saw, and the question does not come back | They decided the scope. Twelve decisions about twelve repositories would be eleven fabrications | held |
| A16b | The same person would like to see the names before narrowing | They do not, this round. The question says how many there are and asks which are essential | The names a question prints decide what a later "none" binds, so printing them is a change to what answers MEAN, and it is not being made in the same change as the loop fix | deferred, deliberate |
| A16c | They narrowed to three, and by the next run all three are gone (renamed, archived, outside the workflow's pin) | A question, not a failed run, and it says first that what was chosen is not available to this run, naming up to five of them. Only then the plain question | Their three vanishing is new information and worth asking about, but a bare "which repository?" after somebody narrowed is the founding complaint wearing a different name. A run that dies over a repository renamed yesterday is worse than both | held |
| A17 | Splits one answer across a blank line | Read as one answer. A part that names the subject settles the whole | The parts are one person's sentence, and the naming half is the strongest evidence in it | held |

## B. Changing the record directly

Two things about how this is built, both read in the source rather than taken
from a report, because they are what keep the rows below from being three
separate answers to the same question. The authenticated route, the MCP tool and
the read all go through one service (`services/work-scope`), so there is one
decision table and not one per surface. And the write is a single
data-modifying statement that moves the version and the entries together, with
the version row locked before any entry is touched, because production runs on
a driver that cannot open an interactive transaction while the test driver can,
which is the classic way a concurrency bug passes every unit test and appears
only in production.

| # | The person | What must happen | Status |
|---|---|---|---|
| B1 | Reads the record for a subject that has one | The entries, with state, origin, who and when | held |
| B2 | Reads for a subject that has no record | An answer saying so, with an empty record, not an error | held |
| B3 | Selects a repository | Written as their decision. The next run uses it | held |
| B4 | Selects a repository that is not enabled | Refused, naming the repository, and the WHOLE edit is refused with nothing written. A person asking for three repositories of which one is not enabled gets none of them rather than two and a surprise | held |
| B4b | Selects any repository while the catalog has not been activated | Nothing is refused for that reason. While the catalog is the bridge every repository counts as enabled, which is how the deployment behaves today | held |
| B5 | Excludes a repository | Written, and it sticks: the next run will not put it back | held |
| B5b | Takes back an exclusion by selecting the repository again | The entry becomes their selection, carrying the rationale they give now, and the next run uses it. This is the way back from any exclusion, and it takes no new ticket | held |
| B6 | Removes an entry | The next run decides that repository again from scratch | held |
| B7 | Two people edit the same subject at once | The second is told it conflicted, and nothing is silently overwritten | held |
| B8 | Edits a subject that carries no record | Told that this subject carries no record, rather than one being created behind them | held |
| B9 | An agent edits through MCP | Today it is indistinguishable from a person downstream, so an agent can silence a question a person would have been asked | deferred, named gap |

## C. What the run does with the record

| # | Situation | What must happen | Status |
|---|---|---|---|
| C1 | A fresh ticket with no record | Ask, and record the ask, so the answer is adjudicated | held |
| C2 | The record already carries a person's reachable selection | Do not ask again | held |
| C3 | The record carries a person's selection we cannot reach | Ask, and say why | held |
| C4 | Exclusions leave nothing to work on | Halt, say what was left out and why, and say the exclusion can be taken back and how | held |
| C5 | Exclusions leave nothing, but the run continues rather than halting | The question carries the same reasons. A bare "which repository?" after somebody's own exclusion is the founding complaint of this feature | held |
| C6 | More than eight repositories were left out | Say how many more and where to see them, rather than cutting the list in silence | held |
| C7 | A run suspended across the deploy of this feature | Takes the whole old path, decides nothing new, and does not diverge on replay | held |
| C8 | The subject is a webhook delivery with no ticket | No record, and no question | deferred |
| C9 | A schedule occurrence with no subject | No record | held |
| C10 | The run FINISHES, having left a repository out | The run's comment on the ticket lists it as left out with the same sentence a halt would have used, says once what the reader can do about it, and says how many more it did not list. This is the only surface that reaches a person on a run that did not halt | held |

## D. What the agent is allowed to see

| # | Channel | Carries | Status |
|---|---|---|---|
| D1 | The research, implementation and review prompts | The questions and the answers, including what was left out and why | held |
| D2 | The run's memory file, under "Human decisions" and "do not edit or remove" | The questions and the answers. Never a sentence about reversing somebody's decision | held |
| D3 | The ticket's comments, rendered verbatim into the research prompt on the NEXT run | Whatever anybody wrote on the ticket, our own comments included | held |
| D4 | The reversal sentence | May appear in D3, because that is ticket history a person could have written. Never in D1 or D2, because those are instructions the system signs | held |

The distinction in D4 is the one that cost us a wrong ruling: the halt text was
believed to be the person's channel, and it is not, because the same string is
prefixed onto the first question. The failure path already posts the sentence to
the ticket, so withholding it from a person on any other path protects nothing
and only tells that person less.

## What is deliberately not decided here

- **The screen.** The record is editable through the API and MCP. A panel is
  stage 7.
- **An agent's edit versus a person's.** Closing this needs a durable marker in
  the contract and in the database, which is not a change to make days before a
  merge. Until then, an agent holding the edit tool can write what reads as a
  person's decision.
- **A webhook subject with no ticket.** It carries no record today.

## How this document is kept honest

Every row is a claim about behaviour, so every row that says **held** has a test
that fails when that row stops being true. A row that cannot be expressed as a
test is a row that is not understood yet, and it stays **open** until it is.
Marking a row held from a report, rather than from a failing test, is the one
thing that makes this document worse than not having it.
