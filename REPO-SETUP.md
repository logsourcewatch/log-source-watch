# Public repository setup

## Create the empty GitHub repository

Use:

- **Owner:** `logsourcewatch`
- **Repository name:** `log-source-watch`
- **Description:** `Log source availability and silence monitoring for Splunk Enterprise — inventory, per-source thresholds, maintenance, lifecycle and audit.`
- **Visibility:** **Private initially**
- **Add README:** Off
- **Add .gitignore:** No .gitignore
- **Add license:** No license

The repository is intentionally empty because this bootstrap already contains the canonical README, `.gitignore`, and custom `LICENSE.txt`.

After RC/AppInspect acceptance, change the repository visibility to **Public**.

## First push from Windows

Extract this bootstrap ZIP to a clean directory, open PowerShell there, then:

```powershell
gh auth status
.\BOOTSTRAP-NEW-REPO.ps1
```

Manual equivalent:

```powershell
git init -b main
git add .
git commit -m "Initial public release candidate: Log Source Watch 4.9.3 RC2"
git remote add origin https://github.com/logsourcewatch/log-source-watch.git
git push -u origin main
```

## Recommended GitHub settings after first push

### General

- Default branch: `main`
- Issues: enabled
- Discussions: optional
- Wiki: disabled unless you plan to maintain it
- Releases: enabled

### Ruleset for `main`

Create a branch ruleset:

- target branch: `main`
- block force pushes
- block deletions
- require status checks before update
- required check: `Validate public app`
- require linear history
- require pull request before merging if you want all changes reviewed through PRs

If you are the only maintainer, do **not** require an approving review yet, otherwise you can block your own merges.

### Tag rules

Protect tags matching:

```text
v*
```

At minimum block deletion/rewrites of published release tags.

## Release model

Development:

```text
feature/... -> PR -> main
```

Release candidate:

```powershell
git tag -a v4.9.3-rc2 -m "Log Source Watch 4.9.3 RC2"
git push origin v4.9.3-rc2
```

The Release workflow validates the repo, builds the TGZ, creates SHA256, and creates a GitHub **pre-release**.

GA:

```powershell
git tag -a v4.9.3 -m "Log Source Watch 4.9.3"
git push origin v4.9.3
```

The same workflow creates the normal GitHub Release.

Only create the GA tag after runtime tests and Splunk AppInspect pass against the exact candidate content.

## Never commit

- `issuer_key.json`
- License Issuer tool
- `Issued Licenses/`
- `licenses.csv`
- customer `lsw_license.json`
- customer data
- credentials
- `$SPLUNK_HOME/etc/apps/logsource_watch/local/`
