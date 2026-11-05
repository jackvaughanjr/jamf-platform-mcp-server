# JPM-0011: Accept Jamf's regeneration of inner payload identifiers as a verified-good scope write

- **Status:** Accepted
- **Date:** 2026-11-05
- **Amends:** the non-scope verification rule for configuration profiles in
  [JPM-0009](JPM-0009-computer-group-scope-membership-tools.md) and
  [JPM-0010](JPM-0010-scope-membership-batch-tool.md), which required the whole non-scope
  fingerprint to be identical after a write. Policies, and every other rule in both
  records, stand.

## Context

JPM-0009 fingerprints every non-scope part of an object before and after a scope-only PUT
and treats any difference as a failure; JPM-0010 stops a batch on the first one.

In the first live rollout, a scope-only PUT to one configuration profile left that
fingerprint different. Reading the object back showed that Jamf Pro had regenerated the
`PayloadUUID` and `PayloadIdentifier` of the inner payload dictionary (the item in the
top-level `PayloadContent` array) and had re-serialised the stored payload plist
(whitespace, key order, the `<plist version>` attribute). Every setting, the top-level
profile payload keys (including the top-level `PayloadUUID` and `PayloadIdentifier`) and
every other `general` field were the same. Jamf did not redistribute the profile. Other
profiles in the same rollout were not affected.

This is Jamf's own normalisation of what it stores, not a change the tool made. But the
verification hashes the whole non-scope object, so `general` differed,
`otherFieldsUnchanged` was false, and the batch stopped. A benign Jamf behaviour would
halt every rollout that touches such a profile, and an operator who sees "non-scope
sections changed" has no way to tell this apart from a real change without reading the
payloads by hand.

## Decision

A semantic comparison, consulted **only when the raw non-scope fingerprint differs and
only for configuration profiles**. The raw fingerprint is still taken first and is still
what the batch `planHash` binds at dry-run time; planHash semantics do not change.
Policies have no payload plist and behave exactly as before.

The object counts as **normalised by Jamf**, and so verified-good, if and only if all of
these hold:

1. Every non-scope section other than `general` is unchanged (the same hash as before).
   Only `general` may be normalised.
2. Before and after `general`, with the `payloads` key removed from both, are deep-equal.
3. Both `payloads` values parse as XML property lists. A parse failure on either side is
   a real change.
4. After removing the `PayloadUUID` and `PayloadIdentifier` keys from every dictionary
   that is a direct element of the top-level `PayloadContent` array, the two parsed values
   are deep-equal: the same count and order of `PayloadContent` items, every other key and
   value identical, and every top-level key identical, the top-level `PayloadUUID` and
   `PayloadIdentifier` included. Dictionary key order is not significant; array order is.
   Types are compared, so `<string>1</string>` and `<integer>1</integer>` differ.

Anything else is a real change and fails exactly as before.

**When normalised:**

- A single tool returns `otherFieldsUnchanged: false` and `differingSections: ['general']`
  as before, plus `normalizedByJamf: { section: 'general', payloadIdentifiersRegenerated:
  <n> }` and `otherFieldsSemanticallyUnchanged: true`. `n` is the number of
  `PayloadContent` items whose `PayloadUUID` or `PayloadIdentifier` changed (0 when Jamf
  only re-serialised).
- The batch marks the object `written`, not `failed`, includes the same two fields, and
  continues with the next object. Its rollback is unchanged.
- Counts only. No `PayloadUUID`, `PayloadIdentifier`, payload text or setting value is ever
  returned or logged.

**Parsing.** An XML parser is used; nothing is evaluated. `fast-xml-parser` is added as a
runtime dependency, pinned exactly (4.5.7, the maintained 4.x line, whose only dependency
is `strnum`). It is configured to skip the DTD and processing instructions, to ignore
attributes, and not to expand entities at all, so an entity a document declares stays
literal text and cannot hide a change or amplify. The five predefined entities and numeric
character references are decoded by this repository's own code, so a re-serialisation that
changes how a character is spelled is not mistaken for a change. A document with an
unreadable structure (unknown element, duplicate key, a key without a value, more than one
root, nesting deeper than 64) fails to parse and is therefore a real change.

## Alternatives considered

### Ignore `general` entirely

Rejected. `general` holds the profile's name, level, redeploy setting, distribution method
and its payloads. A scope write that altered any of them is exactly what the verification
exists to catch. Too broad.

### Strip every `PayloadUUID` everywhere

Rejected. A change to the top-level profile `PayloadUUID` or `PayloadIdentifier` is a change
of the profile's identity on the device, not a regenerated inner identifier. That would be
a real change and must keep failing. Only the identifiers of the direct `PayloadContent`
items are in scope of this rule.

### Keep stopping

Rejected. A benign Jamf behaviour would halt every rollout that touches an affected
profile, and the operator would have to re-verify by hand each time. The stop remains for
everything that is not exactly this.

### Hand-write a plist parser rather than add a dependency

Rejected. A plist is XML, with CDATA, comments, entities and a DTD. A small hand-rolled
reader is the kind of code that fails open on an input nobody thought of; a maintained
parser configured not to expand entities is the safer default for a check whose job is to
say "nothing changed".

## Consequences

### Positive

- A rollout no longer halts on Jamf's own normalisation, and the result says so explicitly
  (count only) instead of reporting a bare failure.
- The normalisation is accepted only when the rest of the object is provably the same;
  the check fails closed on any doubt.

### Negative

- A new runtime dependency on a third-party parser, on a path that reads untrusted-shaped
  text from the tenant. Mitigated by exact pinning, no entity expansion and fail-closed
  handling of every parse error.
- The rule encodes one observed Jamf behaviour. Jamf could normalise something else
  tomorrow; that would still fail, by design, and need a new decision.
- The inner identifier change is invisible to the operator beyond the count: which items
  changed is deliberately not reported.

### Neutral

- Verified against fixtures only. The behaviour was observed live once; this change makes
  no request to Jamf and is unverified live until the next profile that Jamf normalises.

## References

- [JPM-0009](JPM-0009-computer-group-scope-membership-tools.md),
  [JPM-0010](JPM-0010-scope-membership-batch-tool.md)
- `docs/gateway-reference.md`, "Jamf normalises inner payload identifiers on a scope-only
  PUT"
