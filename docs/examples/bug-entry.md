# Bug Entry Example

Use this only as a formatting and quality example. Do not treat it as a real tracked bug.

### BUG-EXAMPLE Save action succeeds visually but drops the latest note

- Status: `Validated`
- Severity: `High`
- Route: `Backlog`
- First seen: 2026-04-18
- Reported by: QA smoke test
- Environment: Staging mobile app on iPhone 15 simulator, signed-in user
- Affected version or commit: release candidate `v0.9.0-rc2`
- Related requirements: `FR-012`, `NFR-004`
- Suspected area: note editor save flow
- Symptom: The app shows a success banner after save, but the newest note body is not present after reopening the note.
- Expected behavior: Saving a note persists the latest content and reopening the note shows the same text.
- Actual behavior: The latest edit disappears after leaving and reopening the note even though the UI reported success.
- Reproduction steps:
  1. Open an existing note with edit permission.
  2. Change the body text and tap Save.
  3. Navigate back, reopen the same note, and verify the saved content.
- Evidence: screen recording plus device log showing a `200` response with stale payload
- Owning task(s): `DAT-V1-014`
- Blocks: release candidate sign-off
- Validation reference: `TP-006`
- Root cause: the client reused a stale draft object when building the save payload after autosave recovery
- Fix summary: save now reads the current editor state, and the integration path rejects stale payload reuse
- Regression coverage added: unit coverage for payload construction and integration coverage for save then reopen
- Validation evidence: automated integration test passed in CI and manual save-reopen-save smoke test passed in staging
- Deferral or closure notes: none
