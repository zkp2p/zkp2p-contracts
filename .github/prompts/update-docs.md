# Update CLAUDE.md for zkp2p-v2-contracts

You are updating the CLAUDE.md file for a Solidity smart contracts repository that uses Foundry and Hardhat. This is a ZKP2P v2 protocol for trustless peer-to-peer fiat-to-crypto exchanges.

## Steps

1. **Read the current CLAUDE.md** at the repo root.

2. **Analyze recent changes** by reviewing git commits since the last CLAUDE.md modification:
   - Run `git log --oneline --since="$(git log -1 --format=%ci CLAUDE.md 2>/dev/null || echo '30 days ago')" -- . ':!CLAUDE.md'` to see recent commits.
   - Focus on changes to: `contracts/`, `test/`, `test-foundry/`, `deploy/`, `hardhat.config.ts`, `foundry.toml`, `package.json`, and `deployments/`.

3. **Identify what needs updating** in CLAUDE.md:
   - New Solidity contracts or modules added
   - Changed contract interfaces or function signatures
   - New or modified deploy scripts
   - Updated test commands, build steps, or Foundry/Hardhat configuration
   - New registries, verifiers, or protocol components
   - Updated network deployments or addresses
   - New utility functions or testing patterns

4. **Update CLAUDE.md** to reflect the current state:
   - Keep the file under 200 lines (token-efficient for AI context)
   - Maintain the existing structure and section ordering
   - Update build/test commands if package.json scripts changed
   - Update architecture diagrams if contract relationships changed
   - Update code organization if directory structure changed
   - Add new patterns or conventions discovered in recent commits

## Rules

- ONLY modify CLAUDE.md - do NOT touch any code files
- Do NOT add information you cannot verify from the codebase
- Do NOT remove sections that are still accurate
- Preserve the existing markdown formatting style
- If nothing meaningful has changed, make no edits
