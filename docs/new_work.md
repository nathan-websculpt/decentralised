## New Tests

### Chain Integrity

Test from Linux
```bash
./tools/linux/test.sh --test-filter chainIntegritySmoke
```

Test from Windows
```powershell
.\tools\windows\test.ps1 -TestFilter "chainIntegritySmoke"
```

Run new linux script
```bash
chmod +x tools/linux/chain-integrity-smoke.sh
./tools/linux/chain-integrity-smoke.sh
```

Then test the aggregate lane without npm audit
```bash
./tools/linux/security-smoke.sh --skip-audit
```

```text
Accepts a valid signed genesis block.
Accepts a valid signed append block.
Rejects a mutated currentHash.
Rejects a mutated voteHash, even if currentHash is recomputed.
Rejects a broken previousHash chain link.
Rejects non-sequential / reordered block indexes.
Detects sync gaps when a future block arrives after the local head.
Detects fork/conflict cases: same index, different hash.
Ignores exact duplicate blocks instead of appending twice.
Rejects timestamps older than the previous block.
Rejects timestamps too far in the future.
Rejects bad signatures.
Rejects malformed hash/signature formats.
Rejects unsupported actionType values and overlong actionLabel values.
```

### Local Sync

Test from Linux

```bash
./tools/linux/test.sh --test-filter localSyncSmoke
```

Test from windows

```powershell
.\tools\windows\test.ps1 -TestFilter "localSyncSmoke"
```

Run Linux script

```bash
chmod +x tools/linux/local-sync-smoke.sh
./tools/linux/local-sync-smoke.sh
```

Test the Aggregate Lane Without npm Audit

```bash
./tools/linux/security-smoke.sh --skip-audit
```

```text
Simulates local peers with different chain states.
Tests an empty peer syncing from lastIndex: -1.
Tests a partially synced peer requesting only missing blocks after lastIndex: 0.
Verifies request-sync and sync-response message behavior.
Verifies peers converge to the same chain head after sync.
Handles out-of-order sync-response blocks deterministically.
Ensures duplicate blocks are not appended twice.
Detects missing-history gaps and treats them as resync conditions.
Detects same-index/different-hash fork conflicts.
Rejects corrupt block material delivered through sync.
Ignores malformed message payloads without crashing.
Confirms invalid messages do not mutate local chain state.
```