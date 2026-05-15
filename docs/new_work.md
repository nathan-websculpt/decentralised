## New Tests

Run New Tests from Linux
```bash
./tools/linux/test.sh --test-filter chainIntegritySmoke
```

Run New Tests from Windows
```powershell
.\tools\windows\test.ps1 -TestFilter "chainIntegritySmoke"
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