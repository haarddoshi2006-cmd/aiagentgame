# Example: multiple agents submitting Git commits

This folder shows how **distinct AI teammates** can leave **distinct fingerprints** in history: different **authors**, **commit message style**, and **touched paths**—similar to your acceptance criterion (“visibly different commits” across persona loadouts).

## What the demo does

`demo.sh` creates a throwaway Git repository under `./_demo_repo/`, then records a short **feature slice** as if three personas collaborated:

| Order | Persona (from seed library) | Role | What they “commit” |
| --- | --- | --- | --- |
| 1 | Sam Okonkwo | frontend | Strict TS types for checkout form |
| 2 | Priya Nair | backend | API route + validation |
| 3 | Riley Kim | scrum_master | Stand-up notes (Markdown), no application code |

Commit **author metadata** is set per step (`user.name` / `user.email` for that commit only), so `git log` reads like a real multi-author branch.

## Run it

From this directory:

```bash
chmod +x demo.sh
./demo.sh
cd _demo_repo
git log --oneline --decorate
git log --format=fuller
```

To remove the sample repo:

```bash
rm -rf _demo_repo
```

## Sample `git log --oneline` (illustrative)

After running the script you should see three commits with different authors, for example:

```
abc1234 docs: stand-up — checkout slice unblocked (Riley)
def5678 feat(api): validate checkout payload (Priya)
fed9876 refactor(ui): narrow CheckoutForm props (Sam)
```

(Exact hashes and messages match whatever `demo.sh` writes.)

## Mapping to GitHub

Nothing here talks to the network. To mirror this on **GitHub**:

1. Create a repository (or use a branch dedicated to simulation).
2. Add each bot or service account as a **collaborator**, **or** use one account and rely on **`git commit --author`** / env vars so history still shows separate authors (GitHub displays commit author when email is linked or when using verified noreply patterns).
3. **Push** the demo branch: `git push origin feature/checkout-slice`.

For automation, CI or a worker process runs the same pattern: **checkout → write files → commit with persona-specific author env**.

## Limitations (be explicit in your product)

- **Author spoofing**: anyone can set `--author`; trust comes from **signing**, **branch protection**, and **which keys** may push.
- **GitHub identity**: the author email should match a **GitHub user** (or org bot) if you want avatars on commits.

## Related repo artifacts

- Persona definitions: `personas/*.json` (when present in your tree).
- Schema: `schemas/agent.schema.json`.
