---
name: research
description: Use when researching a question on the web and writing a sourced report.
---

# Research

1. **Plan.** Restate the question in one sentence. Split it into 3 to 6 sub-questions whose answers
   together answer it. Note what would count as a primary source (official docs, the original paper,
   the company's own page, the law or dataset itself).
2. **Search.** For each sub-question, call `web_search` with a short keyword query (`count` up to 20).
   Try two or three phrasings when results are thin. Results come as title, URL and snippet; a
   snippet is not a source.
3. **Read.** Open the most promising results with `web_fetch` and read them. Prefer primary sources
   over summaries, and recent pages over old ones when the answer can change. If a page fails or is
   not text, move on to another.
4. **Cross-check.** Confirm each important claim in at least two independent sources. When sources
   disagree, say so and say which you trust more and why. Note the date of time-sensitive facts.
5. **Write the report.**

## Report format

```markdown
# <Question>

## Summary
<The answer in 3 to 5 sentences.>

## Findings
<One short section per sub-question. Cite each claim inline with [n].>

## Uncertain
<What is unclear, disputed, out of date or not found.>

## Sources
1. <Title> - <URL>
2. ...
```

Number sources in the order they are first cited; every `[n]` must match a URL in the list, and every
listed URL must be one you actually read. Never invent a URL or a quote.

## Search keys

If `web_search` replies that it needs a Brave Search API key: the chief of staff asks the user with
`secret_request` as the reply says; a worker ends its turn with that message as its question, so the
chief of staff can do that.
