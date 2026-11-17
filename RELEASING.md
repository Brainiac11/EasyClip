# Releasing EasyClip

## Publishing the repository for the first time

1. Create an empty repository named `EasyClip` on GitHub (no README, no license:
   this repository already has both).
2. Push:

   ```sh
   git remote add origin https://github.com/Brainiac11/EasyClip.git
   git push -u origin main
   ```

3. Check that the **Build** workflow passes under the repository's *Actions* tab.

If the repository ends up under a different account or name, change the URL in
`src/metadata.json`, `packaging/control.in`, `packaging/copyright` and
`README.md` first. The extension's UUID (`easyclip@brainiac11.github.io`) is
its permanent identity: settle it before the first release, because changing
it later makes every existing install look like a different extension.

## Making a release

1. Set the new version in `src/metadata.json`: `version-name` (for example
   `1.1.0`), and add one to `version`.
2. Add a section for it at the top of `CHANGELOG.md`. The heading must be
   `## <version>`; the release notes are taken from that section.
3. Build and try it:

   ```sh
   make dist
   sudo apt install ./build/gnome-shell-extension-easyclip_*_all.deb
   ```

   Log out and back in (a running GNOME Shell keeps the old code loaded), and
   check the popup, pasting, and the settings window.
4. Commit, tag and push:

   ```sh
   git commit -am "Release 1.1.0"
   git tag v1.1.0
   git push origin main v1.1.0
   ```

The tag starts the **Build** workflow, which builds the .deb and the zip, runs
`lintian` on the package, checks that the tag matches `version-name`, and
publishes a GitHub release with both files and `SHA256SUMS` attached.

## Submitting to extensions.gnome.org

Optional, and separate from GitHub. It is where most GNOME users look for
extensions, and it gives them one-click install and automatic updates.

1. Sign in at <https://extensions.gnome.org/> and open *Upload*.
2. Upload `build/easyclip@brainiac11.github.io.shell-extension.zip`.
3. A reviewer reads the code before it is listed. The
   [review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
   say what they look for.

## Supporting another GNOME version

`shell-version` in `src/metadata.json` lists the GNOME versions the extension
claims to work on, and the `Depends:` line in `packaging/control.in` holds the
.deb to the same range. Add a version to both only after running the extension
on it.
