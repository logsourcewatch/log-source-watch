# Contributing

Log Source Watch is currently maintained as a source-available commercial product.

## Issues

Use GitHub Issues for:

- reproducible defects
- documentation problems
- feature proposals
- compatibility reports

Do not use public issues for security vulnerabilities.

## Pull requests

1. Create a branch from `main`.
2. Keep changes focused.
3. Run `python scripts/validate.py`.
4. Update documentation and CHANGELOG when behavior changes.
5. Open a pull request.

A pull request does not grant redistribution or commercial rights beyond the repository license terms.

## Coding rules

- keep canonical state values in English
- do not introduce environment-specific secrets or credentials
- do not commit `local/`
- do not commit paid customer licenses
- do not commit license issuer private keys or issuer tooling
- preserve the `index + host` monitored-source identity model
- treat `lsw_inventory` as authoritative policy, `lsw_lastseen` as observations, and `lsw_state` as derived state
