# Release v2.22.0

Lane-skill alignment met `get_system_schema` + proactieve test-case-recording (KBT-INI044 / KBT-E110, Spoor 3 Golf 0).

## KBT-F589 — fantoom-transities & foute signaturen weg
- `kanbantic-issue-review`: Feature-reject roept géén niet-bestaande `Review→InProgress` meer aan (issue blijft op Review met fix-tasks; gewenste terugweg [OPEN: KBT-F562/E104]); mislukte deploy géén `InDeployment→Review` (report + escaleer).
- `update_validation_status` → echte signatuur `(linkId, validationStatus)` (review + execute).
- PhaseStatus `ReadyForReview` → `Review`; validatie-lifecycle `Approved→Implemented→Validated` (geen `NotImplemented`).

## KBT-F585 — proactieve test-case-recording
- `kanbantic-issue-execute` Step 6d: verplichte `update_test_case(Passed|Failed|Skipped)` ná elke run — eigenaar van de niet-overridable AllTestsPassed-gate (lost de KBT-F551-faalmodus op).
- "Mandatory calls — quick reference" (v4 §2.10) in de execute-skill.
- `kanbantic-issue-prepare`: verificatie-commando ↔ test-case-koppeling zodat `update_test_case(Passed)` een bewijsuitspraak is.

Onafhankelijk gereviewd (Axon 08) via plugin-PR's #32 + #33. Lockstep-bump marketplace.json / package.json / plugin.json.
