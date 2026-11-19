# Publishing

## GitHub Releases

The `Test, package and release` workflow tests both supported Python versions.
Pushes to `main` and pull requests build a downloadable VSIX artifact.
A pushed version tag also publishes a GitHub Release containing the VSIX,
its SHA-256 checksum and notes from `CHANGELOG.md` after all tests pass.

To release a new version:

1. Update `version` in `package.json` and the lockfile (`npm install --package-lock-only`).
2. Add that version to `CHANGELOG.md` and commit the changes.
3. Push the commit, then push the matching tag, for example `v0.1.2`.

```sh
git push origin main
git tag -a v0.1.2 -m 'Release v0.1.2'
git push origin v0.1.2
```

The tag must exactly match `v` plus the package version.

## Visual Studio Marketplace: one-time setup

The repository includes an OIDC publishing workflow but it remains disabled until
the `MARKETPLACE_PUBLISHER` repository variable is set. No PAT is required.
The extension is not listed in Marketplace until this setup and the first publish succeed.

1. Sign in with a Microsoft account at <https://marketplace.visualstudio.com/manage>.
2. Create a publisher and choose a permanent publisher ID.
3. Confirm that `package.json` uses your publisher ID (currently `Toximiner`).
4. In the publisher management page, choose **Trusted Publishing → Create**:

   | Field | Value |
   | --- | --- |
   | Policy name | `GitHub release publishing` |
   | Repository owner | `Toximiner` |
   | Repository | `python-statement-coverage` |
   | Workflow | `publish-marketplace.yml` |
   | Environment | leave empty |

5. In GitHub **Settings → Secrets and variables → Actions → Variables**, add
   `MARKETPLACE_PUBLISHER` with the publisher ID. It is a variable, not a secret.
6. In **Actions → Publish to Visual Studio Marketplace**, choose **Run workflow**
   on `main` for the first publication. Later, pushing a matching version tag publishes automatically.

After publication, the extension can be found in VS Code's Extensions view by name,
or installed with:

```sh
code --install-extension YOUR_PUBLISHER_ID.python-statement-coverage
```

The local `local-tools.python-statement-coverage` installation is a different extension
identity. Disable or uninstall it after installing the Marketplace version to avoid
overlapping highlights.

If the same version is already published, increase the package version before publishing again.
When enabling a new publisher, verify the listing before announcing a Marketplace install link.

Official documentation: <https://code.visualstudio.com/api/working-with-extensions/publishing-extension>.
